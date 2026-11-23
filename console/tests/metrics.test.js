import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Synthetic data only. The data folder is set before the modules load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-metrics-'));
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
process.env.CONSOLE_CONFIG_DIR = path.join(root, 'config');

let recordMetrics, readMetrics, weekly, project;
const SID = '11111111-2222-4333-8444-555555555555';
const OLD = '22222222-2222-4333-8444-555555555555';
const line = (o) => JSON.stringify(o) + '\n';

beforeAll(async () => {
  vi.resetModules();
  ({ recordMetrics, readMetrics, weekly } = await import('../src/lib/server/metrics.js'));
  const slug = '-home-agent-demo';
  const dir = path.join(root, 'projects', slug);
  const sub = path.join(dir, SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(root, 'fleet'), { recursive: true });
  project = { id: 'demo', slug, paths: { transcripts: path.join(root, 'projects'), fleet: path.join(root, 'fleet') } };
  const usage = (o, cr, cw) => ({ input_tokens: 0, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
  fs.writeFileSync(
    path.join(dir, `${SID}.jsonl`),
    line({ type: 'user', timestamp: '2026-01-05T10:00:00Z', message: { role: 'user', content: 'You are the lead.' } }) +
      line({ type: 'assistant', timestamp: '2026-01-05T10:00:05Z', message: { id: 'm1', model: 'claude-x', usage: usage(1000, 0, 10_000), content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'area-lead-core', description: 'Redo on Opus: parser' } }] } })
  );
  fs.writeFileSync(path.join(sub, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'area-lead-core', description: 'Redo on Opus: parser', toolUseId: 't1', spawnDepth: 1 }));
  fs.writeFileSync(
    path.join(sub, 'agent-aaa.jsonl'),
    line({ type: 'user', timestamp: '2026-01-05T10:01:00Z', message: { role: 'user', content: 'Fix it.' } }) +
      line({ type: 'assistant', timestamp: '2026-01-05T10:01:10Z', message: { id: 'a1', model: 'claude-x', usage: usage(0, 0, 20_000), content: [] } }) +
      line({ type: 'assistant', timestamp: '2026-01-05T10:20:00Z', message: { id: 'a2', model: 'claude-x', usage: usage(0, 0, 20_500), content: [] } })
  );
  fs.writeFileSync(
    path.join(root, 'fleet', 'cycles.jsonl'),
    line({ session: SID, kind: 'oneshot', oneshot: '20260105T100000Z-o-job', start: '2026-01-05T10:00:00+00:00', end: '2026-01-05T10:30:00+00:00', secs: 1800, rc: 0, cost_usd: 1.5, turns: 4, est_min: 20 }) +
      line({ session: SID, kind: 'chat', chat: '20260105T110000Z-c-abcdef', start: '2026-01-05T11:00:00+00:00', end: '2026-01-05T11:00:10+00:00', secs: 10, rc: 0, cost_usd: 0.2, turns: 1 }) +
      // No transcript, and old: kept from the ledger alone.
      line({ session: OLD, kind: 'normal', start: '2025-12-30T10:00:00+00:00', end: '2025-12-30T11:00:00+00:00', secs: 3600, rc: 0, halted: true, cost_usd: 9, tokens: { in: 1, out: 2, cr: 3, cw: 4, think: 5 } })
  );
  fs.writeFileSync(
    path.join(root, 'fleet', 'history.log'),
    '2026-01-05T10:10:00+00:00 parser abc merged all checks passed (10 tests)\n2026-01-05T10:15:00+00:00 other def failed tests\n2026-01-05T12:00:00+00:00 late abc merged ok\n'
  );
});

describe('recordMetrics', () => {
  it('writes one line per finished run, once', () => {
    const itemForJob = (p, id) => (id === '20260105T100000Z-o-job' ? { minutes: 25, cost: 2 } : null);
    expect(recordMetrics(project, { itemForJob, now: Date.parse('2026-01-06T00:00:00Z') })).toBe(3);
    expect(recordMetrics(project, { itemForJob })).toBe(0);
    const by = Object.fromEntries(readMetrics(project).map((m) => [m.key, m]));
    const job = by[SID];
    // The ledger's own estimate wins over the proposal's minutes; the cost estimate is the proposal's.
    expect(job).toMatchObject({ kind: 'oneshot', outcome: 'done', secs: 1800, estMin: 20, estUsd: 2, ledgerUsd: 1.5, agents: 2 });
    expect(job.tokens).toEqual({ in: 0, out: 1000, cr: 0, cw: 50_500, think: 0 });
    expect(job.rewrite.count).toBe(1);
    expect(job.redo.count).toBe(1);
    expect(job.areaLeads).toEqual([expect.objectContaining({ model: 'claude-x', redo: true })]);
    expect(job.gate).toEqual({ merged: 1, refused: 1 });
    expect(by['chat:20260105T110000Z-c-abcdef']).toMatchObject({ kind: 'chat', ledgerUsd: 0.2, secs: 10 });
    expect(by[OLD]).toMatchObject({ kind: 'normal', outcome: 'halted', ledgerUsd: 9, tokens: { in: 1, out: 2, cr: 3, cw: 4, think: 5 } });
    expect(by[OLD].costUsd).toBeUndefined();
  });

  it('waits for the transcript of a run that only just ended', () => {
    const NEW = '33333333-2222-4333-8444-555555555555';
    fs.appendFileSync(path.join(project.paths.fleet, 'cycles.jsonl'), line({ session: NEW, kind: 'normal', start: '2026-01-06T10:00:00+00:00', end: '2026-01-06T10:30:00+00:00', secs: 1800, rc: 0 }));
    expect(recordMetrics(project, { now: Date.parse('2026-01-06T11:00:00Z') })).toBe(0);
    expect(recordMetrics(project, { now: Date.parse('2026-01-08T11:00:00Z') })).toBe(1);
  });
});

describe('weekly', () => {
  it('groups by week and kind, newest week first, with estimates against what it took', () => {
    const rows = weekly([
      { key: 'a', kind: 'oneshot', start: '2026-01-05T10:00:00Z', secs: 1800, outcome: 'done', estMin: 20, estUsd: 2, costUsd: 3, rewrite: { costUsd: 1 }, redo: { count: 1, costUsd: 0.5 }, gate: { merged: 1, refused: 0 } },
      { key: 'b', kind: 'oneshot', start: '2026-01-07T10:00:00Z', secs: 600, outcome: 'done', estMin: 20, estUsd: 2, costUsd: 1 },
      { key: 'c', kind: 'oneshot', start: '2026-01-08T10:00:00Z', secs: 6000, outcome: 'overrun', estMin: 20, costUsd: 5 },
      { key: 'd', kind: 'normal', start: '2026-01-13T10:00:00Z', secs: 3600, outcome: 'done', ledgerUsd: 9 },
      { key: 'e', kind: 'chat', start: 'not a time' }
    ]);
    expect(rows.map((r) => `${r.week} ${r.kind}`)).toEqual(['2026-01-12 normal', '2026-01-05 oneshot']);
    expect(rows[1]).toMatchObject({ runs: 3, costUsd: 9, medianUsd: 3, medianMin: 30, timeRatio: 0.5, costRatio: 0.5, estimated: 2, rewriteUsd: 1, redo: 1, redoUsd: 0.5, merged: 1, notDone: 1 });
    expect(rows[0]).toMatchObject({ runs: 1, medianUsd: 9, timeRatio: null });
  });
});
