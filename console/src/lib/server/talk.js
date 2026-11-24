// The Chat tab (issue 71, kit 0.33): named conversations with a team's lead
// that are not about a plan. The console names a conversation and keeps its
// title and messages; the VM keeps the lead's session for it. A message goes
// to the VM through `agent-kit-chat say <talk-id> …` (free text on stdin, or
// a tar of body.md and att/ with files). What the lead writes (talk-out/: its
// answers, and each turn's stream of events) is pulled as the agent user and
// read as data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DATA_DIR, getPricing } from './config.js';
import { kit, pull } from './ssh.js';
import { parseHeaderFile } from './headerfile.js';
import { vmSaidNo, draftFiles, dropDrafts } from './feedback.js';
import { audit } from './audit.js';
import { invalidateStatus, kitAtLeast } from './live.js';
import { senderName } from './backlog.js';

export const TALK_KIT = '0.33.0';
export const TALK_RE = /^[0-9]{8}T[0-9]{6}Z-t-[a-f0-9]{6}$/;
export const MSG_RE = /^[0-9]{8}T[0-9]{6}Z-c-[a-f0-9]{6}$/;
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TEXT = 20000;
const MAX_TITLE = 80;
const MAX_STREAM = 8 * 1024 * 1024;
// The prompt cache lives an hour: after that the kit starts a new session.
export const FRESH_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW = 200_000;

const dirFor = (project) => path.join(DATA_DIR, 'talk', project.id);
const convDir = (project, id) => path.join(dirFor(project), id);
const outDir = (project) => path.join(dirFor(project), '.out');

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
function names(dir, re, ext) {
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
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** Does this team's VM have the Chat tab (kit 0.33)? */
export const kitHasTalk = (version) => kitAtLeast(version, TALK_KIT);

/** A title from the first message: its first line, shortened. */
export function titleFrom(text) {
  const line = String(text || '').trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New conversation';
}

function readConv(project, id) {
  if (!TALK_RE.test(id)) return null;
  const c = readJson(path.join(convDir(project, id), 'conv.json'));
  return c && c.id === id ? c : null;
}

/** The lead's answer to a message, or null. */
function replyOf(project, conv, msg) {
  const r = parseHeaderFile(path.join(outDir(project), conv, `${msg}.md`), 40_000);
  return r && r.fields.re === msg && /^(ok|error)$/.test(r.fields.status || '') ? { status: r.fields.status, date: r.fields.date || null, text: r.body.slice(0, 20000) } : null;
}

function messages(project, conv) {
  return names(convDir(project, conv), MSG_RE, '.json').map((id) => {
    const m = readJson(path.join(convDir(project, conv), `${id}.json`)) || {};
    return {
      id,
      by: m.by || null,
      at: m.at || null,
      text: typeof m.text === 'string' ? m.text : '',
      files: Array.isArray(m.files) ? m.files.filter((f) => f && typeof f.name === 'string').map((f) => ({ name: f.name, size: Number(f.size) || 0 })) : [],
      model: MODELS.includes(m.model) ? m.model : null,
      effort: EFFORTS.includes(m.effort) ? m.effort : null,
      delivered: !!m.delivered,
      error: m.error || null,
      reply: replyOf(project, conv, id)
    };
  })
    // Ids have a one-second stamp: two messages in one second are ordered by when they were sent.
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.id < b.id ? -1 : 1));
}

// ---- the stream of a turn (stream-json) -------------------------------------

/** One line of what the lead did: a tool and what it was given, shortened. */
function stepText(name, input = {}) {
  const s = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const cut = (v, n = 120) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
  switch (name) {
    case 'Read':
      return cut(s(input.file_path));
    case 'Grep':
      return cut(`${s(input.pattern)}${input.path ? ` in ${s(input.path)}` : ''}`);
    case 'Glob':
      return cut(s(input.pattern));
    case 'Bash':
      return cut(s(input.command));
    default:
      return cut(s(JSON.stringify(input)));
  }
}

/**
 * What a turn's stream says: the lead's steps (tools and their outcome), the
 * text so far, the files it read and the size of the context at its last
 * message. Every value is checked; the stream is data the agent wrote.
 */
export function readStream(text) {
  const steps = [];
  const byId = new Map();
  const files = new Set();
  let said = '';
  let usage = null;
  let model = null;
  let result = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      if (typeof e.message.model === 'string' && /^[a-z0-9.<>_-]{1,60}$/.test(e.message.model)) model = e.message.model;
      const u = e.message.usage;
      if (u && typeof u === 'object') {
        usage = {
          input: num(u.input_tokens) || 0,
          cacheRead: num(u.cache_read_input_tokens) || 0,
          cacheWrite: num(u.cache_creation_input_tokens) || 0,
          output: num(u.output_tokens) || 0
        };
      }
      for (const c of e.message.content) {
        if (c?.type === 'tool_use' && typeof c.name === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(c.name)) {
          const step = { tool: c.name, text: stepText(c.name, c.input && typeof c.input === 'object' ? c.input : {}), ok: null };
          steps.push(step);
          if (typeof c.id === 'string') byId.set(c.id, step);
          if ((c.name === 'Read' || c.name === 'Grep') && typeof c.input?.file_path === 'string') files.add(c.input.file_path.slice(0, 300));
          if (c.name === 'Grep' && typeof c.input?.path === 'string') files.add(c.input.path.slice(0, 300));
        } else if (c?.type === 'text' && typeof c.text === 'string') {
          said = c.text.slice(0, 20000);
        }
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c?.type === 'tool_result' && byId.has(c.tool_use_id)) byId.get(c.tool_use_id).ok = c.is_error !== true;
      }
    } else if (e.type === 'result') {
      result = { cost: num(e.total_cost_usd), turns: num(e.num_turns), error: e.is_error === true };
    }
  }
  const context = usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
  return { steps: steps.slice(-200), said, files: [...files].slice(-50), context, usage, model, result };
}

function streamOf(project, conv, msg) {
  const file = path.join(outDir(project), conv, `${msg}.jsonl`);
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    // A very long turn: its last part says what matters (the newest steps and the result).
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, MAX_STREAM);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return readStream(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ---- the ledger ----------------------------------------------------------------

function ledger(project) {
  const file = path.join(project.paths?.fleet || '', 'cycles.jsonl');
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .slice(-4000)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l) => l && typeof l === 'object' && l.kind === 'talk');
  } catch {
    return [];
  }
}

/** "claude-opus-5-5" -> "opus": the names the model picker uses. */
function shortModel(id) {
  const m = /(fable|opus|sonnet|haiku)/.exec(String(id || ''));
  return m ? m[1] : null;
}

/** The context window of a model: `context` of its entry in pricing.json, else 200k. */
export function contextWindow(model) {
  const p = getPricing();
  const m = (p.models || []).find((x) => x && typeof x.match === 'string' && String(model || '').includes(x.match));
  const n = num(m?.context) || num(p.contextWindow);
  return n && n > 1000 ? n : DEFAULT_WINDOW;
}

// ---- reading -------------------------------------------------------------------

/** Every conversation of a project, newest activity first, with what is unread. */
export function list(project, status = null) {
  let ids = [];
  try {
    ids = fs.readdirSync(dirFor(project)).filter((n) => TALK_RE.test(n));
  } catch {
    return [];
  }
  const running = status?.chat?.talk || null;
  return ids
    .map((id) => {
      const c = readConv(project, id);
      if (!c) return null;
      const msgs = messages(project, id);
      const seen = new Set(Array.isArray(c.seen) ? c.seen : []);
      const answered = msgs.filter((m) => m.reply);
      const last = msgs.at(-1);
      return {
        id,
        title: c.title || 'New conversation',
        createdAt: c.createdAt || null,
        lastAt: last?.reply?.date || last?.at || c.createdAt || null,
        archived: !!c.archived,
        count: msgs.length,
        running: running === id,
        waiting: msgs.some((m) => m.delivered && !m.reply),
        unread: running === id ? 0 : answered.filter((m) => !seen.has(m.id)).length,
        last: last ? (last.reply?.text || last.text).replace(/\s+/g, ' ').slice(0, 100) : ''
      };
    })
    .filter(Boolean)
    .sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0));
}

/** Answers in the Chat tab the owner has not seen: the tab's count. */
export function unread(project, status = null) {
  try {
    return list(project, status)
      .filter((c) => !c.archived)
      .reduce((n, c) => n + c.unread, 0);
  } catch {
    return 0;
  }
}

/**
 * One conversation with its messages, each answer's steps, and the context
 * panel: tokens in the session, cost, model and effort, how long the cache
 * stays warm, the files the lead read.
 */
export function get(project, id, { status = null, now = Date.now() } = {}) {
  const c = readConv(project, id);
  if (!c) return null;
  const lines = ledger(project).filter((l) => l.talk === id);
  const msgs = messages(project, id).map((m) => {
    const s = streamOf(project, id, m.id);
    const line = lines.findLast((l) => l.chat === m.id);
    return {
      ...m,
      steps: s?.steps || [],
      said: !m.reply && s ? s.said : '',
      cost: num(line?.cost_usd),
      // The ledger comes with the slow pull; until then the stream says which model answered.
      ranModel: typeof line?.model === 'string' ? line.model : shortModel(s?.model),
      ranEffort: typeof line?.effort === 'string' ? line.effort : m.reply ? m.effort : null,
      _stream: s
    };
  });
  const files = new Set();
  let context = null;
  let ctxModel = null;
  for (const m of msgs) {
    for (const f of m._stream?.files || []) files.add(f);
    if (m._stream?.context != null) {
      context = m._stream.context;
      ctxModel = m._stream.model;
    }
  }
  // The answers and their streams arrive with the turn; the ledger line (cost)
  // only with the slower pull of the ledger. The panel works from the answers,
  // and adds what the ledger knows once it has come.
  const answered = msgs.filter((m) => m.reply);
  const lastAnswer = answered.at(-1) || null;
  const lastLine = lines.at(-1) || null;
  const lineIsLast = !!lastLine && lastLine.chat === lastAnswer?.id;
  const lastEnd = (lineIsLast && Date.parse(lastLine.end)) || Date.parse(lastAnswer?.reply?.date) || Date.parse(lastLine?.end) || null;
  // A new session after a pause starts from a summary, so its context is small again.
  const warmMs = lastEnd ? Math.max(0, FRESH_MS - (now - lastEnd)) : 0;
  const model = (lineIsLast && lastLine.model) || lastAnswer?.ranModel || lastLine?.model || shortModel(ctxModel) || null;
  const effort = (lineIsLast && lastLine.effort) || lastAnswer?.ranEffort || lastLine?.effort || null;
  return {
    id,
    title: c.title || 'New conversation',
    createdAt: c.createdAt || null,
    archived: !!c.archived,
    model: MODELS.includes(c.model) ? c.model : null,
    effort: EFFORTS.includes(c.effort) ? c.effort : null,
    running: status?.chat?.talk === id,
    messages: msgs.map(({ _stream, ...m }) => m),
    context: {
      tokens: context,
      window: contextWindow(ctxModel || model),
      cost: lines.reduce((s, l) => s + (num(l.cost_usd) || 0), 0),
      // Answers whose cost the console does not know yet (the ledger is pulled later).
      costPending: Math.max(0, answered.length - lines.length),
      turns: Math.max(lines.length, answered.length),
      model,
      effort,
      warmMinutes: warmMs ? Math.ceil(warmMs / 60000) : 0,
      files: [...files].slice(-30)
    }
  };
}

// ---- what the owner does ------------------------------------------------------

/** A message with files, as the kit takes it: a tar of body.md and att/. */
function archive(text, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-talk-'));
  fs.writeFileSync(path.join(dir, 'body.md'), text);
  fs.mkdirSync(path.join(dir, 'att'));
  for (const f of files) fs.copyFileSync(f.path, path.join(dir, 'att', f.name));
  const stream = spawn('tar', ['-c', '-C', dir, '--owner=0', '--group=0', 'body.md', 'att'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
  return { stream, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Send a message. With no conversation id a new conversation starts, titled
 * from this first message. A refusal by the VM throws and keeps nothing new.
 */
export async function say(user, project, { conv = '', text = '', model = '', effort = '', attachments = [] } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Write a message first');
  if (body.length > MAX_TEXT) throw new Error('The message is too long');
  if (model && !MODELS.includes(model)) throw new Error('Unknown model');
  if (effort && !EFFORTS.includes(effort)) throw new Error('Unknown effort');
  let c = conv ? readConv(project, conv) : null;
  if (conv && !c) throw new Error('No such conversation');
  const isNew = !c;
  const id = c?.id || `${stamp()}-t-${hex()}`;
  const tokens = Array.isArray(attachments) ? attachments.map(String).slice(0, 8) : [];
  const files = tokens.length ? draftFiles(project, tokens) : [];
  const msg = `${stamp()}-c-${hex()}`;
  const from = senderName(user);
  const argv = ['say', id, msg, from, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(files.length ? ['--files'] : [])];
  const tar = files.length ? archive(body, files) : null;
  let res;
  try {
    res = await kit(project, 'agent-kit-chat', argv, tar ? { inputStream: tar.stream, timeout: 300000 } : { input: body, timeout: 60000 });
  } finally {
    tar?.done();
  }
  const ok = res.code === 0;
  const error = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  audit(user, project.id, 'talk-say', { conv: id, msg, files: files.length }, { ok, detail: error });
  if (!ok && vmSaidNo(res.code)) throw new Error(error);
  if (files.length) dropDrafts(project, tokens);
  const now = new Date().toISOString();
  if (isNew) c = { id, title: titleFrom(body), createdAt: now, archived: false, seen: [] };
  // The conversation keeps the last model and effort chosen, for the next message.
  c = { ...c, model: model || null, effort: effort || null, archived: false };
  writeJson(path.join(convDir(project, id), 'conv.json'), c);
  writeJson(path.join(convDir(project, id), `${msg}.json`), {
    id: msg,
    by: from,
    at: now,
    text: body,
    files: files.map((f) => ({ name: f.name, size: f.size })),
    model: model || null,
    effort: effort || null,
    delivered: ok,
    error
  });
  // Whoever writes the next message has read the answers before it.
  seen(project, id);
  invalidateStatus(project.id);
  return { ok: true, conv: id, id: msg, delivered: ok, detail: ok ? 'Sent. The lead answers in a minute or two.' : `No clear answer from the VM (${error}).` };
}

function update(project, id, change) {
  const c = readConv(project, id);
  if (!c) throw new Error('No such conversation');
  const next = { ...c, ...change };
  writeJson(path.join(convDir(project, id), 'conv.json'), next);
  return next;
}

export function rename(project, id, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('Give it a name');
  if (t.length > MAX_TITLE) throw new Error('The name is too long');
  return update(project, id, { title: t });
}

/** Archived conversations leave the list (and the tab's count); the VM keeps its files. */
export function archiveConv(project, id, archived = true) {
  return update(project, id, { archived: !!archived });
}

/** The owner has seen every answer of this conversation. */
export function seen(project, id) {
  const c = readConv(project, id);
  if (!c) throw new Error('No such conversation');
  const done = messages(project, id)
    .filter((m) => m.reply)
    .map((m) => m.id);
  const had = new Set(Array.isArray(c.seen) ? c.seen : []);
  if (done.some((m) => !had.has(m))) update(project, id, { seen: done });
  return { ok: true };
}

// ---- pulling -------------------------------------------------------------------

const syncState = new Map();

/**
 * Pull the lead's answers and streams. While a turn runs, only that
 * conversation, as often as every 2 s; otherwise everything, every 15 s.
 * Never throws.
 */
export function syncTalk(project, { conv = null, live = false, force = false } = {}) {
  const key = `${project.id}`;
  const s = syncState.get(key) || { at: 0, pending: null };
  if (s.pending) return s.pending;
  if (!force && Date.now() - s.at < (live ? 2000 : 15_000)) return Promise.resolve();
  const one = live && conv && TALK_RE.test(conv);
  const dest = one ? path.join(outDir(project), conv) : outDir(project);
  fs.mkdirSync(dest, { recursive: true });
  const src = `${project.kit.state}/talk-out/${one ? `${conv}/` : ''}`;
  const answers = pull(project, [src], dest, { as: 'agent', maxSize: '8m', timeout: 60000, filters: ['--exclude=.*.tmp'] }).catch(() => {});
  // Between turns, the ledger too: an answer's cost is in its ledger line, and
  // the console's own pull of the ledger comes only every 15 minutes.
  const costs = one || !project.paths?.fleet ? null : pull(project, [`${project.kit.state}/ledger/cycles.jsonl`], project.paths.fleet, { maxSize: '32m', timeout: 60000 }).catch(() => {});
  const pending = Promise.all([answers, costs])
    .finally(() => syncState.set(key, { at: Date.now(), pending: null }));
  syncState.set(key, { ...s, pending });
  return pending;
}
