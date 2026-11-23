// Owner issues: tickets for the lead, raised from a gallery screenshot with
// markup drawn on it, or on the Issues page with a picture and files of the
// owner's own. Separate from the inbox: the inbox is a
// conversation, an issue is a unit of work the lead triages and delegates.
//
// Stored locally under DATA_DIR/issues/<project>/<id>/ (issue.json, shot.png,
// markup.png, att/<files>) and delivered to the VM with the kit's `agent-kit-issues`
// script. The lead's status updates come back by pulling `issues-out/`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { kit, pull } from './ssh.js';
import { parseHeaderFile } from './headerfile.js';
import { peekStatus, kitAtLeast } from './live.js';
import { screenKey } from './aggregate.js';

export { screenKey };

// The kinds the owner raises. `planned` (kit 0.11) is made by the console when
// the owner approves a backlog proposal: see createPlanned.
export const KINDS = ['bug', 'polish', 'idea'];
export const PLANNED = 'planned';
export const PLANNED_KIT = '0.11.0';
const PID_RE = /^[0-9]{8}T[0-9]{6}Z-b-[a-f0-9]{6}$/;
const PLAN_RE = /^[0-9]{8}T[0-9]{6}Z-p-[a-z0-9-]{1,40}$/;
// Tickets (kit 0.12): a number per team, a priority, edits, notes, files added later.
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const ISSUES_KIT = '0.12.0';
const SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_DONE_WHEN = 1000;
const MAX_NOTE = 8000;
const MAX_RELATED = 10;
export const STATUSES = ['new', 'in_progress', 'done', 'wontfix'];
export const OPEN = ['new', 'in_progress'];
const ID_RE = /^[0-9]{8}T[0-9]{6}Z-i-[a-f0-9]{6}$/;
const SCREEN_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHOT_SHA_RE = /^[0-9a-f]{40}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.png$/;
const MAX_TEXT = 20_000;
const MAX_PNG = 8 * 1024 * 1024;
const MAX_SHAPES = 200;
const SYNC_EVERY = 15_000;
// Attachments (kit 0.7): same rules as agent-kit-issues on the VM.
export const ATT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const MAX_ATT = 20 * 1024 * 1024;
export const MAX_FILES = 8;
export const MAX_UPLOAD = 15 * 1024 * 1024; // all files of one issue together

/** A file name the VM accepts: "My shot (2).PNG" -> "My-shot-2-.PNG". Empty when nothing is left. */
export function safeName(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 100);
  return ATT_NAME_RE.test(base) ? base : '';
}

const rootFor = (project) => path.join(DATA_DIR, 'issues', project.id);
const dirFor = (project, id) => path.join(rootFor(project), id);
const outDir = (project) => path.join(rootFor(project), '.out');
const counterFile = (project) => path.join(rootFor(project), '.counter');

/** Does this team's VM take numbers, priorities, edits and notes (kit 0.12)? */
export const kitHasTickets = (project) => kitAtLeast(peekStatus(project.id)?.kitVersion, ISSUES_KIT);

// Numbers are given here, one after another per team. All of this runs
// synchronously in one process, so two issues raised at once cannot get the
// same number.
function nextNumber(project) {
  let n = Number(String(readText(counterFile(project))).trim()) || 0;
  for (const id of ids(project)) n = Math.max(n, readJson(path.join(dirFor(project, id), 'issue.json'))?.number || 0);
  n += 1;
  fs.mkdirSync(rootFor(project), { recursive: true });
  fs.writeFileSync(counterFile(project), `${n}\n`);
  return n;
}
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
function ids(project) {
  try {
    return fs.readdirSync(rootFor(project)).filter((n) => ID_RE.test(n));
  } catch {
    return [];
  }
}
/** Issues from before kit 0.12 get their numbers once, oldest first. */
function ensureNumbers(project) {
  const missing = ids(project)
    .map((id) => readJson(path.join(dirFor(project, id), 'issue.json')))
    .filter((i) => i && !Number.isInteger(i.number))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  for (const i of missing) {
    i.number = nextNumber(project);
    i.priority ||= 'normal';
    writeJson(path.join(dirFor(project, i.id), 'issue.json'), i);
  }
}

/** Related issue numbers: up to 10 numbers of this team's own issues. */
function cleanRelated(project, list, self = null) {
  if (list == null) return [];
  const raw = Array.isArray(list) ? list : String(list).split(/[\s,]+/);
  const known = new Set(ids(project).map((id) => readJson(path.join(dirFor(project, id), 'issue.json'))?.number).filter(Number.isInteger));
  const out = [];
  for (const r of raw) {
    const s = String(r).trim().replace(/^#/, '');
    if (!s) continue;
    const n = Number(s);
    if (!/^\d{1,6}$/.test(s) || !known.has(n)) throw new Error(`No issue #${s} on this team`);
    if (n !== self && !out.includes(n)) out.push(n);
  }
  if (out.length > MAX_RELATED) throw new Error(`At most ${MAX_RELATED} related issues`);
  return out;
}


function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const num = (v) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Keep only well-formed shapes with coordinates normalised to 0..1. */
export function cleanMarkup(shapes) {
  if (!Array.isArray(shapes)) return [];
  const out = [];
  for (const s of shapes.slice(0, MAX_SHAPES)) {
    if (!s || typeof s !== 'object') continue;
    const color = COLOR_RE.test(s.color) ? s.color : '#ff3b3b';
    if (s.type === 'rect' || s.type === 'ellipse') {
      out.push({ type: s.type, color, x: num(s.x), y: num(s.y), w: num(s.w), h: num(s.h) });
    } else if (s.type === 'path' && Array.isArray(s.points)) {
      const points = s.points.slice(0, 2000).map((p) => [num(p?.[0]), num(p?.[1])]);
      if (points.length > 1) out.push({ type: 'path', color, points });
    }
  }
  return out;
}

const isPng = (buf) => buf && buf.length > 8 && buf.length <= MAX_PNG && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

/**
 * Raise an issue. `origin` is {type:'gallery', date, file} or {type:'upload',
 * name} (a picture the owner attached on the Issues page). `shot` is the
 * screenshot file to keep a copy of, or `shotPng` the picture itself;
 * `markupPng` the flattened drawing; `attachments` [{name, data}] more files.
 */
export async function create(
  project,
  user,
  { title, body, kind, origin, markup, shot = null, shotPng = null, markupPng = null, attachments = [], priority = 'normal', doneWhen = '', related = [] },
  { deliverNow = true } = {}
) {
  const t = String(title || '').trim().slice(0, 200);
  if (!t) throw new Error('Give the issue a title');
  const text = String(body || '').trim();
  if (text.length > MAX_TEXT) throw new Error('Description is too long');
  if (!KINDS.includes(kind)) throw new Error('Unknown kind');
  if (!PRIORITIES.includes(priority)) throw new Error('Unknown priority');
  const dw = String(doneWhen || '').trim();
  if (dw.length > MAX_DONE_WHEN) throw new Error('"Done when" is too long');
  const rel = cleanRelated(project, related);
  let o = null;
  if (origin?.type === 'gallery') {
    // `date` names the gallery folder: a day (older kits) or a build's sha (kit 0.13).
    if (!(DATE_RE.test(origin.date || '') || SHOT_SHA_RE.test(origin.date || '')) || !FILE_RE.test(origin.file || '')) throw new Error('Bad screenshot');
    o = { type: 'gallery', date: origin.date, file: origin.file, screen: screenKey(origin.file) };
  } else if (origin?.type === 'upload') {
    o = { type: 'upload', name: safeName(origin.name) || 'picture.png' };
  } else if (origin != null) throw new Error('Unknown origin');
  if (markupPng && !isPng(markupPng)) throw new Error('Markup must be a PNG under 8 MB');
  if (shotPng && !isPng(shotPng)) throw new Error('The picture must be a PNG under 8 MB');
  if (!Array.isArray(attachments)) throw new Error('Bad attachments');
  if (attachments.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} attachments`);
  const names = new Set();
  let total = 0;
  for (const a of attachments) {
    if (!ATT_NAME_RE.test(a?.name || '') || names.has(a.name)) throw new Error(`Bad attachment name: ${a?.name}`);
    if (!Buffer.isBuffer(a.data) || !a.data.length || a.data.length > MAX_ATT) throw new Error(`Attachment empty or over 20 MB: ${a.name}`);
    names.add(a.name);
    total += a.data.length;
  }
  if (total + (shotPng?.length || 0) + (markupPng?.length || 0) > MAX_UPLOAD) throw new Error('All files together must stay under 15 MB');

  const id = `${stamp()}-i-${crypto.randomBytes(3).toString('hex')}`;
  const dir = dirFor(project, id);
  fs.mkdirSync(dir, { recursive: true });
  if (shot) fs.copyFileSync(shot, path.join(dir, 'shot.png'));
  else if (shotPng) fs.writeFileSync(path.join(dir, 'shot.png'), shotPng);
  if (markupPng) fs.writeFileSync(path.join(dir, 'markup.png'), markupPng);
  if (attachments.length) {
    fs.mkdirSync(path.join(dir, 'att'));
    for (const a of attachments) fs.writeFileSync(path.join(dir, 'att', a.name), a.data);
  }
  const now = new Date().toISOString();
  ensureNumbers(project);
  const issue = {
    id,
    number: nextNumber(project),
    title: t,
    body: text,
    kind,
    priority,
    doneWhen: dw,
    related: rel,
    notes: [],
    status: 'new',
    origin: o,
    markup: cleanMarkup(markup),
    attachments: attachments.map((a) => ({ name: a.name, size: a.data.length })),
    by: user?.name || 'owner',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, to: 'new', who: user?.name || 'owner', note: 'raised' }],
    resolution: null,
    delivered: false,
    error: null
  };
  writeJson(path.join(dir, 'issue.json'), issue);
  return deliverNow ? deliver(project, id) : issue;
}

/**
 * The issue for an approved backlog proposal: kind `planned`, its text is the
 * job the proposal describes. Normal cycles leave it alone (kit 0.11); the
 * one-shot job that names it sets it in progress and done.
 */
export async function createPlanned(project, user, { title, body, proposal }, { deliverNow = true } = {}) {
  const t = String(title || '').trim().slice(0, 200);
  if (!t) throw new Error('A planned issue needs a title');
  const text = String(body || '').trim().slice(0, MAX_TEXT);
  if (!PID_RE.test(proposal?.pid || '') || !PLAN_RE.test(proposal?.plan || '') || !Number.isInteger(proposal?.rev)) throw new Error('Bad proposal');
  const id = `${stamp()}-i-${crypto.randomBytes(3).toString('hex')}`;
  const dir = dirFor(project, id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const who = user?.name || 'owner';
  ensureNumbers(project);
  const issue = {
    id,
    number: nextNumber(project),
    priority: 'normal',
    doneWhen: '',
    related: [],
    notes: [],
    title: t,
    body: text,
    kind: PLANNED,
    status: 'new',
    origin: null,
    markup: [],
    attachments: [],
    proposal: { pid: proposal.pid, rev: proposal.rev, plan: proposal.plan },
    job: null,
    by: who,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, to: 'new', who, note: `approved backlog item ${proposal.pid} (revision ${proposal.rev})` }],
    resolution: null,
    delivered: false,
    error: null
  };
  writeJson(path.join(dir, 'issue.json'), issue);
  return deliverNow ? deliver(project, id) : issue;
}

/** The job that does a planned issue: its id and when it was set for or started (console-side only). */
export function noteJob(project, id, job) {
  const issue = get(project, id);
  if (!issue || issue.kind !== PLANNED) return null;
  issue.job = {
    id: /^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(job?.id || '') ? job.id : null,
    scheduledFor: Number.isInteger(job?.scheduledFor) ? job.scheduledFor : null,
    startedAt: typeof job?.startedAt === 'string' ? job.startedAt : null
  };
  writeJson(path.join(dirFor(project, id), 'issue.json'), issue);
  return issue;
}

export function get(project, id) {
  if (!ID_RE.test(id)) return null;
  return readJson(path.join(dirFor(project, id), 'issue.json'));
}

function tarStream(dir) {
  const files = ['issue.md', ...['shot.png', 'markup.png', 'att'].filter((f) => fs.existsSync(path.join(dir, f)))];
  return spawn('tar', ['-c', '-C', dir, '--owner=0', '--group=0', ...files], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
}

/** What the lead reads: a plain-text ticket. */
export function issueText(issue) {
  const lines = [`# ${issue.title}`, '', `Kind: ${issue.kind}`];
  if (issue.origin?.type === 'gallery') lines.push(`Screen: ${issue.origin.screen} (gallery screenshot ${issue.origin.date}/${issue.origin.file})`);
  if (issue.origin?.type === 'upload') lines.push(`Picture: shot.png (attached by the owner as ${issue.origin.name})`);
  if (issue.markup?.length) lines.push(`Markup: ${issue.markup.length} shape(s) drawn by the owner, see markup.png`);
  if (issue.attachments?.length) lines.push(`Attachments (in att/): ${issue.attachments.map((a) => a.name).join(', ')}`);
  if (issue.doneWhen) lines.push(`Done when: ${issue.doneWhen}`);
  if (issue.related?.length) lines.push(`Related: ${issue.related.map((n) => `#${n}`).join(', ')}`);
  if (issue.kind === PLANNED && issue.proposal) lines.push(`Backlog item: ${issue.proposal.pid} (revision ${issue.proposal.rev}). Done by the one-shot job that names this issue.`);
  lines.push('', issue.body || '(no description)');
  return lines.join('\n') + '\n';
}

/** Push an issue to the VM (also used to retry). */
export async function deliver(project, id) {
  const issue = get(project, id);
  if (!issue) throw new Error('No such issue');
  if (issue.delivered) return issue;
  const dir = dirFor(project, id);
  fs.writeFileSync(path.join(dir, 'issue.md'), issueText(issue));
  // Numbers and priorities only for VMs that take them (kit 0.12); older ones get the plain put.
  const tickets = kitHasTickets(project) && Number.isInteger(issue.number);
  const extra = tickets ? ['--number', String(issue.number), '--priority', issue.priority || 'normal'] : [];
  const res = await kit(project, 'agent-kit-issues', ['put', id, issue.kind, ...extra], { inputStream: tarStream(dir), timeout: 300000 });
  issue.delivered = res.code === 0 || /already exists/.test(res.stderr || '');
  if (issue.delivered && tickets) {
    issue.vmNumbered = true;
    issue.pendingAmend = false;
  }
  issue.error = issue.delivered ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  writeJson(path.join(dir, 'issue.json'), issue);
  return issue;
}

/** The owner moves an issue (board drag, close, reopen). */
export async function setStatus(project, user, id, status, note = '') {
  if (!STATUSES.includes(status)) throw new Error('Unknown status');
  const issue = get(project, id);
  if (!issue) throw new Error('No such issue');
  if (issue.status === status) return issue;
  applyStatus(issue, status, user?.name || 'owner', String(note || '').slice(0, 2000));
  writeJson(path.join(dirFor(project, id), 'issue.json'), issue);
  if (issue.delivered) {
    // Tell the lead; a VM that is off just misses this, the console stays right.
    await kit(project, 'agent-kit-issues', ['set', id, status]).catch(() => {});
  }
  return issue;
}

function applyStatus(issue, status, who, note, extra = {}) {
  const at = extra.at || new Date().toISOString();
  issue.history.push({ at, from: issue.status, to: status, who, note });
  issue.status = status;
  issue.updatedAt = at;
  issue.resolution = OPEN.includes(status) ? null : { at, who, note, fixedShot: extra.fixedShot || null, fixedIn: extra.fixedIn || null };
}

/** All issues, newest first; `screen` filters to one gallery screen. */
export function list(project, { screen = null } = {}) {
  ensureNumbers(project);
  let names = [];
  try {
    names = fs.readdirSync(rootFor(project)).filter((n) => ID_RE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    const issue = get(project, id);
    if (!issue) continue;
    if (screen && issue.origin?.screen !== screen) continue;
    out.push({ ...issue, hasShot: fs.existsSync(path.join(dirFor(project, id), 'shot.png')), hasMarkup: fs.existsSync(path.join(dirFor(project, id), 'markup.png')) });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Per gallery screen: how many issues are open and resolved (for tile dots). */
export function screenIndex(project) {
  const idx = {};
  for (const i of list(project)) {
    const s = i.origin?.screen;
    if (!s) continue;
    idx[s] ||= { open: 0, resolved: 0 };
    if (OPEN.includes(i.status)) idx[s].open++;
    else idx[s].resolved++;
  }
  return idx;
}

export function openCount(project) {
  try {
    // Planned issues wait for their job: they are not something to look at.
    return list(project).filter((i) => OPEN.includes(i.status) && i.kind !== PLANNED).length;
  } catch {
    return 0;
  }
}

/** A file the owner attached to an issue (att/<name>), or null. */
export function attachment(project, id, name) {
  if (!ID_RE.test(id) || !ATT_NAME_RE.test(name || '')) return null;
  const file = path.join(dirFor(project, id), 'att', name);
  try {
    return fs.lstatSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** A stored image of an issue: shot.png or markup.png. */
export function image(project, id, name) {
  if (!ID_RE.test(id) || !['shot.png', 'markup.png'].includes(name)) return null;
  const file = path.join(dirFor(project, id), name);
  try {
    return fs.lstatSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}


const FIXED_RE = /^shots\/(\d{4}-\d{2}-\d{2}|[0-9a-f]{40})\/[A-Za-z0-9._-]+\.png$/;

/**
 * Apply the lead's updates from the pulled `issues-out/<id>.md` files. Each
 * update is applied once (keyed by its Date) and only moves an issue forward
 * in time: an owner change made after the lead's update wins.
 */
export function applyUpdates(project) {
  let names = [];
  try {
    names = fs.readdirSync(outDir(project));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    const issue = get(project, id);
    if (!issue) continue;
    const u = parseHeaderFile(path.join(outDir(project), name));
    if (!u) continue;
    const status = u.fields.status;
    const at = u.fields.date;
    if (!['in_progress', 'done', 'wontfix'].includes(status) || !at || isNaN(Date.parse(at))) continue;
    if (issue.leadUpdateAt === at) continue;
    issue.leadUpdateAt = at;
    if (Date.parse(at) >= Date.parse(issue.updatedAt) && issue.status !== status) {
      const fixedShot = FIXED_RE.test(u.fields['fixed-shot'] || '') ? u.fields['fixed-shot'] : null;
      const fixedIn = SHA_RE.test(u.fields['fixed-in'] || '') ? u.fields['fixed-in'] : null;
      applyStatus(issue, status, 'lead', u.body.slice(0, 4000), { at, fixedShot, fixedIn });
      n++;
    }
    writeJson(path.join(dirFor(project, id), 'issue.json'), issue);
  }
  return n;
}

const syncState = new Map();

/** Pull the lead's issue updates and apply them; throttled, never throws. */
export function syncIssues(project, { force = false } = {}) {
  const s = syncState.get(project.id) || { at: 0, pending: null };
  if (s.pending) return s.pending;
  if (!force && Date.now() - s.at < SYNC_EVERY) return Promise.resolve();
  fs.mkdirSync(outDir(project), { recursive: true });
  const pending = pull(project, [`${project.kit.state}/issues-out/`], outDir(project), { as: 'agent', maxSize: '1m', timeout: 60000, filters: ['--exclude=.*.tmp'] })
    .catch(() => {})
    .then(() => {
      try {
        applyUpdates(project);
      } catch {
        /* bad update files are skipped */
      }
      return backfillNumbers(project).catch(() => {});
    })
    .finally(() => syncState.set(project.id, { at: Date.now(), pending: null }));
  syncState.set(project.id, { ...s, pending });
  return pending;
}

// ---- tickets (kit 0.12) ---------------------------------------------------

/** Send the changed text (and any new files) to the VM. Never throws: a failure is kept on the issue. */
async function amend(project, issue, { kind = null, priority = null, files = [], quiet = false } = {}) {
  const dir = dirFor(project, issue.id);
  fs.writeFileSync(path.join(dir, 'issue.md'), issueText(issue));
  const argv = ['amend', issue.id];
  if (kind) argv.push('--kind', kind);
  if (priority) argv.push('--priority', priority);
  if (Number.isInteger(issue.number)) argv.push('--number', String(issue.number));
  if (quiet) argv.push('--quiet');
  const list = ['issue.md', ...files.map((f) => `att/${f}`)];
  const tar = spawn('tar', ['-c', '-C', dir, '--owner=0', '--group=0', ...list], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  const res = await kit(project, 'agent-kit-issues', argv, { inputStream: tar, timeout: 300000 });
  const ok = res.code === 0;
  const fresh = get(project, issue.id) || issue;
  fresh.pendingAmend = !ok;
  fresh.error = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  if (ok) fresh.vmNumbered = true;
  writeJson(path.join(dir, 'issue.json'), fresh);
  return fresh;
}

function needTickets(project, issue) {
  if (!issue) throw new Error('No such issue');
  if (issue.delivered && !kitHasTickets(project)) throw new Error(`Editing an issue needs kit ${ISSUES_KIT} on the VM`);
}

/**
 * The owner changes an issue: title, kind (not for a planned one), priority,
 * description, "done when", related issues. Each change goes into its history.
 */
export async function edit(project, user, id, changes = {}) {
  const issue = get(project, id);
  needTickets(project, issue);
  const who = user?.name || 'owner';
  const said = [];
  const set = (field, value, label = field) => {
    if (value === undefined || JSON.stringify(value) === JSON.stringify(issue[field])) return;
    said.push(label === 'description' || label === 'done when' ? `${label} changed` : `${label}: ${issue[field] ?? '—'} → ${value}`);
    issue[field] = value;
  };
  if (changes.title !== undefined) {
    const t = String(changes.title || '').trim().slice(0, 200);
    if (!t) throw new Error('Give the issue a title');
    set('title', t);
  }
  if (changes.kind !== undefined) {
    if (issue.kind === PLANNED || changes.kind === PLANNED) throw new Error('A planned issue keeps its kind');
    if (!KINDS.includes(changes.kind)) throw new Error('Unknown kind');
    set('kind', changes.kind);
  }
  if (changes.priority !== undefined) {
    if (!PRIORITIES.includes(changes.priority)) throw new Error('Unknown priority');
    set('priority', changes.priority);
  }
  if (changes.body !== undefined) {
    const b = String(changes.body || '').trim();
    if (b.length > MAX_TEXT) throw new Error('Description is too long');
    set('body', b, 'description');
  }
  if (changes.doneWhen !== undefined) {
    const d = String(changes.doneWhen || '').trim();
    if (d.length > MAX_DONE_WHEN) throw new Error('"Done when" is too long');
    set('doneWhen', d, 'done when');
  }
  if (changes.related !== undefined) set('related', cleanRelated(project, changes.related, issue.number), 'related');
  if (!said.length) return issue;
  const at = new Date().toISOString();
  issue.history.push({ at, to: issue.status, who, note: `edited: ${said.join('; ')}` });
  issue.updatedAt = at;
  writeJson(path.join(dirFor(project, id), 'issue.json'), issue);
  if (!issue.delivered) return issue; // it goes with the next delivery
  return amend(project, issue, { kind: issue.kind, priority: issue.priority || 'normal' });
}

/** Send a change that did not reach the VM (the VM was off). */
export async function resendAmend(project, id) {
  const issue = get(project, id);
  needTickets(project, issue);
  if (!issue.delivered) return deliver(project, id);
  return amend(project, issue, { kind: issue.kind, priority: issue.priority || 'normal' });
}

/** Files added to an issue after it was raised: [{name, data}]. */
export async function addFiles(project, user, id, files) {
  const issue = get(project, id);
  needTickets(project, issue);
  if (!Array.isArray(files) || !files.length) throw new Error('Add a file first');
  const have = issue.attachments || [];
  if (have.length + files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files on an issue`);
  let total = 0;
  const names = new Set(have.map((a) => a.name));
  for (const f of files) {
    if (!ATT_NAME_RE.test(f?.name || '') || names.has(f.name)) throw new Error(`Bad or repeated file name: ${f?.name}`);
    if (!Buffer.isBuffer(f.data) || !f.data.length || f.data.length > MAX_ATT) throw new Error(`File empty or over 20 MB: ${f.name}`);
    names.add(f.name);
    total += f.data.length;
  }
  if (total > MAX_UPLOAD) throw new Error('All files together must stay under 15 MB');
  const dir = dirFor(project, id);
  fs.mkdirSync(path.join(dir, 'att'), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, 'att', f.name), f.data);
  const at = new Date().toISOString();
  issue.attachments = [...have, ...files.map((f) => ({ name: f.name, size: f.data.length }))];
  issue.history.push({ at, to: issue.status, who: user?.name || 'owner', note: `added ${files.map((f) => f.name).join(', ')}` });
  issue.updatedAt = at;
  writeJson(path.join(dir, 'issue.json'), issue);
  if (!issue.delivered) return issue;
  return amend(project, issue, { files: files.map((f) => f.name) });
}

/** A note from the owner on an issue (the notes thread). */
export async function addNote(project, user, id, text) {
  const issue = get(project, id);
  needTickets(project, issue);
  const t = String(text || '').trim();
  if (!t) throw new Error('Write a note first');
  if (t.length > MAX_NOTE) throw new Error('The note is too long');
  const who = user?.name || 'owner';
  const note = { at: new Date().toISOString(), who, text: t, delivered: false, error: null };
  issue.notes = [...(issue.notes || []), note];
  issue.updatedAt = note.at;
  writeJson(path.join(dirFor(project, id), 'issue.json'), issue);
  if (!issue.delivered) return issue;
  const res = await kit(project, 'agent-kit-issues', ['note', id, /^[A-Za-z0-9._@-]{1,80}$/.test(who) ? who : 'owner'], { input: t });
  const fresh = get(project, id);
  const last = fresh.notes.at(-1);
  last.delivered = res.code === 0;
  last.error = last.delivered ? null : (res.stderr || `exit ${res.code}`).trim().slice(-200);
  writeJson(path.join(dirFor(project, id), 'issue.json'), fresh);
  return fresh;
}

/** The text of a "Fix now" one-shot job: names the issue, so the lead may work it. */
export function fixText(issue) {
  const notes = (issue.notes || []).slice(-3).map((n) => `- ${n.at.slice(0, 16).replace('T', ' ')} ${n.who}: ${n.text}`);
  return [
    `Fix owner issue #${issue.number} (${issue.id}): ${issue.title}`,
    '',
    `Kind: ${issue.kind}. Priority: ${issue.priority || 'normal'}.`,
    issue.doneWhen ? `Done when: ${issue.doneWhen}` : null,
    '',
    issue.body || '(no description)',
    notes.length ? '' : null,
    notes.length ? 'Latest notes from the owner:' : null,
    ...notes,
    '',
    `Read the whole issue with \`owner-issues show ${issue.id}\` (pictures and files are listed there).`,
    `Set it in_progress when you start and done when the fix has merged: owner-issues update ${issue.id} done --commit <sha>.`
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Fix now: one one-shot job for this issue (on a halted or idle team). */
export async function fixNow(user, project, id, oneshot) {
  const issue = get(project, id);
  if (!issue) throw new Error('No such issue');
  if (!OPEN.includes(issue.status)) throw new Error('This issue is closed');
  if (!issue.delivered) throw new Error('Send the issue to the VM first');
  const out = await oneshot(user, project, { text: fixText(issue), attachments: [] });
  const fresh = get(project, id);
  const at = new Date().toISOString();
  fresh.job = { id: out.id || null, startedAt: out.started ? at : null, scheduledFor: null };
  fresh.history.push({ at, to: fresh.status, who: user?.name || 'owner', note: out.started ? 'Fix now: one-shot job started' : 'Fix now: no clear answer from the VM' });
  writeJson(path.join(dirFor(project, id), 'issue.json'), fresh);
  return out;
}

/** Give open issues already on the VM their number (once, quietly). */
async function backfillNumbers(project) {
  if (!kitHasTickets(project)) return;
  for (const id of ids(project)) {
    const i = get(project, id);
    if (!i || !i.delivered || i.vmNumbered || !OPEN.includes(i.status) || !Number.isInteger(i.number)) continue;
    await amend(project, i, { priority: i.priority || 'normal', quiet: true });
  }
}

export { SCREEN_RE };
