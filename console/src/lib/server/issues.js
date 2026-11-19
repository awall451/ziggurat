// Owner issues: tickets for the lead, usually raised from a gallery
// screenshot with markup drawn on it. Separate from the inbox: the inbox is a
// conversation, an issue is a unit of work the lead triages and delegates.
//
// Stored locally under DATA_DIR/issues/<project>/<id>/ (issue.json, shot.png,
// markup.png) and delivered to the VM with the kit's `agent-kit-issues`
// script. The lead's status updates come back by pulling `issues-out/`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { kit, pull } from './ssh.js';

export const KINDS = ['bug', 'polish', 'idea'];
export const STATUSES = ['new', 'in_progress', 'done', 'wontfix'];
export const OPEN = ['new', 'in_progress'];
const ID_RE = /^[0-9]{8}T[0-9]{6}Z-i-[a-f0-9]{6}$/;
const SCREEN_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.png$/;
const MAX_TEXT = 20_000;
const MAX_PNG = 8 * 1024 * 1024;
const MAX_SHAPES = 200;
const SYNC_EVERY = 15_000;

const rootFor = (project) => path.join(DATA_DIR, 'issues', project.id);
const dirFor = (project, id) => path.join(rootFor(project), id);
const outDir = (project) => path.join(rootFor(project), '.out');

/** A gallery file name -> the screen it shows ("03-level-up.png" -> "level-up"). */
export function screenKey(file) {
  return String(file || '')
    .replace(/\.png$/i, '')
    .replace(/^\d+-/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
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
 * Raise an issue. `origin` is {type:'gallery', date, file}; `shot` is the
 * screenshot file to keep a copy of, `markupPng` the flattened drawing.
 */
export async function create(project, user, { title, body, kind, origin, markup, shot = null, markupPng = null }, { deliverNow = true } = {}) {
  const t = String(title || '').trim().slice(0, 200);
  if (!t) throw new Error('Give the issue a title');
  const text = String(body || '').trim();
  if (text.length > MAX_TEXT) throw new Error('Description is too long');
  if (!KINDS.includes(kind)) throw new Error('Unknown kind');
  let o = null;
  if (origin?.type === 'gallery') {
    if (!DATE_RE.test(origin.date || '') || !FILE_RE.test(origin.file || '')) throw new Error('Bad screenshot');
    o = { type: 'gallery', date: origin.date, file: origin.file, screen: screenKey(origin.file) };
  } else if (origin != null) throw new Error('Unknown origin');
  if (markupPng && !isPng(markupPng)) throw new Error('Markup must be a PNG under 8 MB');

  const id = `${stamp()}-i-${crypto.randomBytes(3).toString('hex')}`;
  const dir = dirFor(project, id);
  fs.mkdirSync(dir, { recursive: true });
  if (shot) fs.copyFileSync(shot, path.join(dir, 'shot.png'));
  if (markupPng) fs.writeFileSync(path.join(dir, 'markup.png'), markupPng);
  const now = new Date().toISOString();
  const issue = {
    id,
    title: t,
    body: text,
    kind,
    status: 'new',
    origin: o,
    markup: cleanMarkup(markup),
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

export function get(project, id) {
  if (!ID_RE.test(id)) return null;
  return readJson(path.join(dirFor(project, id), 'issue.json'));
}

function tarStream(dir) {
  const files = ['issue.md', ...['shot.png', 'markup.png'].filter((f) => fs.existsSync(path.join(dir, f)))];
  return spawn('tar', ['-c', '-C', dir, '--owner=0', '--group=0', ...files], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
}

/** What the lead reads: a plain-text ticket. */
export function issueText(issue) {
  const lines = [`# ${issue.title}`, '', `Kind: ${issue.kind}`];
  if (issue.origin?.type === 'gallery') lines.push(`Screen: ${issue.origin.screen} (gallery screenshot ${issue.origin.date}/${issue.origin.file})`);
  if (issue.markup?.length) lines.push(`Markup: ${issue.markup.length} shape(s) drawn by the owner, see markup.png`);
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
  const res = await kit(project, 'agent-kit-issues', ['put', id, issue.kind], { inputStream: tarStream(dir), timeout: 300000 });
  issue.delivered = res.code === 0 || /already exists/.test(res.stderr || '');
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
  issue.resolution = OPEN.includes(status) ? null : { at, who, note, fixedShot: extra.fixedShot || null };
}

/** All issues, newest first; `screen` filters to one gallery screen. */
export function list(project, { screen = null } = {}) {
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
    return list(project).filter((i) => OPEN.includes(i.status)).length;
  } catch {
    return 0;
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

function parseHeaderFile(file) {
  let text;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    text = fs.readFileSync(file, 'utf8').slice(0, 200_000);
  } catch {
    return null;
  }
  const i = text.indexOf('\n---\n');
  const head = i >= 0 ? text.slice(0, i) : text;
  const fields = {};
  for (const line of head.split('\n')) {
    const j = line.indexOf(': ');
    if (j > 0) fields[line.slice(0, j).toLowerCase()] = line.slice(j + 2).trim();
  }
  return { fields, body: i >= 0 ? text.slice(i + 5).trim() : '' };
}

const FIXED_RE = /^shots\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.png$/;

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
      applyStatus(issue, status, 'lead', u.body.slice(0, 4000), { at, fixedShot });
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
    })
    .finally(() => syncState.set(project.id, { at: Date.now(), pending: null }));
  syncState.set(project.id, { ...s, pending });
  return pending;
}

export { SCREEN_RE };
