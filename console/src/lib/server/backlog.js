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
// Estimates, dependencies and the overrun brake on the VM.
export const BRAKE_KIT = '0.18.0';
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
// The owner's choice of model for a job's tech lead, where it differs from the lead's (kit 0.22).
const modelsDir = (project) => path.join(dirFor(project), 'models');
const MODELS = ['sonnet', 'opus'];
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
/**
 * Give one start of the team's schedule to a backlog job (kit 0.14.1): that
 * start is skipped once, with a line in the schedule log. `skip` is
 * {slot: 'days@HH:MM', date: 'YYYY-MM-DD'} in the schedule's own time zone.
 */
async function skipStart(user, project, skip) {
  if (!skip) return;
  const slot = String(skip.slot || '');
  const date = String(skip.date || '');
  if (!/^[a-z,]{3,27}@[0-9]{2}:[0-9]{2}$/.test(slot) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad start time to skip');
  const res = await kit(project, 'agent-kit-schedule', ['skip', slot, date]);
  const ok = res.code === 0;
  audit(user, project.id, 'schedule-skip', { slot, date }, { ok, detail: ok ? null : (res.stderr || '').trim().slice(-200) });
  if (!ok) throw new Error(`The job is set, but that cycle could not be skipped: ${(res.stderr || `exit ${res.code}`).trim().slice(-200)}`);
}

export const CAP_KIT = '0.15.0'; // the owner's cap on proposals per plan

export async function startPlan(user, project, { focus = '', at = null, skip = null, maxProposals = null, kitVersion = null } = {}) {
  const text = String(focus || '').trim();
  if (text.length > MAX_FOCUS) throw new Error('The focus text is too long');
  let max = null;
  if (maxProposals != null && maxProposals !== '') {
    max = Number(maxProposals);
    if (!Number.isInteger(max) || max < 1 || max > 8) throw new Error('At most 1 to 8 proposals');
  }
  // Kit 0.15 reads the cap from the request's first line; older kits would show it as focus text.
  let input = text;
  if (max) {
    const kv = kitVersion || peekStatus(project.id)?.kitVersion || (await getStatus(project).catch(() => null))?.kitVersion;
    if (atLeast(kv, CAP_KIT)) input = `Max-proposals: ${max}\n${text}`;
  }
  const id = `${stamp()}-p-${hex()}`;
  const from = senderName(user);
  let epoch = null;
  if (at != null) epoch = checkTime(at);
  const argv = epoch ? ['at', String(epoch), id, from, '--plan'] : ['start', id, from, '--plan'];
  const res = await kit(project, 'agent-kit-oneshot', argv, { input, timeout: 120000 });
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
  if (started && epoch) await skipStart(user, project, skip);
  const plan = {
    id,
    focus: text,
    maxProposals: max,
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
export async function moveAt(user, project, id, at, skip = null) {
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
  await skipStart(user, project, skip);
  invalidateStatus(project.id);
  return { ok: true, detail: skip ? 'Moved, and that cycle is skipped.' : 'Moved.' };
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
    // The model the lead would give this job's tech lead (kit 0.22), or null.
    model: MODELS.includes(f.model) ? f.model : null,
    text: p.body.slice(0, 8000)
  };
}

/** The owner's own choice of model for a proposal's tech lead, or null (the lead's pick stands). */
export function ownerModel(project, pid) {
  if (!PID_RE.test(pid || '')) return null;
  const m = readJson(path.join(modelsDir(project), `${pid}.json`))?.model;
  return MODELS.includes(m) ? m : null;
}

/** Choose the model for a proposal's tech lead; `lead` gives the choice back to the lead. */
export function setModel(user, project, pid, model) {
  if (!PID_RE.test(pid)) throw new Error('Bad proposal id');
  if (!MODELS.includes(model) && model !== 'lead') throw new Error('Choose sonnet or opus');
  const prop = proposal(project, pid);
  if (!prop) throw new Error('No such proposal');
  const run = readJson(path.join(runsDir(project), `${pid}.json`));
  if (run && typeof run.jobId === 'string' && !run.cancelled && run.rev === prop.rev) throw new Error('This job was already started or set for a time');
  const file = path.join(modelsDir(project), `${pid}.json`);
  if (model === 'lead' || model === prop.model) fs.rmSync(file, { force: true });
  else writeJson(file, { model, by: senderName(user), at: new Date().toISOString() });
  audit(user, project.id, 'backlog-model', { pid, model, proposed: prop.model }, { ok: true, detail: null });
  return { ok: true, model: ownerModel(project, pid) };
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
        body: jobText(prop, null, ownerModel(project, pid)),
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
export function jobText(prop, issueId = null, chosen = null) {
  const model =
    chosen && chosen !== prop.model
      ? `Model for this job's tech lead: ${chosen}. This is the owner's choice${prop.model ? ` (you proposed ${prop.model})` : ''}: start that agent with model "${chosen}".`
      : prop.model
        ? `Model for this job's tech lead: ${prop.model}, as you proposed.`
        : null;
  return [
    `Backlog item ${prop.pid} (revision ${prop.rev}), approved by the owner: ${prop.title}`,
    '',
    `Estimate: ${prop.minutes} minutes, $${prop.cost.toFixed(2)}, confidence ${prop.confidence}.`,
    prop.areas ? `Areas: ${prop.areas}` : null,
    prop.risk ? `Risk: ${prop.risk}` : null,
    prop.depends.length ? `Depends on: ${prop.depends.join(', ')}` : null,
    model,
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

/**
 * What the VM is told about a backlog job (kit 0.18): its estimate, the jobs it
 * builds on (the proposal's Depends, for those that have a job), and the
 * owner's "no time limit". Nothing for an older kit, which would refuse the flags.
 */
let kitOverride = null; // the kit's own tests have no VM to ask
function flagsFor(project, prop, { noBrake = false } = {}) {
  if (!atLeast(kitOverride ?? peekStatus(project.id)?.kitVersion, BRAKE_KIT)) return { flags: [], after: [], unplaced: [] };
  const after = [];
  const unplaced = [];
  for (const dep of prop.depends) {
    const run = readJson(path.join(runsDir(project), `${dep}.json`));
    if (run && typeof run.jobId === 'string' && /^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(run.jobId) && !run.cancelled) after.push(run.jobId);
    else unplaced.push(dep);
  }
  const flags = ['--minutes', String(prop.minutes), ...(noBrake ? ['--no-brake'] : []), ...(after.length ? ['--after', after.join(',')] : [])];
  return { flags, after, unplaced };
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
export async function runNow(user, project, pid, oneshot, { noBrake = false } = {}) {
  const { prop, issueId } = approvedProposal(project, pid);
  const { flags } = flagsFor(project, prop, { noBrake });
  const out = await oneshot(user, project, { text: jobText(prop, issueId, ownerModel(project, pid)), attachments: [], flags });
  const at = new Date().toISOString();
  writeJson(path.join(runsDir(project), `${pid}.json`), { jobId: out.id, rev: prop.rev, at, scheduledFor: null, minutes: prop.minutes, noBrake: !!noBrake });
  if (issueId) noteJob(project, issueId, { id: out.id, startedAt: at });
  return out;
}

/** Set an approved item for a time: the VM starts the job then (agent-kit-oneshot at). */
export async function runAt(user, project, pid, at, skip = null, { noBrake = false } = {}) {
  const { prop, issueId } = approvedProposal(project, pid);
  const epoch = checkTime(at);
  const { flags, after, unplaced } = flagsFor(project, prop, { noBrake });
  const out = await scheduleOneshot(project, user, { text: jobText(prop, issueId, ownerModel(project, pid)), epoch, flags });
  if (out.scheduled) await skipStart(user, project, skip);
  if (issueId && out.scheduled) noteJob(project, issueId, { id: out.id, scheduledFor: epoch });
  audit(user, project.id, 'job-at', { pid, id: out.id, at: new Date(epoch * 1000).toISOString() }, { ok: out.scheduled, detail: out.error });
  writeJson(path.join(runsDir(project), `${pid}.json`), { jobId: out.id, rev: prop.rev, at: new Date().toISOString(), scheduledFor: out.scheduled ? epoch : null, minutes: prop.minutes, noBrake: !!noBrake, after });
  invalidateStatus(project.id);
  // What it builds on has no job yet: the VM cannot wait for something it does not know.
  const loose = unplaced.length ? ` It builds on ${unplaced.length === 1 ? 'an item that has' : `${unplaced.length} items that have`} no job yet: it will not wait for ${unplaced.length === 1 ? 'it' : 'them'}.` : '';
  const waits = after.length ? ` It starts once what it builds on has merged.` : '';
  return { ok: true, id: out.id, scheduled: out.scheduled, detail: out.scheduled ? `Job set for that time.${waits}${loose}` : `No clear answer from the VM (${out.error}).` };
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
  // Whoever writes the next message has read the answers before it.
  chatSeen(project, plan);
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

// ---- answers the owner has not read yet -----------------------------------

const seenFile = (project, plan) => path.join(chatDir(project, plan), 'seen.json');

/** Ids of the messages of a plan's chat that the lead has answered, oldest first. */
function answered(project, plan) {
  return names(chatDir(project, plan), MSG_RE).filter((msg) => {
    const r = parseHeaderFile(path.join(outDir(project), 'chat', plan, `${msg}.md`), 40_000);
    return !!r && r.fields.re === msg && /^(ok|error)$/.test(r.fields.status || '');
  });
}

/** The newest planning session, if its chat is still open: its id, or null. */
function openChatPlan(project) {
  const newest = names(plansDir(project), PLAN_RE).sort().at(-1);
  if (!newest) return null;
  return readJson(path.join(plansDir(project), `${newest}.json`))?.ended ? null : newest;
}

/** Answers the owner has seen: the ids kept in the plan's seen mark. */
function seenIds(project, plan) {
  const ids = readJson(seenFile(project, plan))?.ids;
  return new Set(Array.isArray(ids) ? ids.filter((id) => MSG_RE.test(id)) : []);
}

/** The owner has seen every answer the chat of this plan has now. */
export function chatSeen(project, plan) {
  if (!PLAN_RE.test(plan)) throw new Error('Bad plan id');
  const done = answered(project, plan);
  const seen = seenIds(project, plan);
  if (done.some((id) => !seen.has(id))) writeJson(seenFile(project, plan), { ids: done, at: new Date().toISOString() });
  return { ok: true };
}

/**
 * How many answers of the lead in the newest plan's chat the owner has not
 * seen. 0 while an answer is still on its way: the lead is not waiting then.
 * Reads only what the console already pulled.
 */
export function chatUnread(project, status = null) {
  if (status?.chat) return 0;
  const plan = openChatPlan(project);
  if (!plan) return 0;
  const done = answered(project, plan);
  if (!done.length) return 0;
  // A message that was delivered and has no answer yet: a turn is running or about to.
  const open = names(chatDir(project, plan), MSG_RE).some((msg) => !done.includes(msg) && readJson(path.join(chatDir(project, plan), `${msg}.json`))?.delivered);
  if (open) return 0;
  const seen = seenIds(project, plan);
  return done.filter((msg) => !seen.has(msg)).length;
}

// ---- reading ---------------------------------------------------------------

function knownPlans(project) {
  return new Set(names(plansDir(project), PLAN_RE));
}

function proposal(project, pid) {
  return parseProposal(path.join(outDir(project), `${pid}.md`), pid, knownPlans(project));
}

/** Ids of jobs set for a time that the VM dropped (`job:<id> <date> missed…` in schedule.log). */
/**
 * The approved proposal a one-shot job does, from this console's own run record:
 * {pid, order, title, minutes, cost, issueId}, or null. Title and estimate are
 * the proposal's (agent-written, checked by parseProposal).
 */
export function itemForJob(project, jobId) {
  if (!/^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(jobId || '')) return null;
  for (const pid of names(runsDir(project), PID_RE)) {
    const run = readJson(path.join(runsDir(project), `${pid}.json`));
    if (run?.jobId !== jobId) continue;
    const prop = proposal(project, pid);
    const d = readJson(path.join(decisionsDir(project), `${pid}.json`));
    return {
      pid,
      order: prop?.order ?? null,
      title: prop?.title || 'Planned job',
      minutes: prop?.minutes || (Number.isInteger(run.minutes) && run.minutes > 0 && run.minutes <= 90 ? run.minutes : null),
      cost: prop?.cost ?? null,
      issueId: typeof d?.issueId === 'string' ? d.issueId : null
    };
  }
  return null;
}

/** What the owner asked a planning cycle to look at: {id, focus}, or null. */
export function planRequest(project, id) {
  if (!PLAN_RE.test(id || '')) return null;
  const p = readJson(path.join(plansDir(project), `${id}.json`));
  return p ? { id, focus: typeof p.focus === 'string' ? p.focus : '' } : null;
}

function missedJobs(project) {
  const out = new Set();
  let text = '';
  try {
    text = fs.readFileSync(path.join(project.paths?.fleet || '', 'schedule.log'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n').slice(-600)) {
    const m = /^\S+ job:([0-9]{8}T[0-9]{6}Z-[op]-[a-z0-9-]{1,40}) \S+ missed/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
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
  const missed = missedJobs(project);
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
      ownerModel: ownerModel(project, pid),
      decidedRev: d?.rev ?? null,
      taken,
      run:
        run && typeof run.jobId === 'string'
          ? {
              jobId: run.jobId,
              rev: run.rev,
              at: run.at,
              scheduledFor: run.scheduledFor || null,
              cancelled: !!run.cancelled,
              missed: missed.has(run.jobId),
              // The overrun brake ended it at twice its estimate (kit 0.18): minutes it ran, or null.
              stopped: (() => {
                const l = lines.findLast((x) => x.oneshot === run.jobId);
                return l?.overrun === true ? Math.round((num(l.secs) || 0) / 60) : null;
              })()
            }
          : null
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
  const missed = missedJobs(project);
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
      title: prop?.title || 'Planned job',
      minutes,
      cost: prop?.cost ?? null,
      end: null,
      // The jobs it builds on, and the owner's "no time limit" (kit 0.18).
      after: Array.isArray(run.after) ? run.after.filter((x) => typeof x === 'string' && /^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(x)).slice(0, 10) : [],
      noBrake: run.noBrake === true,
      wait: null,
      // For the job's pop-up on the Schedule page: the proposal as checked here.
      prop: prop ? { order: prop.order, title: prop.title, minutes: prop.minutes, cost: prop.cost, confidence: prop.confidence, areas: prop.areas, risk: prop.risk, rev: prop.rev, text: prop.text } : null
    };
    const line = lines.findLast((l) => l.oneshot === run.jobId);
    if (line) {
      // `stopped`: the overrun brake ended it at twice its estimate.
      add({ ...base, state: 'done', start: Date.parse(line.start), end: Date.parse(line.end), stopped: line.overrun === true });
    } else if (running === run.jobId) {
      add({ ...base, state: 'running', start: Number.isFinite(runningSince) ? runningSince : Date.parse(run.at) });
    } else if (atById.has(run.jobId)) {
      // `wait`: its time has come and it has not started; why, as the VM says.
      add({ ...base, state: 'set', start: atById.get(run.jobId).at * 1000, wait: atById.get(run.jobId).wait || null });
    } else if (run.scheduledFor && missed.has(run.jobId)) {
      // The team was busy for hours after the set time: the VM dropped it.
      add({ ...base, state: 'missed', start: run.scheduledFor * 1000 });
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
  // The job a waiting one waits for, by what the owner calls it.
  const byId = new Map(out.map((j) => [j.id, j]));
  for (const j of out) {
    const on = j.wait?.job ? byId.get(j.wait.job) : null;
    if (j.wait) j.wait = { reason: j.wait.reason, job: j.wait.job || null, title: on?.title || null, order: on?.order ?? null };
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

export const _test = {
  setKit: (version) => {
    kitOverride = version;
  }
};
