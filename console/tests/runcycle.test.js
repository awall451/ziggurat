import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// "Run a cycle now" (#94, kit 0.25): one normal cycle with no job.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-rc-'));
process.env.CONSOLE_DATA_DIR = root;

const calls = [];
let answer = { code: 0, stdout: 'cycle x started', stderr: '' };
let status = {};
vi.mock('../src/lib/server/ssh.js', async (orig) => ({
  ...(await orig()),
  kit: vi.fn(async (project, script, argv) => {
    calls.push([script, ...argv]);
    return answer;
  })
}));
vi.mock('../src/lib/server/live.js', async (orig) => {
  const real = await orig();
  return { ...real, getStatus: vi.fn(async () => status), invalidateStatus: vi.fn() };
});

const controls = await import('../src/lib/server/controls.js');
const { runCycleState, _test } = await import('../src/lib/server/live.js');
const { typicalCycle } = await import('../src/lib/server/aggregate.js');

const project = { id: 'demo', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'nowhere.invalid' } };
const idle = { reachable: true, state: 'idle', leadActive: false, kitVersion: '0.25.0', cap: 6, today: 2, oneshot: null, haltAfter: null };

describe('when a cycle can be run now', () => {
  it('can on an idle or halted team with kit 0.25, and says if the cap is reached', () => {
    expect(runCycleState(idle)).toMatchObject({ can: true, halted: false, atCap: false });
    expect(runCycleState({ ...idle, state: 'halted' })).toMatchObject({ can: true, halted: true });
    expect(runCycleState({ ...idle, today: 6 })).toMatchObject({ can: true, atCap: true, today: 6, cap: 6 });
  });

  it('says why not', () => {
    expect(runCycleState({ ...idle, leadActive: true, state: 'running' }).why).toBe('A cycle is running');
    expect(runCycleState({ ...idle, oneshot: { id: 'x', plan: false, free: false } }).why).toBe('A one-shot job is running');
    expect(runCycleState({ ...idle, oneshot: { id: 'x', plan: true } }).why).toBe('A planning cycle is running');
    expect(runCycleState({ ...idle, oneshot: { id: 'x', free: true } }).why).toBe('A cycle you started is running');
    expect(runCycleState({ ...idle, haltAfter: { since: 1 } }).why).toMatch(/halt is pending/);
    expect(runCycleState({ ...idle, kitVersion: '0.24.0' }).why).toMatch(/needs kit 0\.25\.0/);
    expect(runCycleState({ reachable: false, state: 'unreachable' }).can).toBe(false);
    expect(runCycleState({ reachable: null, state: 'checking' }).why).toBe('Checking the VM');
  });

  it('reads a cycle the owner started, and one set for a time, from the status', () => {
    const raw = { control: 'run oneshot 20261123T100000Z-f-run-now 2026-11-23T10:00:00+00:00', lead: 'activating', timer: 'enabled', now: '1795139000' };
    expect(_test.shape({ ...raw, oneshot: '20261123T100000Z-f-run-now 2026-11-23T10:00:00+00:00 halt' }).oneshot).toMatchObject({ free: true, plan: false, runsOn: false });
    expect(_test.shape({ ...raw, atjobs: '20261123T100000Z-f-later 1795140000 owner - -' }).atJobs[0]).toMatchObject({ free: true, plan: false });
    expect(_test.shape({ ...raw, today: '3', cap: '6' })).toMatchObject({ today: 3, cap: 6 });
  });
});

describe('what a cycle typically takes', () => {
  it('is the median of the last ten real cycles, planning and chat left out', () => {
    const c = (secs, costUsd, o = {}) => ({ counted: true, halted: false, kind: 'normal', secs, costUsd, ...o });
    const t = typicalCycle([c(600, 1), c(1800, 3), c(1200, 2), c(30, 0.1), c(5000, 9, { kind: 'plan' }), c(4000, 8, { halted: true }), c(9000, 20, { kind: 'chat' })]);
    expect(t).toEqual({ secs: 1200, costUsd: 2, n: 3 });
    expect(typicalCycle([])).toEqual({ secs: null, costUsd: null, n: 0 });
  });
});

describe('run a cycle now', () => {
  beforeEach(() => {
    calls.length = 0;
    answer = { code: 0, stdout: 'cycle x started', stderr: '' };
    status = { ...idle };
  });

  it('asks the kit for one normal cycle with a checked id and sender', async () => {
    const out = await controls.runCycle({ name: 'owner' }, project);
    expect(out).toMatchObject({ ok: true, started: true });
    expect(calls).toHaveLength(1);
    const [script, sub, id, from, ...rest] = calls[0];
    expect([script, sub, from, rest]).toEqual(['agent-kit-oneshot', 'start', 'owner', ['--free']]);
    expect(id).toMatch(/^\d{8}T\d{6}Z-f-run-now$/);
    expect(controls.runCycleArgs(id, { name: 'me; rm -rf /' })[2]).toBe('owner');
    expect(() => controls.runCycleArgs('x; id', null)).toThrow(/Bad cycle id/);
  });

  it('says the team halts again on a halted team', async () => {
    status = { ...idle, state: 'halted' };
    expect((await controls.runCycle({ name: 'owner' }, project)).detail).toMatch(/halts again/);
  });

  it('at the cap only past it, and then says so to the kit', async () => {
    status = { ...idle, today: 6 };
    await expect(controls.runCycle({ name: 'owner' }, project)).rejects.toThrow(/cap is reached \(6\/6\)/);
    expect(calls).toHaveLength(0);
    await controls.runCycle({ name: 'owner' }, project, { pastCap: true });
    expect(calls[0].slice(-2)).toEqual(['--free', '--past-cap']);
  });

  it('does not ask the VM when a cycle runs', async () => {
    status = { ...idle, leadActive: true, state: 'running' };
    await expect(controls.runCycle({ name: 'owner' }, project)).rejects.toThrow('A cycle is running');
    expect(calls).toHaveLength(0);
  });

  it('passes the kit refusal on in plain words', async () => {
    answer = { code: 2, stdout: '', stderr: 'agent-kit-oneshot: a cycle is running. Send an inbox message instead' };
    await expect(controls.runCycle({ name: 'owner' }, project)).rejects.toThrow('A cycle is running. Send an inbox message instead.');
  });

  it('with no clear answer, it looks whether the cycle started all the same', async () => {
    answer = { code: 255, stdout: '', stderr: 'Connection reset' };
    const out = await controls.runCycle({ name: 'owner' }, project);
    expect(out.started).toBe(false);
    expect(out.detail).toMatch(/No clear answer/);
  });
});
