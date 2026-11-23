// Escalations: requests a team files in its repo (notes/agents/ESCALATIONS.md,
// one "## " heading each). The file is written by agents and is read as data
// only. An entry waits for the owner until one of these closes it:
//   - the team marks it: a "Resolved:" line, or a heading that starts with "Resolved";
//   - it names a question the lead asked in the inbox, and that question is answered;
//   - the owner answered or dismissed it here (a mark kept on the console).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readJson, writeJson } from './config.js';
import { threads } from './feedback.js';

const KEY_RE = /^[a-f0-9]{16}$/;
const ASK_IN_TEXT = /\b[0-9]{8}T[0-9]{6}Z-a-[a-z0-9-]{1,40}/g;
const RESOLVED_LINE = /^[ \t]*(?:[-*][ \t]+)?\**(?:resolved\**[ \t]*:|status\**[ \t]*:\**[ \t]*\**(?:resolved|closed|answered|done)\b)/im;
const RESOLVED_HEAD = /^[[(]?resolved\b/i;
const MAX_FILE = 2_000_000;

const marksFile = (project) => path.join(DATA_DIR, 'escalations', `${project.id}.json`);

function readFile(project) {
  try {
    const file = path.join(project.paths.fleet, 'notes', 'agents', 'ESCALATIONS.md');
    if (!fs.lstatSync(file).isFile()) return '';
    return fs.readFileSync(file, 'utf8').slice(0, MAX_FILE);
  } catch {
    return '';
  }
}

/** The entry's name on the console: it follows the heading, so a reworded entry is a new one. */
export function keyOf(title) {
  return crypto.createHash('sha256').update(String(title).trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex').slice(0, 16);
}

/** One entry per "## " heading: {key, title, body, resolved}. */
export function parseEscalations(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^##[ \t]+(.*)$/.exec(line);
    if (m) {
      const title = m[1].trim().slice(0, 300);
      cur = { key: keyOf(title), title, lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return out.map(({ key, title, lines }) => {
    const body = lines.join('\n').trim();
    return { key, title, body, resolved: RESOLVED_HEAD.test(title) || RESOLVED_LINE.test(body) };
  });
}

function marks(project) {
  const m = readJson(marksFile(project), {});
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

/**
 * Every entry of the team's file with `open` and, when closed, `closed`:
 * {how: 'resolved' | 'question' | 'answered' | 'dismissed', at, by, messageId, ask}.
 */
export function escalationList(project) {
  const entries = parseEscalations(readFile(project));
  if (!entries.length) return [];
  const mine = marks(project);
  let asks = [];
  try {
    asks = threads(project).asks;
  } catch {
    /* nothing pulled yet */
  }
  return entries.map((e) => {
    let closed = null;
    const mark = mine[e.key];
    if (mark && (mark.how === 'answered' || mark.how === 'dismissed')) {
      closed = { how: mark.how, at: mark.at || null, by: mark.by || null, messageId: mark.messageId || null };
    } else if (e.resolved) {
      closed = { how: 'resolved' };
    } else {
      // Questions of the lead that the entry names and the console knows.
      const named = [...new Set(`${e.title}\n${e.body}`.match(ASK_IN_TEXT) || [])].map((id) => asks.find((a) => a.id === id)).filter(Boolean);
      if (named.length && named.every((a) => !a.open)) closed = { how: 'question', ask: named[0].id };
    }
    return { key: e.key, title: e.title, body: e.body, open: !closed, closed };
  });
}

/** How many entries still wait for the owner. */
export function openEscalationCount(project) {
  try {
    return escalationList(project).filter((e) => e.open).length;
  } catch {
    return 0;
  }
}

/** An entry of the file as it is now, by key. Throws for a key the file does not have. */
export function findEscalation(project, key) {
  if (!KEY_RE.test(key || '')) throw new Error('Bad escalation id');
  const entry = escalationList(project).find((e) => e.key === key);
  if (!entry) throw new Error('This escalation is no longer in the file');
  return entry;
}

/** The owner is done with an entry: it stops counting at once. */
export function closeEscalation(project, key, how, { by = 'owner', messageId = null } = {}) {
  if (how !== 'answered' && how !== 'dismissed') throw new Error('Unknown way to close');
  const entry = findEscalation(project, key);
  const present = new Set(parseEscalations(readFile(project)).map((e) => e.key));
  // Marks of entries the team has removed are dropped on the way.
  const kept = Object.fromEntries(Object.entries(marks(project)).filter(([k]) => KEY_RE.test(k) && present.has(k)));
  kept[key] = { how, at: new Date().toISOString(), by: String(by).slice(0, 80), messageId, title: entry.title };
  writeJson(marksFile(project), kept);
  return kept[key];
}

/** Take the owner's own mark back: the entry waits again (unless the team resolved it). */
export function reopenEscalation(project, key) {
  if (!KEY_RE.test(key || '')) throw new Error('Bad escalation id');
  const all = marks(project);
  if (all[key]) {
    delete all[key];
    writeJson(marksFile(project), all);
  }
  return { ok: true };
}
