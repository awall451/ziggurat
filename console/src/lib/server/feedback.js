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

export const TIERS = ['note', 'priority', 'urgent'];
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
    fs.rmSync(from, { recursive: true, force: true });
    files.push(name);
  }
  const meta = { id, tier, from: user.name, sentAt: new Date().toISOString(), inReplyTo, delivered: false, error: null, closed: false };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  sweepDrafts(project);
  return deliver(project, id);
}

/** Push a stored message to the VM (also used to retry). */
export async function deliver(project, id) {
  if (!OWNER_ID.test(id)) throw new Error('Bad message id');
  const dir = path.join(sentDir(project), id);
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) throw new Error('No such message');
  if (meta.delivered) return meta;
  const from = /^[A-Za-z0-9._@-]{1,80}$/.test(meta.from) ? meta.from : 'owner';
  const res = await kit(project, 'agent-kit-inbox', ['put', id, meta.tier, from, meta.inReplyTo || '-'], {
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
  if (meta.delivered) {
    const res = await kit(project, 'agent-kit-inbox', ['close', id]);
    if (res.code !== 0) throw new Error((res.stderr || 'could not close on the VM').trim().slice(-200));
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

function parseHeaderFile(file, max = 200_000) {
  let text;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    text = fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return null;
  }
  const i = text.indexOf('\n---\n');
  const head = i >= 0 ? text.slice(0, i) : text;
  const body = i >= 0 ? text.slice(i + 5) : '';
  const fields = {};
  for (const line of head.split('\n')) {
    const j = line.indexOf(': ');
    if (j > 0) fields[line.slice(0, j).toLowerCase()] = line.slice(j + 2).trim();
  }
  return { fields, body: body.trim() };
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
