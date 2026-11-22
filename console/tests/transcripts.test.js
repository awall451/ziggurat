import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, sessionTree, leadReport, _test } from '../src/lib/server/transcripts.js';

// Synthetic transcripts in the shape Claude Code writes them. No real data.
const SID = '11111111-2222-4333-8444-555555555555';
const OLD = '99999999-2222-4333-8444-555555555555';
const pricing = {
  cacheWrite5mFactor: 1.25,
  cacheWrite1hFactor: 2,
  models: [{ match: 'haiku', input: 1, output: 5, cacheRead: 0.1 }],
  default: { input: 4, output: 20, cacheRead: 0.2 }
};
const labeler = (agentType, depth) => ({ label: agentType, kind: 'other', rawType: agentType, tier: depth });

const line = (o) => JSON.stringify(o) + '\n';
const user = (text, ts) => ({ type: 'user', timestamp: ts, cwd: '/w', gitBranch: 'main', version: '2.1.0', message: { role: 'user', content: text } });
const asst = (id, model, usage, content, ts) => ({ type: 'assistant', timestamp: ts, gitBranch: 'main', message: { id, model, usage, content } });
const usage = (i, o, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

let project;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-test-'));
  const slug = '-home-agent-demo';
  const dir = path.join(root, 'projects', slug);
  const sub = path.join(dir, SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(root, 'fleet'), { recursive: true });
  project = { id: 'demo', slug, paths: { transcripts: path.join(root, 'projects'), fleet: path.join(root, 'fleet') } };

  fs.writeFileSync(
    path.join(dir, `${SID}.jsonl`),
    line({ type: 'api-request-blob', big: 'x'.repeat(200) }) +
      line(user('You are the lead. Plan the cycle.', '2026-01-01T10:00:00Z')) +
      // Two lines of one message: the later usage replaces the earlier one.
      line(asst('m1', 'claude-lead-1', usage(10, 5, 100, 20), [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], '2026-01-01T10:00:05Z')) +
      line(asst('m1', 'claude-lead-1', usage(10, 50, 100, 20), [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'area-lead-engine', description: 'Engine goal', prompt: 'x' } }], '2026-01-01T10:00:06Z')) +
      line({ type: 'user', timestamp: '2026-01-01T10:00:07Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) +
      'this line is not json\n' +
      '{"type":"assistant","message":{"id":"m2","model":"claude-lead-1","usage"' // half-written last line
  );

  fs.writeFileSync(path.join(sub, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'area-lead-engine', description: 'Engine goal', toolUseId: 't2', spawnDepth: 1, worktreeBranch: 'worktree-agent-aaa', worktreePath: '/w/.claude/worktrees/agent-aaa' }));
  fs.writeFileSync(
    path.join(sub, 'agent-aaa.jsonl'),
    line(user('Build the engine thing.', '2026-01-01T10:01:00Z')) +
      line(asst('a1', 'claude-big-1', usage(5, 100, 2000, 0), [{ type: 'tool_use', id: 'c1', name: 'Agent', input: { subagent_type: 'scout' } }], '2026-01-01T10:02:00Z')) +
      line({ type: 'assistant', timestamp: '2026-01-01T10:03:00Z', gitBranch: 'work/engine', message: { id: 'a2', model: 'claude-big-1', usage: usage(5, 10, 3000, 0), content: [{ type: 'text', text: 'working' }] } })
  );

  fs.writeFileSync(path.join(sub, 'agent-bbb.meta.json'), JSON.stringify({ agentType: 'scout', description: 'Find files', toolUseId: 'c1', parentAgentId: 'aaa', spawnDepth: 2, inheritedWorktreePath: '/w/.claude/worktrees/agent-aaa', finished: true }));
  fs.writeFileSync(
    path.join(sub, 'agent-bbb.jsonl'),
    line(user([{ type: 'text', text: 'Find the files.' }], '2026-01-01T10:02:10Z')) +
      line(asst('b1', 'claude-haiku-1', usage(1_000_000, 0), [{ type: 'tool_use', id: 'g1', name: 'Grep', input: {} }, { type: 'tool_use', id: 'g2', name: 'Grep', input: {} }], '2026-01-01T10:02:20Z')) +
      line(asst('b2', 'claude-haiku-1', usage(0, 1_000_000), [{ type: 'text', text: 'Found three files.' }], '2026-01-01T10:02:30Z'))
  );

  // An older, finished cycle known to the ledger, and a stray session that is not a cycle.
  fs.mkdirSync(path.join(dir, OLD, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, OLD, 'subagents', 'agent-zzz.meta.json'), '{}');
  fs.writeFileSync(path.join(dir, `${OLD}.jsonl`), line(user('lead', '2025-12-31T10:00:00Z')));
  fs.writeFileSync(path.join(dir, 'aaaaaaaa-2222-4333-8444-555555555555.jsonl'), line(user('just a login', '2025-12-30T10:00:00Z')));
  fs.writeFileSync(
    path.join(root, 'fleet', 'cycles.jsonl'),
    line({ start: '2025-12-31T10:00:00+00:00', end: '2025-12-31T11:00:00+00:00', secs: 3600, rc: 0, cost_usd: 12.5, turns: 30, session: OLD, counted: true }) +
      line({ start: '2025-12-31T12:00:00+00:00', rc: 0, limited: true, counted: false, session: null })
  );
  _test.folds.clear();
});

describe('listSessions', () => {
  it('lists cycles newest first and leaves out sessions that are not cycles', () => {
    const rows = listSessions(project);
    expect(rows.map((r) => r.id)).toEqual([SID, OLD]);
    expect(rows[1]).toMatchObject({ state: 'done', number: 1, costUsd: 12.5 });
    expect(rows[0]).toMatchObject({ state: 'interrupted', number: 2, agents: 2 });
  });

  it('shows a cycle that ended after the last ledger pull as ending, not interrupted', () => {
    const ended = fs.statSync(path.join(project.paths.transcripts, project.slug, `${SID}.jsonl`)).mtimeMs;
    // The ledger was copied before the cycle ended: its line may just not be here yet.
    expect(listSessions(project, null, { ledgerAt: ended - 1000 })[0].state).toBe('ending');
    // Copied well after: no line means the cycle really was cut off.
    expect(listSessions(project, null, { ledgerAt: ended + 600_000 })[0].state).toBe('interrupted');
    // A cycle the ledger knows keeps its outcome either way.
    expect(listSessions(project, null, { ledgerAt: ended - 1000 })[1].state).toBe('done');
  });

  it('marks the session in progress as running', () => {
    const rows = listSessions(project, { leadActive: true, session: SID });
    expect(rows[0]).toMatchObject({ live: true, state: 'running' });
  });
});

describe('a planning cycle the owner chatted with afterwards', () => {
  it('stops the report and the figures where the cycle ended, and counts the chat apart', () => {
    const P = '44444444-2222-4333-8444-555555555555';
    const f = path.join(project.paths.transcripts, project.slug, `${P}.jsonl`);
    fs.writeFileSync(
      f,
      line(user('You are the lead. Find what to do next.', '2026-01-03T10:00:00Z')) +
        line(asst('p1', 'claude-lead-1', usage(1_000_000, 0), [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }], '2026-01-03T10:00:10Z')) +
        line(asst('p2', 'claude-lead-1', usage(0, 0), [{ type: 'text', text: 'Five proposals written.' }], '2026-01-03T10:01:00Z')) +
        line(user('[agent-kit owner chat] This is the owner, through the kit.\n\nWhy item 2?', '2026-01-03T12:00:00Z')) +
        line(asst('c1', 'claude-lead-1', usage(500_000, 0), [{ type: 'tool_use', id: 'x2', name: 'Grep', input: {} }], '2026-01-03T12:00:05Z')) +
        line(asst('c2', 'claude-lead-1', usage(0, 0), [{ type: 'text', text: 'Because of the menu.' }], '2026-01-03T12:00:20Z')) +
        line(user([{ type: 'text', text: '[agent-kit owner chat] This is the owner.\n\nDrop it then.' }], '2026-01-03T13:00:00Z')) +
        line(asst('c3', 'claude-lead-1', usage(500_000, 0), [{ type: 'text', text: 'Dropped.' }], '2026-01-03T13:00:10Z'))
    );
    const tree = sessionTree(project, P, { pricing, labeler });
    const lead = tree.nodes[0];
    expect(lead.report).toBe('Five proposals written.');
    expect(lead).toMatchObject({ turns: 2, toolCalls: 1, costUsd: 4, ended: '2026-01-03T10:01:00Z' });
    expect(tree.session.total).toMatchObject({ costUsd: 4, toolCalls: 1 });
    expect(tree.session.chat).toEqual({ turns: 2, costUsd: 4 });
    expect(leadReport(project, P)).toBe('Five proposals written.');
    // A cycle without chat turns has no chat line.
    expect(sessionTree(project, SID, { pricing, labeler }).session.chat).toBeNull();
    fs.rmSync(f);
  });
});

describe('leadReport', () => {
  it("gives the lead's last words, and nothing for a bad id", () => {
    const R = '33333333-2222-4333-8444-555555555555';
    fs.writeFileSync(
      path.join(project.paths.transcripts, project.slug, `${R}.jsonl`),
      line(asst('r1', 'claude-lead-1', usage(1, 1), [{ type: 'text', text: 'Working.' }], '2026-01-02T10:00:00Z')) +
        line(asst('r2', 'claude-lead-1', usage(1, 1), [{ type: 'text', text: '**Cycle summary:** merged the menu.' }], '2026-01-02T11:00:00Z'))
    );
    expect(leadReport(project, R)).toBe('**Cycle summary:** merged the menu.');
    expect(leadReport(project, SID)).toBeNull(); // only tool calls, no words
    expect(leadReport(project, '../etc')).toBeNull();
    fs.rmSync(path.join(project.paths.transcripts, project.slug, `${R}.jsonl`));
  });
});

describe('sessionTree', () => {
  it('rejects ids that are not session ids', () => {
    expect(sessionTree(project, '../etc', { pricing, labeler })).toBeNull();
  });

  it('marks the lead ending while its ledger line may not be pulled yet', () => {
    const ended = fs.statSync(path.join(project.paths.transcripts, project.slug, `${SID}.jsonl`)).mtimeMs;
    expect(sessionTree(project, SID, { pricing, labeler, ledgerAt: ended - 1000 }).nodes[0].status).toBe('ending');
    expect(sessionTree(project, SID, { pricing, labeler, ledgerAt: ended + 600_000 }).nodes[0].status).toBe('interrupted');
    expect(sessionTree(project, SID, { pricing, labeler }).nodes[0].status).toBe('interrupted');
  });

  it('builds lead, area lead and scout with the right parents', () => {
    const { nodes } = sessionTree(project, SID, { pricing, labeler });
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(nodes.map((n) => n.id)).toEqual(['lead', 'aaa', 'bbb']);
    expect(by.aaa).toMatchObject({ parent: 'lead', depth: 1, agentType: 'area-lead-engine', description: 'Engine goal' });
    expect(by.bbb).toMatchObject({ parent: 'aaa', depth: 2, agentType: 'scout' });
  });

  it('reads brief, model, context and tools; skips bad and half-written lines', () => {
    const { nodes } = sessionTree(project, SID, { pricing, labeler });
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(by.lead.brief).toBe('You are the lead. Plan the cycle.');
    expect(by.lead.model).toBe('claude-lead-1');
    expect(by.lead.turns).toBe(1); // m1 counted once, the half-written m2 not at all
    expect(by.lead.outputTokens).toBe(50);
    expect(by.lead.contextTokens).toBe(130);
    expect(by.lead.tools).toEqual([{ name: 'Bash', count: 1 }, { name: 'Agent', count: 1 }]);
    expect(by.aaa.contextTokens).toBe(3005);
    expect(by.aaa.peakTokens).toBe(3005);
    expect(by.bbb.brief).toBe('Find the files.');
    expect(by.bbb.tools).toEqual([{ name: 'Grep', count: 2 }]);
    expect(by.bbb.report).toBe('Found three files.');
  });

  it('prices by the first matching model entry, else the default', () => {
    const { nodes } = sessionTree(project, SID, { pricing, labeler });
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(by.bbb.costUsd).toBeCloseTo(1 + 5, 4); // 1M input at $1 + 1M output at $5
    expect(by.aaa.costUsd).toBeCloseTo((10 * 4 + 110 * 20 + 5000 * 0.2) / 1e6, 4);
  });

  it('derives status from the VM state, never from guesses', () => {
    const idle = Object.fromEntries(sessionTree(project, SID, { pricing, labeler }).nodes.map((n) => [n.id, n.status]));
    expect(idle).toEqual({ lead: 'interrupted', aaa: 'interrupted', bbb: 'done' });
    const live = Object.fromEntries(
      sessionTree(project, SID, { pricing, labeler, status: { leadActive: true, session: SID } }).nodes.map((n) => [n.id, n.status])
    );
    // The lead waits on its open Agent call; the area lead's scout has finished but not yet returned.
    expect(live).toEqual({ lead: 'waiting', aaa: 'waiting', bbb: 'done' });
  });

  it('uses the latest branch, and the worktree branch for agents still on main', () => {
    const { nodes } = sessionTree(project, SID, { pricing, labeler });
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(by.aaa.branch).toBe('work/engine');
    expect(by.bbb.branch).toBe('work/engine');
  });

  it('picks up appended lines without re-reading the file', () => {
    const file = path.join(project.paths.transcripts, project.slug, SID, 'subagents', 'agent-aaa.jsonl');
    fs.appendFileSync(file, line(asst('a3', 'claude-big-1', usage(5, 7, 4000, 0), [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }], '2026-01-01T10:04:00Z')));
    const aaa = sessionTree(project, SID, { pricing, labeler }).nodes.find((n) => n.id === 'aaa');
    expect(aaa.contextTokens).toBe(4005);
    expect(aaa.outputTokens).toBe(117);
    expect(aaa.toolCalls).toBe(2);
  });
});
