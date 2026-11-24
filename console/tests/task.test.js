import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR is read when the modules load, so point it at a temp folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-task-'));
process.env.CONSOLE_DATA_DIR = root;
const { taskAtHand, cycleSummary, plainLine } = await import('../src/lib/server/task.js');
const { sessionTree, listSessions, _test } = await import('../src/lib/server/transcripts.js');

// Synthetic data in the shapes the console and Claude Code write. No real data.
const slug = '-home-agent-demo';
const project = { id: 'team', slug, paths: { transcripts: path.join(root, 'projects'), fleet: path.join(root, 'fleet') } };
const dir = path.join(root, 'projects', slug);
const pricing = { cacheWrite5mFactor: 1.25, cacheWrite1hFactor: 2, models: [], default: { input: 4, output: 20, cacheRead: 0.2 } };
const labeler = (agentType, depth) => ({ label: agentType, kind: 'other', rawType: agentType, tier: depth });

const sid = (n) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`;
const PLAN = '20260101T090000Z-p-aaaaaa';
const PID = '20260101T090100Z-b-abcdef';
const JOB = '20260101T100000Z-o-aaaaaa'; // the backlog item's job
const FIX = '20260101T110000Z-o-bbbbbb'; // Fix now, noted on the issue
const FIX_OLD = '20260101T113000Z-o-cccccc'; // Fix now, the issue has a later job since
const PLAIN = '20260101T120000Z-o-dddddd'; // an owner message from Controls
const LOST = '20260101T123000Z-o-eeeeee'; // names an issue this console does not have
const ISSUE = '20260101T080000Z-i-aaaaaa'; // planned, tracks the backlog item
const BUG = '20260101T081000Z-i-bbbbbb';

const line = (o) => JSON.stringify(o) + '\n';
const json = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const user = (text, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const says = (id, text, ts) => ({ type: 'assistant', timestamp: ts, message: { id, model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] } });

/** One lead session: its prompt, then what the lead wrote. */
function session(n, prompt, texts) {
  fs.mkdirSync(path.join(dir, sid(n), 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, sid(n), 'subagents', 'agent-a.meta.json'), '{}');
  fs.writeFileSync(
    path.join(dir, `${sid(n)}.jsonl`),
    line(user(prompt, `2026-01-01T1${n}:00:00Z`)) + texts.map((t, i) => line(says(`m${i}`, t, `2026-01-01T1${n}:0${i + 1}:00Z`))).join('')
  );
}
const ledger = [];
const cycle = (n, extra = {}) => ledger.push({ start: `2026-01-01T1${n}:00:00+00:00`, end: `2026-01-01T1${n}:30:00+00:00`, secs: 1800, rc: 0, cost_usd: 3.5, session: sid(n), counted: true, kind: 'normal', ...extra });

function task(n, { status = null, following = false } = {}) {
  const sessions = listSessions(project, status);
  const tree = sessionTree(project, sid(n), { status, pricing, labeler });
  return taskAtHand(project, { status, tree, row: sessions.find((s) => s.id === sid(n)), following, now: Date.parse('2026-01-01T20:00:00Z') });
}

beforeAll(() => {
  fs.mkdirSync(project.paths.fleet, { recursive: true });
  const bl = path.join(root, 'backlog', 'team');
  json(path.join(bl, 'plans', `${PLAN}.json`), { focus: 'What to do **next**\nafter the first release' });
  fs.mkdirSync(path.join(bl, 'out'), { recursive: true });
  fs.writeFileSync(
    path.join(bl, 'out', `${PID}.md`),
    `plan: ${PLAN}\nrev: 1\ndate: 2026-01-01T09:01:00Z\ntitle: Run it on a laptop\nminutes: 60\ncost-usd: 4\nconfidence: medium\norder: 1\n---\nWhy: it helps.\n`
  );
  json(path.join(bl, 'runs', `${PID}.json`), { jobId: JOB, rev: 1, at: '2026-01-01T10:00:00Z' });
  json(path.join(bl, 'decisions', `${PID}.json`), { status: 'approved', rev: 1, issueId: ISSUE, issueRev: 1 });
  const issues = path.join(root, 'issues', 'team');
  json(path.join(issues, ISSUE, 'issue.json'), { id: ISSUE, number: 41, title: 'Run it on a laptop', kind: 'planned', priority: 'normal', status: 'in_progress', job: { id: JOB } });
  json(path.join(issues, BUG, 'issue.json'), { id: BUG, number: 12, title: 'Voice cuts off', kind: 'bug', priority: 'high', status: 'new', job: { id: FIX } });
  fs.mkdirSync(path.join(root, 'feedback', 'team', 'sent', PLAIN), { recursive: true });
  fs.writeFileSync(path.join(root, 'feedback', 'team', 'sent', PLAIN, 'body.md'), 'Tidy the README.\n\nAnd nothing else.\n');

  // 1: the backlog job, ended. 2: Fix now. 3: an older Fix now of the same issue.
  // 4: an owner message. 5: a job text that names an unknown issue. 6: a planning
  // cycle. 7: a scheduled cycle that ended. 8: a cycle that was cut off.
  session(1, 'One-shot job.\n\nOwner issue ' + ISSUE + ' tracks this item: set it in_progress', ['Working.', 'Done.\n\n**Cycle summary:** The job merged `laptop-emu` first try.\n\nMore detail below.']);
  cycle(1, { kind: 'oneshot', oneshot: JOB });
  session(2, `Fix owner issue #12 (${BUG}): Voice cuts off`, ['Fixed.']);
  cycle(2, { kind: 'oneshot', oneshot: FIX });
  session(3, `Fix owner issue #12 (${BUG}): Voice cuts off`, ['First try at it.']);
  cycle(3, { kind: 'oneshot', oneshot: FIX_OLD });
  session(4, 'One-shot job: tidy', ['Tidied.']);
  cycle(4, { kind: 'oneshot', oneshot: PLAIN });
  session(5, 'Fix owner issue #99 (20260101T070000Z-i-ffffff): gone', ['Nothing to do.']);
  cycle(5, { kind: 'oneshot', oneshot: LOST });
  session(6, 'Planning cycle.', ['Filed four proposals.']);
  cycle(6, { kind: 'plan', oneshot: PLAN, plan: PLAN });
  // A chat turn resumed the planning session: its ledger line is not the cycle's.
  ledger.push({ start: '2026-01-01T16:40:00+00:00', end: '2026-01-01T16:40:09+00:00', secs: 9, rc: 0, session: sid(6), counted: false, kind: 'chat', plan: PLAN });
  session(7, 'You are the lead.', ['QA round 7 is back.', 'Cycle 7 is finished: all merged.\n\n- one\n- two']);
  cycle(7, { slot: 'daily@18:00' });
  session(8, 'You are the lead.', ['QA round 8 is back; **dispatching** one area lead.\n\nSecond paragraph.']);
  fs.writeFileSync(path.join(project.paths.fleet, 'cycles.jsonl'), ledger.map(line).join(''));
  _test.folds.clear();
});

describe('what a cycle was for', () => {
  it('a backlog job: its item, its planned issue, its estimate, the summary', () => {
    const { run, team } = task(1);
    expect(team).toBe(null);
    expect(run.kind).toBe('job');
    expect(run.item).toEqual({ pid: PID, order: 1, title: 'Run it on a laptop', minutes: 60, cost: 4 });
    expect(run.issue).toMatchObject({ id: ISSUE, number: 41, status: 'in_progress' });
    expect(run).toMatchObject({ live: false, state: 'done', costUsd: 3.5 });
    expect(run.said).toMatchObject({ label: 'summary', text: 'The job merged laptop-emu first try.' });
  });

  it('Fix now: the issue the console noted for the job', () => {
    const { run } = task(2);
    expect(run.kind).toBe('fix');
    expect(run.issue).toEqual({ id: BUG, number: 12, title: 'Voice cuts off', kind: 'bug', priority: 'high', status: 'new' });
    expect(run.item).toBe(null);
  });

  it('an older Fix now: the issue its job text names, when this console has it', () => {
    expect(task(3).run).toMatchObject({ kind: 'fix', issue: { id: BUG } });
  });

  it('a job text that names an unknown issue gives no issue', () => {
    expect(task(5).run).toMatchObject({ kind: 'oneshot', issue: null, text: null });
  });

  it('an owner message: its first paragraph', () => {
    expect(task(4).run).toMatchObject({ kind: 'oneshot', text: 'Tidy the README.', issue: null });
  });

  it('a planning cycle: the focus as one plain line, not the chat turn after it', () => {
    const { run } = task(6);
    expect(run.kind).toBe('plan');
    expect(run.plan).toEqual({ id: PLAN, focus: 'What to do next after the first release' });
    expect(run.costUsd).toBe(3.5);
  });

  it('a scheduled cycle: its slot, and the first paragraph of a report without a summary mark', () => {
    const { run } = task(7);
    expect(run).toMatchObject({ kind: 'cycle', slot: 'daily@18:00', item: null, issue: null, plan: null });
    expect(run.said).toMatchObject({ label: 'summary', text: 'Cycle 7 is finished: all merged.' });
  });

  it('a cycle that was cut off: the last thing the lead wrote, with its time', () => {
    const { run } = task(8);
    expect(run.state).not.toBe('done');
    expect(run.said).toEqual({ label: 'last', text: 'QA round 8 is back; dispatching one area lead.', at: '2026-01-01T18:01:00Z' });
  });
});

describe('a cycle that runs', () => {
  const running = (extra = {}) => ({ reachable: true, state: 'running', leadActive: true, session: sid(8), atJobs: [], ...extra });

  it('a scheduled cycle: the latest word of the lead, no team rows', () => {
    const { run, team } = task(8, { status: running(), following: true });
    expect(team).toBe(null);
    expect(run).toMatchObject({ live: true, kind: 'cycle', ended: null });
    expect(run.said.label).toBe('latest');
  });

  it('a job: from the status, before the ledger has a line', () => {
    const { run } = task(8, { status: running({ oneshot: { id: JOB, plan: false } }) });
    expect(run).toMatchObject({ kind: 'job', item: { pid: PID }, issue: { id: ISSUE } });
  });

  it('a planning cycle: from the status', () => {
    expect(task(8, { status: running({ oneshot: { id: PLAN, plan: true } }) }).run).toMatchObject({ kind: 'plan', plan: { id: PLAN } });
  });
});

describe('no cycle runs', () => {
  const idle = { reason: 'between', today: 2, cap: 4, nextAt: 1767300000, dayEndsAt: 1767312000 };

  it('idle: why, the next job set for a time, and the last cycle', () => {
    const NEXT = '20260101T190000Z-o-ffffff';
    json(path.join(root, 'backlog', 'team', 'runs', '20260101T090200Z-b-bbbbbb.json'), { jobId: NEXT, rev: 1, at: '2026-01-01T19:00:00Z', scheduledFor: 1767304800, minutes: 45 });
    const status = { reachable: true, state: 'idle', leadActive: false, idle, atJobs: [{ id: NEXT, at: 1767304800, from: 'owner', plan: false, wait: null }] };
    const { run, team } = task(7, { status, following: true });
    expect(run.kind).toBe('cycle');
    expect(team).toMatchObject({ state: 'idle', idle, haltAfter: false });
    expect(team.next).toMatchObject({ at: 1767304800000, kind: 'job', item: { pid: '20260101T090200Z-b-bbbbbb', title: 'Planned job', minutes: 45 } });
  });

  it('a planning cycle set for a time is the next job', () => {
    const status = { reachable: true, state: 'idle', leadActive: false, idle, atJobs: [{ id: PLAN, at: 1767308400, plan: true }] };
    expect(task(7, { status, following: true }).team.next).toMatchObject({ at: 1767308400000, kind: 'plan', plan: { id: PLAN } });
  });

  it('halted with nothing set', () => {
    const { team } = task(7, { status: { reachable: true, state: 'halted', leadActive: false, atJobs: [] }, following: true });
    expect(team).toEqual({ state: 'halted', idle: null, haltAfter: false, next: null, focusNext: false });
  });

  it('in focus the job the focus holds for starts next (kit 0.29)', () => {
    const status = { reachable: true, state: 'idle', leadActive: false, idle, atJobs: [{ id: PLAN, at: 1767308400, plan: true }], focus: { on: { since: 1, perDay: 6, done: 0, hold: { id: PLAN, at: 1767308400, kind: 'plan' } } } };
    const { team } = task(7, { status, following: true });
    expect(team.focusNext).toBe(true);
    expect(team.next).toMatchObject({ at: 1767308400000, kind: 'plan' });
  });

  it('an older cycle picked from the list has no team rows', () => {
    expect(task(7, { status: { reachable: true, state: 'idle', idle, atJobs: [] }, following: false }).team).toBe(null);
  });

  it('a team that never ran a cycle shows its state only', () => {
    const t = taskAtHand(project, { status: { reachable: true, state: 'idle', idle, atJobs: [] }, tree: null, following: true });
    expect(t).toMatchObject({ run: null, team: { state: 'idle' } });
  });

  it('nothing known gives null', () => {
    expect(taskAtHand(project, { status: null, tree: null, following: true })).toBe(null);
    expect(taskAtHand(project, { status: { reachable: false, state: 'unreachable' }, tree: null, following: true })).toBe(null);
  });
});

describe('agent text', () => {
  it('becomes one plain line, cut to length', () => {
    expect(plainLine('## Head\n\n- **bold** and `code`\n\n```\nrm -rf\n```')).toBe('Head bold and code');
    const long = plainLine('x'.repeat(1000));
    expect(long.length).toBe(320);
    expect(long.endsWith('…')).toBe(true);
  });

  it('the summary is the marked paragraph only', () => {
    expect(cycleSummary('Intro.\n\n**Cycle summary:** One.\nStill one.\n\nTwo.')).toBe('One. Still one.');
    expect(cycleSummary('We wrote no cycle summary: sorry.\n\nMore.')).toBe('We wrote no cycle summary: sorry.');
    expect(cycleSummary('')).toBe('');
  });
});
