import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Focus mode (#93, kit 0.27).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-focus-'));
process.env.CONSOLE_DATA_DIR = root;
process.env.CONSOLE_CONFIG_DIR = root;
const fleet = (id) => {
  const d = path.join(root, 'fleet', id);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
fs.writeFileSync(
  path.join(root, 'projects.json'),
  JSON.stringify({
    projects: ['alpha', 'beta', 'gamma'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), ssh: { alias: `${id}.invalid` }, paths: { fleet: fleet(id) } }))
  })
);

const calls = [];
let refuse = new Set(); // "<project> <sub>" the kit refuses
const statuses = {};
vi.mock('../src/lib/server/ssh.js', async (orig) => ({
  ...(await orig()),
  kit: vi.fn(async (project, script, argv) => {
    calls.push([project.id, script, ...argv]);
    return refuse.has(`${project.id} ${argv[0]}`) ? { code: 2, stdout: '', stderr: `agent-kit-focus: no ${argv[0]} here` } : { code: 0, stdout: 'ok', stderr: '' };
  })
}));
vi.mock('../src/lib/server/live.js', async (orig) => {
  const real = await orig();
  return { ...real, getStatus: vi.fn(async (p) => statuses[p.id]), peekStatus: vi.fn((id) => statuses[id]), invalidateStatus: vi.fn() };
});

const { focusOf } = await import('../src/lib/server/live.js');
const focus = await import('../src/lib/server/focus.js');
const { getProject } = await import('../src/lib/server/config.js');

const up = (o = {}) => ({ reachable: true, state: 'idle', kitVersion: '0.27.0', focus: { on: null, paused: null, ended: null }, ...o });
const user = { name: 'owner' };

beforeEach(() => {
  calls.length = 0;
  refuse = new Set();
  statuses.alpha = up();
  statuses.beta = up();
  statuses.gamma = up();
  focus._resetReconcile();
});

describe('what the VM says about focus', () => {
  it('reads focus, pause and how the last one ended; keeps only what it knows', () => {
    expect(focusOf('{"focus":{"since":1795400000,"until":null,"cycles":4,"perDay":12,"done":1},"paused":null,"ended":null}').on).toEqual({ since: 1795400000, until: null, cycles: 4, perDay: 12, done: 1, hold: null });
    expect(focusOf('{"focus":null,"paused":{"since":1,"until":1795400000,"for":"alpha"},"ended":{"at":1795300000,"reason":"its time has come<script>"}}')).toMatchObject({
      on: null,
      paused: { until: 1795400000, for: 'alpha' },
      ended: { at: 1795300000, reason: 'its time has comescript' }
    });
    expect(focusOf('{"paused":{"until":1795400000,"for":"../x"}}').paused).toBeNull();
    // A planned job goes first (kit 0.28).
    expect(focusOf('{"focus":{"since":1,"perDay":6},"hold":{"id":"20261123T223454Z-o-4fabf3","at":1795489200}}').on.hold).toEqual({ id: '20261123T223454Z-o-4fabf3', at: 1795489200, kind: 'job' });
    expect(focusOf('{"focus":{"since":1,"perDay":6},"hold":{"id":"x; rm","at":1795489200}}').on.hold).toBeNull();
    expect(focusOf('')).toBeNull();
  });
});

describe('focus arguments', () => {
  const now = 1_795_000_000;
  it('take one end and the cycles a day', () => {
    expect(focus.focusArgs({ mode: 'until', until: now + 3600, perDay: 12 }, now)).toEqual(['set', '--until', String(now + 3600), '--per-day', '12']);
    expect(focus.focusArgs({ mode: 'cycles', cycles: 5, perDay: 12 }, now)).toEqual(['set', '--cycles', '5', '--per-day', '12']);
    expect(focus.focusArgs({ mode: 'open', perDay: 3 }, now)).toEqual(['set', '--open', '--per-day', '3']);
  });
  it('refuse what is out of range', () => {
    expect(() => focus.focusArgs({ mode: 'until', until: now - 10, perDay: 12 }, now)).toThrow(/between a minute and 31 days/);
    expect(() => focus.focusArgs({ mode: 'cycles', cycles: 0, perDay: 12 }, now)).toThrow(/Cycles: 1 to 500/);
    expect(() => focus.focusArgs({ mode: 'open', perDay: 0 }, now)).toThrow(/Cycles a day/);
    expect(() => focus.focusArgs({ mode: 'soon', perDay: 3 }, now)).toThrow(/Say when the focus ends/);
  });
});

describe('the estimate', () => {
  it('counts cycles back to back, their cost and the five-hour windows', () => {
    const typical = { secs: 2700, costUsd: 4, n: 10 }; // 45 min + 15 between: 24 a day back to back
    const e = focus.focusEstimate({ mode: 'until', until: 1_795_000_000 + 2 * 86_400, perDay: 12 }, typical, 1_795_000_000);
    expect(e).toMatchObject({ cycles: 24, costUsd: 96, windows: 5, limitedByLength: false });
    expect(focus.focusEstimate({ mode: 'open', perDay: 100 }, typical).limitedByLength).toBe(true);
    expect(focus.focusEstimate({ mode: 'cycles', cycles: 3, perDay: 6 }, null)).toMatchObject({ cycles: 3, costUsd: null, hours: 3 });
  });
});

describe('starting and stopping a focus', () => {
  it('sets the focus, then pauses the others until its end', async () => {
    const until = Math.round(Date.now() / 1000) + 7200;
    const out = await focus.startFocus(user, getProject('alpha'), { mode: 'until', until, perDay: 12, pauseOthers: true });
    expect(calls).toEqual([
      ['alpha', 'agent-kit-focus', 'set', '--until', String(until), '--per-day', '12'],
      ['beta', 'agent-kit-focus', 'pause', '--until', String(until), '--for', 'alpha'],
      ['gamma', 'agent-kit-focus', 'pause', '--until', String(until), '--for', 'alpha']
    ]);
    expect(out.paused).toEqual(['Beta', 'Gamma']);
  });

  it('pauses open-ended for a focus by cycles, and says which team it could not pause', async () => {
    statuses.gamma = up({ kitVersion: '0.26.0' });
    const out = await focus.startFocus(user, getProject('alpha'), { mode: 'cycles', cycles: 4, perDay: 12, pauseOthers: true });
    expect(calls[1]).toEqual(['beta', 'agent-kit-focus', 'pause', '--open', '--for', 'alpha']);
    expect(out.notPaused).toEqual([{ name: 'Gamma', why: 'kit 0.26.0, needs 0.27.0' }]);
    expect(out.detail).toMatch(/Not paused: Gamma/);
  });

  it('keeps the others as they are unless asked', async () => {
    await focus.startFocus(user, getProject('alpha'), { mode: 'open', perDay: 6, pauseOthers: false });
    expect(calls).toHaveLength(1);
  });

  it('one focus at a time, and only on kit 0.27', async () => {
    statuses.beta = up({ focus: { on: { since: 1, perDay: 6, done: 0 }, paused: null, ended: null } });
    await expect(focus.startFocus(user, getProject('alpha'), { mode: 'open', perDay: 6 })).rejects.toThrow(/Beta is in focus already/);
    statuses.beta = up();
    statuses.alpha = up({ kitVersion: '0.26.0' });
    await expect(focus.startFocus(user, getProject('alpha'), { mode: 'open', perDay: 6 })).rejects.toThrow(/needs kit 0\.27\.0/);
    expect(calls).toHaveLength(0);
  });

  it('passes the VM refusal on and pauses nobody', async () => {
    refuse.add('alpha set');
    await expect(focus.startFocus(user, getProject('alpha'), { mode: 'open', perDay: 6, pauseOthers: true })).rejects.toThrow('no set here');
    expect(calls).toHaveLength(1);
  });

  it('stopping ends the focus and the pauses made for it', async () => {
    statuses.beta = up({ focus: { on: null, paused: { until: 1, for: 'alpha' }, ended: null } });
    const out = await focus.stopFocus(user, getProject('alpha'));
    expect(calls).toEqual([
      ['alpha', 'agent-kit-focus', 'clear', 'owner'],
      ['beta', 'agent-kit-focus', 'unpause']
    ]);
    expect(out.detail).toMatch(/Beta run on their schedules again/);
  });
});

describe('pauses whose focus has ended', () => {
  it('are ended once the focused team says it is not in focus, at most once a minute', async () => {
    statuses.beta = up({ focus: { on: null, paused: { until: 1, for: 'alpha' }, ended: null } });
    statuses.alpha = up({ focus: { on: { since: 1, perDay: 6, done: 0 }, paused: null, ended: null } });
    expect(await focus.reconcileFocus({ now: 1_000_000 })).toEqual([]);
    statuses.alpha = up({ focus: { on: null, paused: null, ended: { at: 2, reason: 'it ran its 4 cycles' } } });
    expect(await focus.reconcileFocus({ now: 1_000_000 + 1000 })).toEqual([]); // within the minute: not looked at
    expect(await focus.reconcileFocus({ now: 1_000_000 + 61_000 })).toEqual(['Beta']);
    expect(calls).toEqual([['beta', 'agent-kit-focus', 'unpause']]);
  });

  it('not while the focused team does not answer', async () => {
    statuses.beta = up({ focus: { on: null, paused: { until: 1, for: 'alpha' }, ended: null } });
    statuses.alpha = { reachable: false, state: 'unreachable' };
    expect(await focus.reconcileFocus({ now: 5_000_000 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('the team in focus, for the bar under the header', () => {
    statuses.gamma = up({ focus: { on: { since: 1, until: 1795400000, perDay: 6, done: 2 }, paused: null, ended: null } });
    expect(focus.focusNow()).toMatchObject({ id: 'gamma', name: 'Gamma', until: 1795400000, done: 2 });
  });
});
