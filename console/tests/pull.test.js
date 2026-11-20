import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// No ssh, no rsync: every remote call is faked. Each ledger copy is recorded.
const calls = [];
let status = { reachable: true, leadActive: true, session: 'S1' };

vi.mock('node:child_process', () => ({
  spawn: () => {
    const p = new EventEmitter();
    p.stdout = { pipe: () => {} };
    p.stdin = { on: () => {} };
    p.kill = () => {};
    setImmediate(() => p.emit('close', 0));
    return p;
  }
}));
vi.mock('../src/lib/server/ssh.js', () => ({
  sshArgs: () => ({ args: [], dest: 'x' }),
  q: (s) => s,
  pull: async (project, paths) => {
    calls.push({ at: Date.now(), paths });
    return { code: 0, stderr: '' };
  }
}));
vi.mock('../src/lib/server/live.js', () => ({
  getStatus: async () => status,
  peekStatus: () => status,
  UUID_RE: /^[0-9a-f-]{36}$/
}));
vi.mock('../src/lib/server/config.js', () => ({ listProjects: () => [] }));
vi.mock('../src/lib/server/feedback.js', () => ({ syncOutbox: async () => {} }));
vi.mock('../src/lib/server/publish.js', () => ({ syncRequest: async () => {}, maybePublish: () => null }));

const { touch, refresh, ledgerPulledAt } = await import('../src/lib/server/pull.js');

const ledgerCopies = () => calls.filter((c) => c.paths.some((p) => p.endsWith('/ledger/cycles.jsonl'))).length;
const settle = () => new Promise((r) => setTimeout(r, 20));

function project(id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-pull-'));
  return { id, kit: { state: '/var/lib/agent-kit', agentHome: '/home/agent', bare: '/b' }, paths: { fleet: root, transcripts: path.join(root, 't') } };
}

describe('pull: a cycle that ends', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('copies the ledger as soon as the lead is seen to have stopped', async () => {
    const p = project('end');
    status = { reachable: true, leadActive: true, session: 'S1' };
    await refresh(p); // first full pass, cycle running
    expect(ledgerCopies()).toBe(1);
    const first = ledgerPulledAt('end');
    expect(first).toBeTypeOf('number');

    touch(p, status); // still running: nothing new (slow pass is not due)
    await settle();
    expect(ledgerCopies()).toBe(1);

    status = { reachable: true, leadActive: false, session: null };
    touch(p, status); // ended: pull now, not in 15 minutes
    await settle();
    expect(ledgerCopies()).toBe(2);
    expect(ledgerPulledAt('end')).toBeGreaterThanOrEqual(first);

    touch(p, status); // only once per end
    await settle();
    expect(ledgerCopies()).toBe(2);
  });

  it('runs another pass when the cycle ends during one', async () => {
    const p = project('during');
    status = { reachable: true, leadActive: true, session: 'S2' };
    await refresh(p);
    const running = refresh(p); // a pass in flight that began while the lead ran
    status = { reachable: true, leadActive: false, session: null };
    touch(p, status);
    await running;
    await settle();
    expect(ledgerCopies()).toBe(3);
  });

  it('ignores a status it could not read', async () => {
    const p = project('down');
    status = { reachable: true, leadActive: true, session: 'S3' };
    await refresh(p);
    touch(p, { reachable: null, state: 'checking', leadActive: false });
    await settle();
    expect(ledgerCopies()).toBe(1);
  });
});
