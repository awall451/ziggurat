// The backlog (kit 0.10): planning cycles the owner starts, the lead's
// proposals with their estimates, the owner's decisions, and the chat with
// the lead about one planning session.
//
// What the owner does goes to the VM through fixed kit scripts
// (agent-kit-oneshot --plan, agent-kit-backlog, agent-kit-chat), with checked
// arguments and free text on stdin. What the lead writes (backlog-out/) is
// pulled as the agent user and parsed as data: every field is checked, and a
// proposal or an answer that does not belong to a plan or a message sent from
// this console is ignored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { kit, pull } from './ssh.js';
import { parseHeaderFile } from './headerfile.js';
import { vmSaidNo, sendOneshot, scheduleOneshot, rescheduleOneshot } from './feedback.js';
import { audit } from './audit.js';
import { invalidateStatus, getStatus, peekStatus } from './live.js';
import { createPlanned, noteJob, setStatus as setIssueStatus, get as getIssue, PLANNED_KIT, OPEN as OPEN_ISSUE } from './issues.js';

export const BACKLOG_KIT = '0.10.0';
export const PLAN_RE = /^[0-9]{8}T[0-9]{6}Z-p-[a-z0-9-]{1,40}$/;
export const PID_RE = /^[0-9]{8}T[0-9]{6}Z-b-[a-f0-9]{6}$/;
export const MSG_RE = /^[0-9]{8}T[0-9]{6}Z-c-[a-f0-9]{6}$/;
const CONFIDENCE = ['low', 'medium', 'high'];
const MAX_FOCUS = 8000;
const MAX_CHAT = 20000;
const SYNC_EVERY = 15_000;
const LINE = (v, n = 300) => (typeof v === 'string' && v.length <= n && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);

const dirFor = (project) => path.join(DATA_DIR, 'backlog', project.id);
const plansDir = (project) => path.join(dirFor(project), 'plans');
const chatDir = (project, plan) => path.join(dirFor(project), 'chat', plan);
const decisionsDir = (project) => path.join(dirFor(project), 'decisions');
const runsDir = (project) => path.join(dirFor(project), 'runs');
const outDir = (project) => path.join(dirFor(project), 'out');

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
const hex = () => crypto.randomBytes(3).toString('hex');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function names(dir, re, ext = '.json') {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(ext) && re.test(n.slice(0, -ext.length)))
      .map((n) => n.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

export const senderName = (user) => (/^[A-Za-z0-9._@-]{1,80}$/.test(user?.name || '') ? user.name : 'owner');

/** Is this VM's kit new enough for the backlog? */
export function kitHasBacklog(version) {
  const v = String(version || '').trim().split('.').map(Number);
  const w = BACKLOG_KIT.split('.').map(Number);
  if (v.length !== 3 || v.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== w[i]) return v[i] > w[i];
  return true;
}

// ---- planning cycles -----------------------------------------------------

/**
 * Ask the lead to find what to do next: one planning cycle, now or at a set
 * time (epoch seconds). A refusal by the VM throws and keeps nothing. With no
 * clear answer the plan is kept as "not started" (it may be running).
 */
export async function startPlan(user, project, { focus = '', at = null } = {}) {
  const text = String(focus || '').trim();
  if (text.length > MAX_FOCUS) throw new Error('The focus text is too long');
  const id = `${stamp()}-p-${hex()}`;
  const from = senderName(user);
  let epoch = null;
  if (at != null) epoch = checkTime(at);
  const argv = epoch ? ['at', String(epoch), id, from, '--plan'] : ['start', id, from, '--plan'];
  const res = await kit(project, 'agent-kit-oneshot', argv, { input: text, timeout: 120000 });
  let started = res.code === 0;
  const error = started ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  if (!started && vmSaidNo(res.code)) {
    audit(user, project.id, 'plan-start', { id, at: epoch ? new Date(epoch * 1000).toISOString() : null }, { ok: false, detail: error });
    throw new Error(error);
  }
  if (!started && !epoch) {
    const status = await getStatus(project, { fresh: true }).catch(() => null);
    if (status?.oneshot?.id === id) started = true;
  }
  const plan = {
    id,
    focus: text,
    by: from,
    askedAt: new Date().toISOString(),
    scheduledFor: epoch && started ? epoch : null,
    started: started && !epoch,
    error: started ? null : error,
    ended: false
  };
  writeJson(path.join(plansDir(project), `${id}.json`), plan);
  audit(user, project.id, 'plan-start', { id, at: epoch ? new Date(epoch * 1000).toISOString() : null }, { ok: started, detail: error });
  invalidateStatus(project.id);
  return {
    ok: true,
    id,
    started,
    detail: !started
      ? `No clear answer from the VM (${error}). The plan is kept; check the team's status before you start another.`
      : epoch
        ? 'Planning cycle set for that time.'
        : /runs on when it ends/.test(res.stdout || '')
          ? 'Planning cycle started. The team goes back to running when it ends.'
          : 'Planning cycle started. The team halts again when it ends.'
  };
}

/** Cancel a planning cycle or a job that waits for its time. */
export async function cancelAt(user, project, id) {
  if (!PLAN_RE.test(id) && !/^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(id)) throw new Error('Bad id');
  const res = await kit(project, 'agent-kit-oneshot', ['unat', id]);
  const ok = res.code === 0 || /no job set for a time/.test(res.stderr || '');
  audit(user, project.id, 'job-at-cancel', { id }, { ok, detail: ok ? null : (res.stderr || '').trim().slice(-200) });
  if (!ok) throw new Error((res.stderr || 'could not cancel on the VM').trim().slice(-200));
  if (PLAN_RE.test(id)) {
    const file = path.join(plansDir(project), `${id}.json`);
    const plan = readJson(file);
    if (plan) writeJson(file, { ...plan, scheduledFor: null, cancelled: true });
  }
  for (const pid of names(runsDir(project), PID_RE)) {
    const file = path.join(runsDir(project), `${pid}.json`);
    const r = readJson(file);
    if (r?.jobId === id) {
      writeJson(file, { ...r, scheduledFor: null, cancelled: true });
      const d = readJson(path.join(decisionsDir(project), `${pid}.json`));
      if (d?.issueId) noteJob(project, d.issueId, null);
    }
  }
  invalidateStatus(project.id);
  return { ok: true };
}

/**
 * Move a job or a planning cycle that waits for its time: the VM forgets the
 * old time (unat) and gets the stored job again for the new one (at).
 */
export async function moveAt(user, project, id, at) {
  const epoch = checkTime(at);
  if (PLAN_RE.test(id)) {
    const file = path.join(plansDir(project), `${id}.json`);
    const plan = readJson(file);
    if (!plan) throw new Error('No such planning cycle');
    const un = await kit(project, 'agent-kit-oneshot', ['unat', id]);
    if (un.code !== 0) throw new Error((un.stderr || 'could not move it on the VM').trim().slice(-200));
    const res = await kit(project, 'agent-kit-oneshot', ['at', String(epoch), id, senderName(user), '--plan'], { input: plan.focus || '', timeout: 120000 });
    const ok = res.code === 0;
    audit(user, project.id, 'job-at-move', { id, at: new Date(epoch * 1000).toISOString() }, { ok, detail: ok ? null : (res.stderr || '').trim().slice(-200) });
    if (!ok) {
      writeJson(file, { ...plan, scheduledFor: null, error: (res.stderr || 'not set again').trim().slice(-300) });
      throw new Error(`The old time is cancelled, but the new one was not set: ${(res.stderr || '').trim().slice(-200)}`);
    }
    writeJson(file, { ...plan, scheduledFor: epoch });
  } else {
    const out = await rescheduleOneshot(project, id, epoch);
    audit(user, project.id, 'job-at-move', { id, at: new Date(epoch * 1000).toISOString() }, { ok: out.ok, detail: out.error });
    if (!out.ok) throw new Error(out.error);
    for (const pid of names(runsDir(project), PID_RE)) {
      const f = path.join(runsDir(project), `${pid}.json`);
      const r = readJson(f);
      if (r?.jobId !== id) continue;
      writeJson(f, { ...r, scheduledFor: epoch });
      const d = readJson(path.join(decisionsDir(project), `${pid}.json`));
      if (d?.issueId) noteJob(project, d.issueId, { id, scheduledFor: epoch });
    }
  }
  invalidateStatus(project.id);
  return { ok: true, detail: 'Moved.' };
}

function checkTime(at) {
  const t = Number(at);
  const now = Date.now() / 1000;
  if (!Number.isInteger(t) || t < now + 60 || t > now + 30 * 86400) throw new Error('Pick a time between one minute and 30 days from now');
  return t;
}

// ---- proposals -----------------------------------------------------------

/** One pulled proposal, checked field by field; null when it is not valid. */
export function parseProposal(file, pid, knownPlans) {
  const p = parseHeaderFile(file, 40_000);
  if (!p) return null;
  const f = p.fields;
  const plan = f.plan;
  if (!PLAN_RE.test(plan || '') || !knownPlans.has(plan)) return null;
  const rev = /^\d{1,4}$/.test(f.rev || '') ? Number(f.rev) : null;
  const minutes = /^\d{1,2}$/.test(f.minutes || '') ? Number(f.minutes) : null;
  const cost = /^\d{1,3}(\.\d{1,2})?$/.test(f['cost-usd'] || '') ? Number(f['cost-usd']) : null;
  const title = LINE(f.title);
  if (!rev || !minutes || minutes < 1 || minutes > 90 || cost == null || !title || !CONFIDENCE.includes(f.confidence)) return null;
  if (!f.date || isNaN(Date.parse(f.date))) return null;
  const depends = (f.depends || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => PID_RE.test(s))
    .slice(0, 10);
  return {
    pid,
    plan,
    rev,
    date: f.date,
    title,
    minutes,
    cost,
    confidence: f.confidence,
    areas: LINE(f.areas || '') || '',
    risk: LINE(f.risk || '') || '',
    order: /^\d{1,3}$/.test(f.order || '') ? Number(f.order) : null,
    depends,
    text: p.body.slice(0, 8000)
  };
}

const atLeast = (version, want) => {
  const v = String(version || '').split('.').map(Number);
  const w = want.split('.').map(Number);
  if (v.length !== 3 || v.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== w[i]) return v[i] > w[i];
  return true;
};

/** Close the planned issue of an earlier decision, if it is still open. */
async function closeIssue(user, project, issueId, note) {
  const issue = issueId ? getIssue(project, issueId) : null;
  if (issue && OPEN_ISSUE.includes(issue.status)) await setIssueStatus(project, user, issueId, 'wontfix', note).catch(() => {});
}

/**
 * The owner's decision, kept here and sent to the VM. Approving also makes
 * the proposal a planned issue (kit 0.11): one per approved revision.
 */
export async function decide(user, project, pid, status) {
  if (!PID_RE.test(pid)) throw new Error('Bad proposal id');
  if (!['approved', 'rejected', 'new'].includes(status)) throw new Error('Bad decision');
  const prop = proposal(project, pid);
  if (!prop) throw new Error('No such proposal');
  const res = await kit(project, 'agent-kit-backlog', ['set', pid, status, String(prop.rev)]);
  const ok = res.code === 0;
  const detail = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-200);
  audit(user, project.id, 'backlog-decide', { pid, status, rev: prop.rev }, { ok, detail });
  if (!ok) throw new Error(detail);
  const file = path.join(decisionsDir(project), `${pid}.json`);
  const before = readJson(file);
  let issueId = before?.issueId || null;
  let issueRev = before?.issueRev ?? null;
  if (status === 'approved') {
    if (issueId && issueRev !== prop.rev) {
      await closeIssue(user, project, issueId, `replaced by revision ${prop.rev} of the proposal`);
      issueId = null;
    }
    if (!issueId && atLeast(peekStatus(project.id)?.kitVersion, PLANNED_KIT)) {
      const issue = await createPlanned(project, user, {
        title: `${prop.order != null ? `${prop.order}. ` : ''}${prop.title}`,
        body: jobText(prop),
        proposal: { pid, rev: prop.rev, plan: prop.plan }
      }).catch(() => null);
      if (issue) {
        issueId = issue.id;
        issueRev = prop.rev;
      }
    }
  } else if (issueId) {
    await closeIssue(user, project, issueId, status === 'rejected' ? 'the proposal was rejected' : 'the approval was taken back');
    issueId = null;
    issueRev = null;
  }
  writeJson(file, { status, rev: prop.rev, by: senderName(user), at: new Date().toISOString(), issueId, issueRev });
  return { ok: true, issueId };
}

/** The text of the one-shot job for an approved proposal (and its planned issue, if any). */
export function jobText(prop, issueId = null) {
  return [
    `Backlog item ${prop.pid} (revision ${prop.rev}), approved by the owner: ${prop.title}`,
    '',
    `Estimate: ${prop.minutes} minutes, $${prop.cost.toFixed(2)}, confidence ${prop.confidence}.`,
    prop.areas ? `Areas: ${prop.areas}` : null,
    prop.risk ? `Risk: ${prop.risk}` : null,
    prop.depends.length ? `Depends on: ${prop.depends.join(', ')}` : null,
    '',
    prop.text,
    '',
    issueId ? `Owner issue ${issueId} tracks this item: set it in_progress when you start and done when it has merged (owner-issues update).` : null,
    issueId ? '' : null,
    'Do this item as proposed. If it turns out much larger than the estimate, land what is safe, reply `planned` and say what is left.'
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function approvedProposal(project, pid) {
  if (!PID_RE.test(pid)) throw new Error('Bad proposal id');
  const prop = proposal(project, pid);
  if (!prop) throw new Error('No such proposal');
  const d = readJson(path.join(decisionsDir(project), `${pid}.json`));
  if (d?.status !== 'approved' || d.rev !== prop.rev) throw new Error('Approve this revision first');
  const issueId = d.issueId && d.issueRev === prop.rev && getIssue(project, d.issueId) ? d.issueId : null;
  return { prop, issueId };
}

/** Run an approved item now: a one-shot job whose text is the proposal. */
export async function runNow(user, project, pid, oneshot) {
  const { prop, issueId } = approvedProposal(project, pid);
  const out = await oneshot(user, project, { text: jobText(prop, issueId), attachments: [] });
  const at = new Date().toISOString();
  writeJson(path.join(runsDir(project), `${pid}.json`), { jobId: out.id, rev: prop.rev, at, scheduledFor: null, minutes: prop.minutes });
  if (issueId) noteJob(project, issueId, { id: out.id, startedAt: at });
  return out;
}

/** Set an approved item for a time: the VM starts the job then (agent-kit-oneshot at). */
export async function runAt(user, project, pid, at) {
  const { prop, issueId } = approvedProposal(project, pid);
  const epoch = checkTime(at);
  const out = await scheduleOneshot(project, user, { text: jobText(prop, issueId), epoch });
  if (issueId && out.scheduled) noteJob(project, issueId, { id: out.id, scheduledFor: epoch });
  audit(user, project.id, 'job-at', { pid, id: out.id, at: new Date(epoch * 1000).toISOString() }, { ok: out.scheduled, detail: out.error });
  writeJson(path.join(runsDir(project), `${pid}.json`), { jobId: out.id, rev: prop.rev, at: new Date().toISOString(), scheduledFor: out.scheduled ? epoch : null, minutes: prop.minutes });
  invalidateStatus(project.id);
  return { ok: true, id: out.id, scheduled: out.scheduled, detail: out.scheduled ? 'Job set for that time.' : `No clear answer from the VM (${out.error}).` };
}

// ---- chat ----------------------------------------------------------------

export async function chatSay(user, project, plan, text) {
  if (!PLAN_RE.test(plan)) throw new Error('Bad plan id');
  const p = readJson(path.join(plansDir(project), `${plan}.json`));
  if (!p) throw new Error('No such planning session');
  if (p.ended) throw new Error('This chat was ended');
  const body = String(text || '').trim();
  if (!body) throw new Error('Write a message first');
  if (body.length > MAX_CHAT) throw new Error('Message is too long');
  const msg = `${stamp()}-c-${hex()}`;
  const res = await kit(project, 'agent-kit-chat', ['say', plan, msg, senderName(user)], { input: body, timeout: 60000 });
  const ok = res.code === 0;
  const error = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  audit(user, project.id, 'chat-say', { plan, msg }, { ok, detail: error });
  if (!ok && vmSaidNo(res.code)) throw new Error(error);
  writeJson(path.join(chatDir(project, plan), `${msg}.json`), { id: msg, by: senderName(user), at: new Date().toISOString(), text: body, delivered: ok, error });
  invalidateStatus(project.id);
  return { ok: true, id: msg, delivered: ok, detail: ok ? 'Sent. The lead answers in a minute or two.' : `No clear answer from the VM (${error}).` };
}

export async function chatEnd(user, project, plan) {
  if (!PLAN_RE.test(plan)) throw new Error('Bad plan id');
  const file = path.join(plansDir(project), `${plan}.json`);
  const p = readJson(file);
  if (!p) throw new Error('No such planning session');
  const res = await kit(project, 'agent-kit-chat', ['end', plan]);
  const ok = res.code === 0;
  audit(user, project.id, 'chat-end', { plan }, { ok, detail: ok ? null : (res.stderr || '').trim().slice(-200) });
  if (!ok) throw new Error((res.stderr || 'could not end the chat on the VM').trim().slice(-200));
  writeJson(file, { ...p, ended: true, endedAt: new Date().toISOString() });
  return { ok: true };
}

// ---- reading ---------------------------------------------------------------

function knownPlans(project) {
  return new Set(names(plansDir(project), PLAN_RE));
}

function proposal(project, pid) {
  return parseProposal(path.join(outDir(project), `${pid}.md`), pid, knownPlans(project));
}

function ledger(project) {
  const file = path.join(project.paths?.fleet || '', 'cycles.jsonl');
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .slice(-2000)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && typeof l === 'object');
  } catch {
    return [];
  }
}

const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 && v < 10_000 ? v : null);

/** Everything the Backlog tab shows, newest plan first. */
export function list(project, status = null) {
  const plans = knownPlans(project);
  const lines = ledger(project);
  const props = [];
  for (const pid of names(outDir(project), PID_RE, '.md')) {
    const p = parseProposal(path.join(outDir(project), `${pid}.md`), pid, plans);
    if (!p) continue;
    const d = readJson(path.join(decisionsDir(project), `${pid}.json`));
    const run = readJson(path.join(runsDir(project), `${pid}.json`));
    let state = 'new';
    if (d && d.status !== 'new') state = d.rev === p.rev ? d.status : `revised`;
    let taken = false;
    try {
      taken = fs.lstatSync(path.join(outDir(project), 'taken', pid)).isFile();
    } catch {
      /* not taken */
    }
    props.push({
      ...p,
      state,
      decidedRev: d?.rev ?? null,
      taken,
      run: run && typeof run.jobId === 'string' ? { jobId: run.jobId, rev: run.rev, at: run.at, scheduledFor: run.scheduledFor || null, cancelled: !!run.cancelled } : null
    });
  }
  const ids = [...plans].sort().reverse();
  const newest = ids[0] || null;
  const busy = status?.oneshot?.id || null;
  const out = ids.map((id) => {
    const p = readJson(path.join(plansDir(project), `${id}.json`)) || {};
    const mine = props.filter((x) => x.plan === id).sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || (a.pid < b.pid ? -1 : 1));
    const cycle = lines.filter((l) => l.plan === id);
    const planLine = cycle.find((l) => l.kind === 'plan') || null;
    const chat = names(chatDir(project, id), MSG_RE).map((msg) => {
      const m = readJson(path.join(chatDir(project, id), `${msg}.json`)) || {};
      const r = parseHeaderFile(path.join(outDir(project), 'chat', id, `${msg}.md`), 40_000);
      const reply = r && r.fields.re === msg && /^(ok|error)$/.test(r.fields.status || '') ? { status: r.fields.status, date: r.fields.date || null, text: r.body.slice(0, 20000) } : null;
      const line = cycle.find((l) => l.kind === 'chat' && l.chat === msg);
      return { id: msg, by: m.by || null, at: m.at || null, text: typeof m.text === 'string' ? m.text : '', delivered: !!m.delivered, error: m.error || null, reply, cost: num(line?.cost_usd) };
    });
    return {
      id,
      focus: typeof p.focus === 'string' ? p.focus : '',
      by: p.by || null,
      askedAt: p.askedAt || null,
      scheduledFor: p.scheduledFor || null,
      cancelled: !!p.cancelled,
      error: p.error || null,
      ended: !!p.ended,
      newest: id === newest,
      running: busy === id,
      done: !!planLine,
      cost: num(planLine?.cost_usd),
      minutes: num(planLine?.secs) != null ? Math.round(planLine.secs / 60) : null,
      chatCost: cycle.filter((l) => l.kind === 'chat').reduce((s, l) => s + (num(l.cost_usd) || 0), 0),
      touchedCode: cycle.some((l) => l.touched_code === true),
      waiting: chat.some((c) => c.delivered && !c.reply),
      proposals: mine,
      chat
    };
  });
  return { plans: out, chatBusy: !!status?.chat };
}

/**
 * Backlog jobs for the Schedule timeline: approved items that run or are set
 * for a time, and planning cycles set for a time. Built from this console's
 * own run records (agent-written data is only read for titles and estimates),
 * the VM's status (jobs set for a time, the job running) and the ledger.
 *   [{id, kind:'job'|'plan', pid, order, title, minutes, cost, start, estEnd, end, state:'set'|'running'|'done'}]
 * Times are ms. `estEnd` is the start plus the estimate; `end` the real end.
 */
export function jobsFor(project, status = null, now = Date.now()) {
  const plans = knownPlans(project);
  const lines = ledger(project);
  const atJobs = Array.isArray(status?.atJobs) ? status.atJobs : [];
  const atById = new Map(atJobs.map((j) => [j.id, j]));
  const running = status?.oneshot?.id || null;
  const runningSince = Date.parse(status?.oneshot?.since || '');
  const out = [];
  const add = (job) => {
    if (!Number.isFinite(job.start)) return;
    job.estEnd = job.start + job.minutes * 60000;
    out.push(job);
  };
  for (const pid of names(runsDir(project), PID_RE)) {
    const run = readJson(path.join(runsDir(project), `${pid}.json`));
    if (!run || typeof run.jobId !== 'string' || !/^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(run.jobId) || run.cancelled) continue;
    const prop = parseProposal(path.join(outDir(project), `${pid}.md`), pid, plans);
    const minutes = prop?.minutes || (Number.isInteger(run.minutes) && run.minutes > 0 && run.minutes <= 90 ? run.minutes : 60);
    const base = {
      id: run.jobId,
      kind: 'job',
      pid,
      order: prop?.order ?? null,
      title: prop?.title || 'Backlog item',
      minutes,
      cost: prop?.cost ?? null,
      end: null,
      // For the job's pop-up on the Schedule page: the proposal as checked here.
      prop: prop ? { order: prop.order, title: prop.title, minutes: prop.minutes, cost: prop.cost, confidence: prop.confidence, areas: prop.areas, risk: prop.risk, rev: prop.rev, text: prop.text } : null
    };
    const line = lines.findLast((l) => l.oneshot === run.jobId);
    if (line) {
      add({ ...base, state: 'done', start: Date.parse(line.start), end: Date.parse(line.end) });
    } else if (running === run.jobId) {
      add({ ...base, state: 'running', start: Number.isFinite(runningSince) ? runningSince : Date.parse(run.at) });
    } else if (atById.has(run.jobId)) {
      add({ ...base, state: 'set', start: atById.get(run.jobId).at * 1000 });
    } else if (!run.scheduledFor && Date.parse(run.at) > now - 15 * 60000) {
      // Just sent with Run now: the VM's status may not show it yet.
      add({ ...base, state: 'running', start: Date.parse(run.at) });
    }
  }
  // Planning cycles set for a time, or running now.
  const planSecs = lines.filter((l) => l.kind === 'plan' && num(l.secs) != null).map((l) => l.secs).sort((x, y) => x - y);
  const planMinutes = planSecs.length ? Math.max(1, Math.round(planSecs[Math.floor(planSecs.length / 2)] / 60)) : 5;
  for (const id of plans) {
    const base = { id, kind: 'plan', pid: null, order: null, title: 'Planning cycle', minutes: planMinutes, cost: null, end: null };
    if (running === id) add({ ...base, state: 'running', start: Number.isFinite(runningSince) ? runningSince : now });
    else if (atById.has(id)) add({ ...base, state: 'set', start: atById.get(id).at * 1000 });
  }
  return out.sort((x, y) => x.start - y.start);
}

const syncState = new Map();

/** Pull the lead's proposals and answers; throttled, never throws. */
export function syncBacklog(project, { force = false } = {}) {
  const s = syncState.get(project.id) || { at: 0, pending: null };
  if (s.pending) return s.pending;
  if (!force && Date.now() - s.at < SYNC_EVERY) return Promise.resolve();
  fs.mkdirSync(outDir(project), { recursive: true });
  const pending = pull(project, [`${project.kit.state}/backlog-out/`], outDir(project), {
    as: 'agent',
    maxSize: '1m',
    timeout: 60000,
    filters: ['--exclude=.*.tmp']
  })
    .catch(() => {})
    .finally(() => syncState.set(project.id, { at: Date.now(), pending: null }));
  syncState.set(project.id, { ...s, pending });
  return pending;
}
