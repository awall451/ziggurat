import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR is read when the modules load, so point it at a temp folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-gh-'));
process.env.CONSOLE_DATA_DIR = root;
const gh = await import('../src/lib/server/gatehold.js');

const fake = path.join(root, 'fakebin');
const project = { id: 'team', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'vm' }, paths: { fleet: path.join(root, 'fleet') } };
const out = path.join(root, 'gatehold', 'team', 'out');
const user = { name: 'owner' };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

beforeAll(() => {
  fs.mkdirSync(fake, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  // `ssh` stub: records the remote command, prints the chosen stdout, exits with the chosen code.
  fs.writeFileSync(
    path.join(fake, 'ssh'),
    `#!/bin/sh\nfor a; do last=$a; done\ncat > /dev/null\necho "$last" >> ${fake}/log\ncat ${fake}/stdout 2>/dev/null\ncat ${fake}/stderr >&2 2>/dev/null\nexit $(cat ${fake}/code 2>/dev/null || echo 0)\n`,
    { mode: 0o755 }
  );
  process.env.PATH = `${fake}:${process.env.PATH}`;
});
const vm = (code, stdout = '', stderr = '') => {
  fs.writeFileSync(path.join(fake, 'code'), String(code));
  fs.writeFileSync(path.join(fake, 'stdout'), stdout);
  fs.writeFileSync(path.join(fake, 'stderr'), stderr);
};
const lastCall = () => fs.readFileSync(path.join(fake, 'log'), 'utf8').trim().split('\n').pop();

describe('kit version', () => {
  it('needs 0.14.0', () => {
    expect(gh.kitHasGateHold('0.14.0')).toBe(true);
    expect(gh.kitHasGateHold('0.13.0')).toBe(false);
  });
});

describe('parseHeld', () => {
  it('keeps checked entries only', () => {
    const text = [
      JSON.stringify({ topic: 'checks-v2', sha: A, at: '2026-01-01T10:00:00+00:00', detail: 'changes what done means (tools/check)\u0007' }),
      JSON.stringify({ topic: 'checks-v2', sha: A }),
      JSON.stringify({ topic: '../etc', sha: B }),
      JSON.stringify({ topic: 'x', sha: 'abc' }),
      'not json',
      JSON.stringify({ topic: 'feature/new-checks', sha: B, at: 'never' })
    ].join('\n');
    const h = gh.parseHeld(text);
    expect(h.map((x) => x.topic)).toEqual(['checks-v2', 'feature/new-checks']);
    expect(h[0].detail).toBe('changes what done means (tools/check) ');
    expect(h[1].at).toBeNull();
  });
});

describe('parseHeld approvedAt', () => {
  it('keeps a valid approval time only', () => {
    const h = gh.parseHeld([JSON.stringify({ topic: 'a', sha: A, approvedAt: '2026-01-01T10:05:00+00:00' }), JSON.stringify({ topic: 'b', sha: B, approvedAt: 'soon' })].join('\n'));
    expect(h[0].approvedAt).toBe('2026-01-01T10:05:00+00:00');
    expect(h[1].approvedAt).toBeNull();
  });
});

describe('remembered decisions', () => {
  const held = (extra = {}) => ({ topic: 'a', sha: A, at: null, detail: '', approvedAt: null, ...extra });
  const now = Date.parse('2026-01-01T12:00:00Z');
  const rec = { decision: 'approve', topic: 'a', at: '2026-01-01T11:55:00.000Z' };
  const noRead = async () => {
    throw new Error('not read');
  };

  it('writes one on success, none on a refusal', async () => {
    vm(0, 'approved');
    await gh.decideHeld(user, project, A, 'approve', 'a');
    expect(gh.readDecisions(project)[A]).toMatchObject({ decision: 'approve', topic: 'a' });
    vm(2, '', 'nothing is held');
    await gh.decideHeld(user, project, B, 'approve', 'b').catch(() => {});
    expect(gh.readDecisions(project)[B]).toBeUndefined();
    fs.rmSync(path.join(root, 'gatehold', 'team', 'decisions.json'));
  });

  it('shows approved from memory while the VM says nothing yet', async () => {
    const r = await gh.reconcile([held()], { [A]: rec }, noRead, now);
    expect(r.items[0]).toMatchObject({ state: 'approved', approvedAt: rec.at });
    expect(r.keep[A]).toBeDefined();
  });

  it('prefers the VM approval time', async () => {
    const r = await gh.reconcile([held({ approvedAt: '2026-01-01T11:50:00+00:00' })], {}, noRead, now);
    expect(r.items[0]).toMatchObject({ state: 'approved', approvedAt: '2026-01-01T11:50:00+00:00' });
  });

  it('is waiting with nothing remembered, declined when a decline is remembered', async () => {
    expect((await gh.reconcile([held()], {}, noRead, now)).items[0].state).toBe('waiting');
    expect((await gh.reconcile([held()], { [A]: { ...rec, decision: 'deny' } }, noRead, now)).items[0].state).toBe('declined');
  });

  it('settles a decision the VM stopped listing, once', async () => {
    const read = async () => JSON.stringify({ sha: A, status: 'rejected', detail: 'main moved during the run; rebase and resubmit', at: '2026-01-01T11:59:00+00:00' });
    const r = await gh.reconcile([], { [A]: rec }, read, now);
    expect(r.settled).toEqual([expect.objectContaining({ topic: 'a', status: 'rejected', detail: expect.stringContaining('main moved') })]);
    expect(r.keep).toEqual({});
  });

  it('settles as gone when the result cannot be read, and drops old memory', async () => {
    expect((await gh.reconcile([], { [A]: rec }, noRead, now)).settled[0].status).toBe('gone');
    const old = { ...rec, at: '2025-12-30T11:55:00.000Z' };
    const r = await gh.reconcile([held()], { [A]: old }, noRead, now);
    expect(r.keep).toEqual({});
    expect(r.items[0].state).toBe('waiting');
  });

  it('ignores a result for another commit', () => {
    expect(gh.parseSettled(JSON.stringify({ sha: B, status: 'merged' }), A)).toBeNull();
    expect(gh.parseSettled('nope', A)).toBeNull();
  });
});

describe('the diff', () => {
  it('is built only from checked shas', () => {
    expect(() => gh.diffScript(['a; rm -rf /'], 'ABCDEF0123456789')).toThrow();
    expect(() => gh.diffScript([A], 'bad marker')).toThrow();
    const s = gh.diffScript([A, B], 'ABCDEF0123456789');
    expect(s).toContain(`for sha in ${A} ${B}; do`);
    expect(s).toContain('main...$sha');
  });

  it('is split by the marker, and diff lines cannot fake one', () => {
    const m = 'ABCDEF0123456789';
    const d = gh.parseDiffs([`@@${m} ${A}`, 'diff --git a/tools/check b/tools/check', `+@@${m} ${B}`, '+echo hi', `@@${m} ${B}`, ''].join('\n'), m);
    expect(Object.keys(d)).toEqual([A, B]);
    expect(d[A].text).toContain('+echo hi');
    expect(d[A].text).toContain(`+@@${m} ${B}`);
    expect(d[B].text).toBe('');
  });
});

describe('the explanation', () => {
  it('is read from the pulled folder and must name the topic', () => {
    fs.writeFileSync(path.join(out, 'checks-v2.md'), `Topic: checks-v2\nSha: ${A}\nDate: 2026-01-01T10:00:00Z\n---\nRuns the new tests.\n`);
    fs.writeFileSync(path.join(out, 'feature_new-checks.md'), `Topic: other\nSha: ${B}\n---\nWrong topic\n`);
    expect(gh.explanation(project, 'checks-v2')).toMatchObject({ sha: A, text: 'Runs the new tests.' });
    expect(gh.explanation(project, 'feature/new-checks')).toBeNull();
    expect(gh.explanation(project, '../x')).toBeNull();
  });

  it('is not read through a link', () => {
    fs.symlinkSync('/etc/hostname', path.join(out, 'linked.md'));
    expect(gh.explanation(project, 'linked')).toBeNull();
  });
});

describe('decideHeld', () => {
  it('sends approve or deny for a full sha only', async () => {
    vm(0, 'approved: ...');
    await expect(gh.decideHeld(user, project, A, 'approve')).resolves.toMatchObject({ ok: true });
    expect(lastCall()).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-gate approve ${A}`);
    await expect(gh.decideHeld(user, project, 'abc', 'approve')).rejects.toThrow('Bad commit');
    await expect(gh.decideHeld(user, project, A, 'merge')).rejects.toThrow('Bad decision');
  });

  it('passes on the VM refusing', async () => {
    vm(2, '', 'agent-kit-gate: nothing is held for the owner at ...');
    await expect(gh.decideHeld(user, project, B, 'deny')).rejects.toThrow('nothing is held');
  });
});
