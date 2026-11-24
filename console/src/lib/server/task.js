// "Task at hand" on the Topology page: what one cycle is (or was) for, and,
// when no cycle runs, why and what comes next.
//
// Nothing here asks the VM anything. The kind of run and its job come from
// the live status and the cycle ledger; the planned job and the issue from
// this console's own records of the job; the lead's words from its transcript.
// What an agent wrote (the lead's text, a proposal's title) is data: it is cut
// to a short plain line here and shown as text.
import { readCycles } from './aggregate.js';
import { itemForJob, planRequest, jobsFor, PLAN_RE } from './backlog.js';
import { get as getIssue, issueForJob } from './issues.js';
import { sentText } from './feedback.js';
import { leadLast } from './transcripts.js';

const JOB_RE = /^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/;
const ISSUE_IN_TEXT = /(?:Fix owner issue #\d{1,6} \(|Owner issue )([0-9]{8}T[0-9]{6}Z-i-[a-f0-9]{6})\b/;
const LINE_CAP = 320;

/** Markdown to one plain line: no markers, no line breaks, cut to `cap`. */
export function plainLine(text, cap = LINE_CAP) {
  const t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d{1,3}\.)\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > cap ? `${t.slice(0, cap - 1).trimEnd()}…` : t;
}

const paragraphs = (text) =>
  String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/**
 * The lead's own summary of a cycle, from its report: the paragraph it marks
 * "**Cycle summary:**", or the report's first paragraph when it marked none.
 */
export function cycleSummary(report) {
  const text = String(report || '');
  const m = /(?:^|\n)[ \t]*(?:\*\*|#{1,6}[ \t]*)?Cycle summary:?(?:\*\*)?:?[ \t]*/i.exec(text);
  const para = m ? paragraphs(text.slice(m.index + m[0].length))[0] : paragraphs(text)[0];
  return plainLine(para || '');
}

const issueShape = (i) => (i ? { id: i.id, number: Number.isInteger(i.number) ? i.number : null, title: plainLine(i.title, 200), kind: i.kind || null, priority: i.priority || null, status: i.status || null } : null);

/**
 * What a job id stands for: {kind, item, issue, plan, text}.
 *   plan     a planning cycle, with the owner's focus
 *   job      an approved proposal of the Planning tab, with its planned issue when it has one
 *   fix      Fix now on an issue
 *   oneshot  an owner message started as a one-shot job
 * `brief` is the cycle's prompt, when there is one: an older job whose record
 * the console no longer holds still names its issue there, and that name
 * counts only when this console has that issue.
 */
function describe(project, jobId, brief = '') {
  if (PLAN_RE.test(jobId || '')) {
    const plan = planRequest(project, jobId);
    return { kind: 'plan', item: null, issue: null, plan: { id: jobId, focus: plainLine(plan?.focus || '', 200) }, text: null };
  }
  if (!JOB_RE.test(jobId || '')) return null;
  const named = ISSUE_IN_TEXT.exec(String(brief || ''))?.[1] || null;
  const item = itemForJob(project, jobId);
  if (item) {
    const issue = getIssue(project, item.issueId || '') || issueForJob(project, jobId) || getIssue(project, named || '');
    return { kind: 'job', item: { pid: item.pid, order: item.order, title: plainLine(item.title, 200), minutes: item.minutes, cost: item.cost }, issue: issueShape(issue), plan: null, text: null };
  }
  const issue = issueForJob(project, jobId) || getIssue(project, named || '');
  if (issue) return { kind: 'fix', item: null, issue: issueShape(issue), plan: null, text: null };
  const sent = sentText(project, jobId);
  return { kind: 'oneshot', item: null, issue: null, plan: null, text: sent ? plainLine(paragraphs(sent)[0], 200) : null };
}

/** The cycle of one picked session. `row` is its line of listSessions. */
function runOf(project, tree, row, status) {
  const s = tree.session;
  const lead = tree.nodes[0] || {};
  const line = readCycles(project.paths.fleet).findLast((c) => c.session === s.id && c.kind !== 'chat') || null;
  const jobId = s.live ? status?.oneshot?.id || null : line?.plan || line?.oneshot || null;
  const what = describe(project, jobId, lead.brief) || { kind: 'cycle', item: null, issue: null, plan: null, text: null };
  const last = leadLast(project, s.id);
  let said = null;
  if (last) {
    // A cycle that ended in order closes with its report; one that was cut off
    // (or still runs) has only the last thing the lead wrote.
    const ended = lead.status === 'done' || lead.status === 'failed';
    said = ended ? { label: 'summary', text: cycleSummary(last.text), at: last.at } : { label: s.live ? 'latest' : 'last', text: plainLine(paragraphs(last.text)[0]), at: last.at };
    if (!said.text) said = null;
  }
  return {
    ...what,
    live: !!s.live,
    // The cycle in progress is stuck (kit 0.24): shown as Stalled, with why.
    stalled: s.live ? status?.stalled || null : null,
    state: lead.status || null,
    number: row?.number ?? null,
    slot: line?.slot || null,
    started: s.started || null,
    ended: s.live ? null : s.ended || null,
    // The ledger's figure once the cycle has ended, the running estimate before.
    costUsd: s.ledger?.costUsd ?? s.total?.costUsd ?? null,
    said
  };
}

/** Why no cycle runs, and the next job set for a time. */
function teamOf(project, status, now) {
  if (!status?.reachable || (status.state !== 'idle' && status.state !== 'halted')) return null;
  let next = null;
  // In focus (kit 0.29) planned jobs are pulled forward: the one the focus holds for starts next.
  const hold = status.focus?.on?.hold || null;
  if (hold) {
    const what = describe(project, hold.id);
    if (what) next = { at: hold.at * 1000, ...what };
  }
  if (!next) try {
    const set = jobsFor(project, status, now).find((j) => j.state === 'set');
    if (set) next = { at: set.start, ...describe(project, set.id) };
  } catch {
    /* no backlog here */
  }
  if (!next) {
    const at = [...(status.atJobs || [])].sort((a, b) => a.at - b.at)[0];
    const what = at ? describe(project, at.id) : null;
    if (what) next = { at: at.at * 1000, ...what };
  }
  return { state: status.state, idle: status.idle || null, haltAfter: !!status.haltAfter, next, focusNext: !!hold };
}

/**
 * Everything the "Task at hand" strip shows, or null when nothing is known.
 *   run   the picked cycle (see runOf), or null when no cycle is recorded
 *   team  set only while the page follows the latest cycle and none runs
 */
export function taskAtHand(project, { status = null, tree = null, row = null, following = false, now = Date.now() } = {}) {
  let run = null;
  let team = null;
  try {
    run = tree ? runOf(project, tree, row, status) : null;
  } catch {
    /* a record that cannot be read: a smaller answer */
  }
  try {
    team = following && !run?.live ? teamOf(project, status, now) : null;
  } catch {
    /* as above */
  }
  return run || team ? { run, team } : null;
}
