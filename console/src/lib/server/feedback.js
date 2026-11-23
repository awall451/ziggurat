// Owner feedback: messages from the owner to a team's lead, the lead's
// replies, and questions the lead asks the owner.
//
// Sending goes through the kit's `agent-kit-inbox` script on the VM, which
// writes into a root-owned inbox; that location is what tells the lead a
// message is genuine. Replies and questions come back by pulling the VM's
// outbox. Everything in the outbox was written by an agent: it is parsed as
// data and file names are checked before anything is read or served.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { kit, pull } from './ssh.js';
import { parseHeaderFile } from './headerfile.js';

export const TIERS = ['note', 'priority', 'urgent'];
// A one-shot job is stored and shown like a message, but it is not a tier the
// owner picks in the Inbox: it starts a cycle (see sendOneshot, startOneshot).
export const ONESHOT = 'oneshot';
const OWNER_ID = /^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/;
const ASK_ID = /^[0-9]{8}T[0-9]{6}Z-a-[a-z0-9-]{1,40}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TOKEN_RE = /^[a-f0-9]{24}$/;
const MAX_ATT = 20 * 1024 * 1024;
const MAX_FILES = 8;
const MAX_TEXT = 60_000;
const OUTBOX_EVERY = 15_000;

const dirFor = (project) => path.join(DATA_DIR, 'feedback', project.id);
const sentDir = (project) => path.join(dirFor(project), 'sent');
const draftDir = (project) => path.join(dirFor(project), 'drafts');
const outboxDir = (project) => path.join(dirFor(project), 'outbox');

/** Keep a file name people can recognise, but only safe characters. */
export function safeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  return (base || 'file').slice(0, 100);
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

function listFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && NAME_RE.test(d.name))
      .map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size }));
  } catch {
    return [];
  }
}

/** Store one uploaded file until the message it belongs to is sent. */
export function saveDraftAttachment(project, name, data) {
  if (data.length > MAX_ATT) throw new Error('Attachment is over 20 MB');
  if (!data.length) throw new Error('Attachment is empty');
  const token = crypto.randomBytes(12).toString('hex');
  const dir = path.join(draftDir(project), token);
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeName(name);
  fs.writeFileSync(path.join(dir, safe), data);
  return { token, name: safe, size: data.length };
}

function sweepDrafts(project) {
  // Uploads that were never sent are dropped after a day.
  try {
    for (const d of fs.readdirSync(draftDir(project))) {
      const p = path.join(draftDir(project), d);
      if (TOKEN_RE.test(d) && Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* nothing to sweep */
  }
}

function tarStream(dir) {
  return spawn('tar', ['-c', '-C', dir, '--owner=0', '--group=0', 'body.md', ...(fs.existsSync(path.join(dir, 'att')) ? ['att'] : [])], {
    stdio: ['ignore', 'pipe', 'ignore']
  }).stdout;
}

/**
 * Send a message to the lead. The message is kept locally first, so a
 * delivery that fails (VM off) is visible and can be retried.
 */
export async function send(project, user, { tier, text, attachments = [], inReplyTo = null }) {
  if (!TIERS.includes(tier)) throw new Error('Unknown tier');
  return deliver(project, store(project, user, { tier, text, attachments, inReplyTo }));
}

// What the console knows about a backlog job, for the VM (kit 0.18): its
// estimate (the overrun brake goes by it), the jobs it builds on, and whether
// the owner switched the brake off. Kept with the job, so a move or a second
// start sends the same. Only these forms ever reach the command line.
function jobFlags(flags, { start = false } = {}) {
  const out = [];
  const list = Array.isArray(flags) ? flags : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--minutes' && /^[0-9]{1,4}$/.test(list[i + 1] || '')) out.push('--minutes', list[++i]);
    else if (list[i] === '--no-brake') out.push('--no-brake');
    else if (list[i] === '--after' && /^[0-9TZa-z,-]{1,600}$/.test(list[i + 1] || '')) {
      i++;
      if (!start) out.push('--after', list[i]);
    }
  }
  return out;
}
function keepFlags(project, id, flags) {
  const f = jobFlags(flags);
  if (!f.length) return;
  const file = path.join(sentDir(project), id, 'meta.json');
  const meta = readJson(file);
  if (!meta) return;
  meta.flags = f;
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
}

/** The text of a message or one-shot job the owner sent from this console, or null. */
export function sentText(project, id) {
  if (!OWNER_ID.test(id || '')) return null;
  try {
    return fs.readFileSync(path.join(sentDir(project), id, 'body.md'), 'utf8').slice(0, MAX_TEXT);
  } catch {
    return null;
  }
}

/**
 * A new one-shot job on a halted team: the text becomes an owner message and
 * the VM runs one cycle for it, then halts again.
 *
 * Three outcomes:
 * - started: the job is in the Inbox like any message;
 * - the VM said no (not halted, a cycle still running): throws, and nothing
 *   is kept, here or on the VM, so the owner can change something and start
 *   again from the same form with the same attachments;
 * - no clear answer (the line dropped): the job is kept as "not started",
 *   since it may have reached the VM. Returns {started: false}.
 */
export async function sendOneshot(project, user, { text, attachments = [], flags = [] }) {
  const id = store(project, user, { tier: ONESHOT, text, attachments, inReplyTo: null }, { keepDrafts: true });
  keepFlags(project, id, flags);
  const out = await startOneshot(project, id);
  if (out.refused) {
    fs.rmSync(path.join(sentDir(project), id), { recursive: true, force: true });
    throw new Error(out.error);
  }
  // From here on the stored job holds the files.
  for (const token of attachments) fs.rmSync(path.join(draftDir(project), token), { recursive: true, force: true });
  return out;
}

/**
 * A one-shot job set for a time (kit 0.10): the VM keeps it and starts it
 * then (agent-kit-oneshot at). A refusal throws and keeps nothing here; with
 * no clear answer the job is kept, marked with the error.
 */
export async function scheduleOneshot(project, user, { text, epoch, flags = [] }) {
  const id = store(project, user, { tier: ONESHOT, text, attachments: [], inReplyTo: null });
  const dir = path.join(sentDir(project), id);
  const file = path.join(dir, 'meta.json');
  keepFlags(project, id, flags);
  const res = await kit(project, 'agent-kit-oneshot', ['at', String(epoch), id, user.name && /^[A-Za-z0-9._@-]{1,80}$/.test(user.name) ? user.name : 'owner', ...jobFlags(flags)], {
    inputStream: tarStream(dir),
    timeout: 300000
  });
  const scheduled = res.code === 0;
  const error = scheduled ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  if (!scheduled && vmSaidNo(res.code)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(error);
  }
  const meta = readJson(file);
  meta.scheduledFor = scheduled ? epoch : null;
  meta.error = error;
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  return { id, scheduled, error };
}

/**
 * Move a job that waits for its time (kit 0.10): the VM forgets the old time
 * and gets the stored job again for the new one. {ok, error}.
 */
export async function rescheduleOneshot(project, id, epoch) {
  if (!OWNER_ID.test(id)) throw new Error('Bad job id');
  const dir = path.join(sentDir(project), id);
  const file = path.join(dir, 'meta.json');
  const meta = readJson(file);
  if (!meta || meta.tier !== ONESHOT) throw new Error('No such job');
  if (meta.delivered) throw new Error('That job has already started');
  const un = await kit(project, 'agent-kit-oneshot', ['unat', id]);
  if (un.code !== 0) return { ok: false, error: (un.stderr || 'could not move it on the VM').trim().slice(-200) };
  const res = await kit(project, 'agent-kit-oneshot', ['at', String(epoch), id, senderOf(meta), ...jobFlags(meta.flags)], { inputStream: tarStream(dir), timeout: 300000 });
  const ok = res.code === 0;
  meta.scheduledFor = ok ? epoch : null;
  meta.error = ok ? null : `the old time is cancelled, but the new one was not set: ${(res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-200)}`;
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  return { ok, error: meta.error };
}

/** The VM started a job that was set for a time: show it as started. */
export function noteScheduledStart(project, status) {
  const id = status?.oneshot?.id;
  if (!OWNER_ID.test(id || '')) return;
  const meta = readJson(path.join(sentDir(project), id, 'meta.json'));
  if (meta?.scheduledFor && !meta.delivered) markStarted(project, id);
}

/**
 * Start the cycle for a stored one-shot job: a first try, a job that was not
 * started, or one whose cycle ended without the lead finishing it. The VM
 * takes the message from stdin if it does not have it yet.
 */
export async function startOneshot(project, id) {
  if (!OWNER_ID.test(id)) throw new Error('Bad message id');
  const dir = path.join(sentDir(project), id);
  const file = path.join(dir, 'meta.json');
  const meta = readJson(file);
  if (!meta || meta.tier !== ONESHOT) throw new Error('No such one-shot job');
  if (meta.closed) throw new Error('That job is closed');
  if (/^(done|declined)$/.test(replyStatus(project, id) || '')) throw new Error('That job is already answered');
  // Started now, a job waits for nothing: what it comes after is for a set time only.
  const res = await kit(project, 'agent-kit-oneshot', ['start', id, senderOf(meta), ...jobFlags(meta.flags, { start: true })], { inputStream: tarStream(dir), timeout: 300000 });
  const started = res.code === 0;
  const error = started ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  if (started) markStarted(project, id);
  else if (!meta.delivered) {
    // A job that ran before stays "delivered"; only a first start can be "not started".
    meta.error = error;
    fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  }
  // The VM says what happens when the job ends: halted again, or (an idle team) running on.
  const runsOn = started && /runs on when it ends/.test(res.stdout || '');
  return { meta: readJson(file) || meta, started, runsOn, refused: !started && vmSaidNo(res.code), error };
}

/**
 * Did the VM itself refuse, before anything happened there? The kit scripts
 * and sudo exit with small codes (1, 2; 126 and 127 for a missing script).
 * Above that the script was killed part-way (128 + signal), 255 is ssh
 * failing and -1 a timeout or a spawn error: then nothing is known about what
 * happened on the VM.
 */
export function vmSaidNo(code) {
  return Number.isInteger(code) && code >= 1 && code <= 127;
}

/** The VM is running this job (it said so, or its status shows it). */
export function markStarted(project, id) {
  if (!OWNER_ID.test(id)) throw new Error('Bad message id');
  const file = path.join(sentDir(project), id, 'meta.json');
  const meta = readJson(file);
  if (!meta) throw new Error('No such message');
  const now = new Date().toISOString();
  meta.delivered = true;
  meta.error = null;
  meta.deliveredAt ??= now;
  meta.startedAt = now;
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  return meta;
}

const senderOf = (meta) => (/^[A-Za-z0-9._@-]{1,80}$/.test(meta.from) ? meta.from : 'owner');

function store(project, user, { tier, text, attachments, inReplyTo }, { keepDrafts = false } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Write a message first');
  if (body.length > MAX_TEXT) throw new Error('Message is too long');
  if (inReplyTo != null && !ASK_ID.test(inReplyTo)) throw new Error('Bad question id');
  if (attachments.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} attachments`);

  const id = `${stamp()}-o-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(sentDir(project), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'body.md'), body + '\n');
  const files = [];
  for (const token of attachments) {
    if (!TOKEN_RE.test(token)) throw new Error('Bad attachment');
    const from = path.join(draftDir(project), token);
    const [f] = listFiles(from);
    if (!f) throw new Error('An attachment was not uploaded');
    fs.mkdirSync(path.join(dir, 'att'), { recursive: true });
    let name = f.name;
    for (let i = 2; files.includes(name); i++) name = `${i}-${f.name}`.slice(0, 100);
    fs.copyFileSync(path.join(from, f.name), path.join(dir, 'att', name));
    if (!keepDrafts) fs.rmSync(from, { recursive: true, force: true });
    files.push(name);
  }
  const meta = { id, tier, from: user.name, sentAt: new Date().toISOString(), inReplyTo, delivered: false, error: null, closed: false };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  sweepDrafts(project);
  return id;
}

/** Push a stored message to the VM (also used to retry). */
export async function deliver(project, id) {
  if (!OWNER_ID.test(id)) throw new Error('Bad message id');
  const dir = path.join(sentDir(project), id);
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) throw new Error('No such message');
  // Delivering a one-shot job starts a cycle: that is the owner's decision,
  // made on purpose (startOneshot), never a side effect of a retry.
  if (meta.tier === ONESHOT) throw new Error('A one-shot job is started, not sent: use Start on the job');
  if (meta.delivered) return meta;
  const res = await kit(project, 'agent-kit-inbox', ['put', id, meta.tier, senderOf(meta), meta.inReplyTo || '-'], {
    inputStream: tarStream(dir),
    timeout: 300000
  });
  meta.delivered = res.code === 0;
  meta.error = meta.delivered ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  // "already exists" means an earlier attempt did arrive.
  if (!meta.delivered && /already exists/.test(meta.error)) {
    meta.delivered = true;
    meta.error = null;
  }
  if (meta.delivered) meta.deliveredAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export async function close(project, id) {
  if (!OWNER_ID.test(id)) throw new Error('Bad message id');
  const file = path.join(sentDir(project), id, 'meta.json');
  const meta = readJson(file);
  if (!meta) throw new Error('No such message');
  // A one-shot job that shows as "not started" may be on the VM all the same
  // (the line dropped after it was stored). Close it there too, or a later
  // cycle would find it open and do it.
  if (meta.delivered || meta.tier === ONESHOT) {
    const res = await kit(project, 'agent-kit-inbox', ['close', id]);
    const neverArrived = !meta.delivered && /no such message/.test(res.stderr || '');
    if (res.code !== 0 && !neverArrived) throw new Error((res.stderr || 'could not close on the VM').trim().slice(-200));
  }
  meta.closed = true;
  meta.closedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  return meta;
}

const outboxState = new Map(); // id -> {at, pending}

/** Pull the lead's replies and questions; throttled, never throws. */
export function syncOutbox(project, { force = false } = {}) {
  const s = outboxState.get(project.id) || { at: 0, pending: null };
  if (s.pending) return s.pending;
  if (!force && Date.now() - s.at < OUTBOX_EVERY) return Promise.resolve();
  const dest = outboxDir(project);
  fs.mkdirSync(dest, { recursive: true });
  const pending = pull(project, [`${project.kit.state}/outbox/`], dest, {
    as: 'agent',
    maxSize: '20m',
    timeout: 120000,
    filters: ['--exclude=.*.tmp']
  })
    .catch(() => {})
    .finally(() => outboxState.set(project.id, { at: Date.now(), pending: null }));
  outboxState.set(project.id, { ...s, pending });
  return pending;
}


/** The lead's reply status for a message, from the pulled outbox (agent-written: parsed as data). */
function replyStatus(project, id) {
  const reply = parseHeaderFile(path.join(outboxDir(project), `${id}.md`));
  return reply && /^(done|planned|declined)$/.test(reply.fields.status || '') ? reply.fields.status : null;
}

/** Everything the Inbox tab shows, newest first. */
export function threads(project) {
  const out = outboxDir(project);
  let outNames = [];
  try {
    outNames = fs.readdirSync(out);
  } catch {
    /* nothing pulled yet */
  }
  let seen = [];
  try {
    seen = fs.readdirSync(path.join(out, '.seen'));
  } catch {
    /* none */
  }

  // Owner messages sent from this console.
  let sentIds = [];
  try {
    sentIds = fs.readdirSync(sentDir(project)).filter((n) => OWNER_ID.test(n));
  } catch {
    /* none sent */
  }
  const messages = [];
  for (const id of sentIds) {
    const dir = path.join(sentDir(project), id);
    const meta = readJson(path.join(dir, 'meta.json'));
    if (!meta) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, 'body.md'), 'utf8');
    } catch {
      /* body missing */
    }
    const reply = parseHeaderFile(path.join(out, `${id}.md`));
    const status = reply && /^(done|planned|declined)$/.test(reply.fields.status || '') ? reply.fields.status : null;
    messages.push({
      id,
      tier: meta.tier,
      from: meta.from,
      sentAt: meta.sentAt,
      inReplyTo: meta.inReplyTo || null,
      text,
      attachments: listFiles(path.join(dir, 'att')),
      delivered: !!meta.delivered,
      error: meta.error || null,
      closed: !!meta.closed,
      // One-shot jobs: when the console last started its cycle.
      startedAt: meta.startedAt || null,
      // Set for a time on the VM (kit 0.10), not started yet.
      scheduledFor: !meta.delivered && Number.isInteger(meta.scheduledFor) ? meta.scheduledFor : null,
      seen: seen.includes(id),
      nudged: seen.filter((n) => n.startsWith(`${id}@`)).length,
      reply: status ? { status, date: reply.fields.date || null, text: reply.body, attachments: listFiles(path.join(out, `${id}.d`)) } : null,
      open: !meta.closed && status !== 'done' && status !== 'declined'
    });
  }

  // Questions from the lead.
  const asks = [];
  for (const n of outNames) {
    if (!n.endsWith('.md')) continue;
    const id = n.slice(0, -3);
    if (!ASK_ID.test(id)) continue;
    const parsed = parseHeaderFile(path.join(out, n));
    if (!parsed) continue;
    const answers = messages.filter((m) => m.inReplyTo === id).map((m) => m.id);
    asks.push({
      id,
      slug: id.replace(/^[0-9TZ]+-a-/, ''),
      askedAt: parsed.fields.asked || null,
      default: parsed.fields.default || '',
      text: parsed.body,
      answers,
      open: answers.length === 0
    });
  }

  messages.sort((a, b) => (a.id < b.id ? 1 : -1));
  asks.sort((a, b) => (a.id < b.id ? 1 : -1));
  return { messages, asks, openAsks: asks.filter((a) => a.open).length, openMessages: messages.filter((m) => m.open).length };
}

/** Count of the lead's questions without an answer (for badges). */
export function openAskCount(project) {
  try {
    return threads(project).openAsks;
  } catch {
    return 0;
  }
}

const INLINE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/**
 * An attachment of a sent message (`sent/<id>/<name>`) or of a reply
 * (`reply/<id>/<name>`). Returns {file, name, type, inline} or null.
 */
export function attachment(project, kind, id, name) {
  if (!OWNER_ID.test(id) || !NAME_RE.test(name)) return null;
  const base = kind === 'sent' ? path.join(sentDir(project), id, 'att') : kind === 'reply' ? path.join(outboxDir(project), `${id}.d`) : null;
  if (!base) return null;
  const file = path.join(base, name);
  try {
    const real = fs.realpathSync(file);
    if (!real.startsWith(fs.realpathSync(base) + path.sep) || !fs.statSync(real).isFile()) return null;
    const type = INLINE[path.extname(name).toLowerCase()];
    return { file: real, name, type: type || 'application/octet-stream', inline: !!type };
  } catch {
    return null;
  }
}
