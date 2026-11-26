// Changes to what "done" means (kit 0.14). A ready branch that touches a path
// in the project's GATE_OWNER_PATHS (usually tools/check) is `held` by the gate
// until the owner approves that exact commit. This module lists held changes
// with the lead's plain-language explanation and the diff of those paths, and
// sends the owner's approve or deny. Everything read here was written inside
// the sandbox: it is checked and shown as data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { kit, pull, readScript } from './ssh.js';
import { parseHeaderFile } from './headerfile.js';
import { audit } from './audit.js';
import { invalidateStatus, kitAtLeast } from './live.js';

export const GATEHOLD_KIT = '0.14.0';
const SHA_RE = /^[0-9a-f]{40}$/;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MAX_HELD = 10;
const MAX_DIFF = 200_000;
const MAX_SUMMARY = 8000;

const outDir = (project) => path.join(DATA_DIR, 'gatehold', project.id, 'out');

const decisionsFile = (project) => path.join(DATA_DIR, 'gatehold', project.id, 'decisions.json');
const DECISION_KEEP_MS = 24 * 3600 * 1000;

/** The owner's decisions the VM has not caught up with yet: {sha: {decision, topic, at}}. */
export function readDecisions(project) {
  try {
    const o = JSON.parse(fs.readFileSync(decisionsFile(project), 'utf8'));
    const out = {};
    for (const [sha, d] of Object.entries(o || {})) {
      if (SHA_RE.test(sha) && d && ['approve', 'deny'].includes(d.decision) && Number.isFinite(Date.parse(d.at || ''))) out[sha] = { decision: d.decision, topic: TOPIC_RE.test(d.topic || '') ? d.topic : '', at: d.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeDecisions(project, o) {
  const f = decisionsFile(project);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(o));
  fs.renameSync(tmp, f);
}

/** What the gate finally did with a commit the owner approved: its result file, or null. */
export function parseSettled(text, sha) {
  try {
    const o = JSON.parse(text);
    if (!o || o.sha !== sha || !['merged', 'rejected', 'failed', 'held'].includes(o.status)) return null;
    return { status: o.status, detail: typeof o.detail === 'string' ? o.detail.replace(/[\p{Cc}]/gu, ' ').slice(0, 300) : '', at: Number.isFinite(Date.parse(o.at || '')) ? o.at : null };
  } catch {
    return null;
  }
}

/**
 * Put the owner's remembered decisions on the VM's list and settle the ones the
 * VM no longer lists. `read(topic)` gives the topic's result text (or throws).
 * Returns the held changes with `state`, the settled outcomes, and the decisions to keep.
 */
export async function reconcile(held, decisions, read, now = Date.now()) {
  const keep = {};
  const settled = [];
  const listed = new Set(held.map((h) => h.sha));
  const items = held.map((h) => {
    const fresh = decisions[h.sha] && now - Date.parse(decisions[h.sha].at) < DECISION_KEEP_MS;
    const d = fresh ? decisions[h.sha] : null;
    const approvedAt = h.approvedAt || (d?.decision === 'approve' ? d.at : null);
    if (d) keep[h.sha] = d;
    return { ...h, approvedAt, state: approvedAt ? 'approved' : d?.decision === 'deny' ? 'declined' : 'waiting' };
  });
  for (const [sha, d] of Object.entries(decisions)) {
    if (listed.has(sha) || now - Date.parse(d.at) >= DECISION_KEEP_MS) continue;
    if (d.decision === 'deny') continue; // the VM dropped it at once: nothing to report
    let r = null;
    try {
      r = parseSettled(await read(d.topic), sha);
    } catch {
      r = null;
    }
    settled.push({ sha, topic: d.topic, approvedAt: d.at, ...(r || { status: 'gone', detail: '', at: null }) });
  }
  return { items, settled, keep };
}

export const kitHasGateHold = (version) => kitAtLeast(version, GATEHOLD_KIT);

/** Parse `agent-kit-gate held` output: one JSON object per line. */
export function parseHeld(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || !TOPIC_RE.test(o.topic || '') || String(o.topic).includes('..') || !SHA_RE.test(o.sha || '')) continue;
    if (out.some((x) => x.sha === o.sha)) continue;
    out.push({
      topic: o.topic,
      sha: o.sha,
      at: Number.isFinite(Date.parse(o.at || '')) ? o.at : null,
      // Kit 0.35: when the owner approved it and the gate began judging it again.
      approvedAt: Number.isFinite(Date.parse(o.approvedAt || '')) ? o.approvedAt : null,
      detail: typeof o.detail === 'string' ? o.detail.replace(/[\p{Cc}]/gu, ' ').slice(0, 300) : ''
    });
    if (out.length >= MAX_HELD) break;
  }
  return out;
}

/** A fixed read-only script: the diff of the owner paths for each sha (already checked). */
export function diffScript(shas, marker) {
  if (!shas.every((s) => SHA_RE.test(s)) || !/^[A-Z0-9]{16}$/.test(marker)) throw new Error('Bad diff request');
  return [
    'set -u',
    'export LC_ALL=C',
    '. /etc/agent-kit/project.env',
    'set -f',
    'op=${GATE_OWNER_PATHS:-}',
    'read -ra P <<< "${op//,/ }"',
    'g() { sudo -n -u gatekeeper git -C "$BARE" "$@"; }',
    `for sha in ${shas.join(' ')}; do`,
    `  echo "@@${marker} $sha"`,
    '  [ ${#P[@]} -gt 0 ] || continue',
    `  g diff --no-color --no-ext-diff main...$sha -- "\${P[@]}" 2>&1 | head -c ${MAX_DIFF + 1}`,
    'done'
  ].join('\n');
}

/** Split the diff script's output into {sha: text}. */
export function parseDiffs(stdout, marker) {
  const out = {};
  let cur = null;
  for (const line of String(stdout || '').split('\n')) {
    const m = line.startsWith(`@@${marker} `) ? line.slice(marker.length + 3) : null;
    if (m != null && SHA_RE.test(m)) {
      cur = m;
      out[cur] = '';
    } else if (cur) out[cur] += `${line}\n`;
  }
  for (const k of Object.keys(out)) {
    const t = out[k].replace(/\n+$/, '');
    out[k] = t.length > MAX_DIFF ? { text: t.slice(0, MAX_DIFF), cut: true } : { text: t, cut: false };
  }
  return out;
}

/** The lead's explanation for a topic, from the pulled gate-out folder, or null. */
export function explanation(project, topic) {
  if (!TOPIC_RE.test(topic) || topic.includes('..')) return null;
  const f = parseHeaderFile(path.join(outDir(project), `${topic.replace(/\//g, '_')}.md`), MAX_SUMMARY + 1000);
  if (!f || f.fields.topic !== topic || !SHA_RE.test(f.fields.sha || '')) return null;
  return {
    sha: f.fields.sha,
    at: Number.isFinite(Date.parse(f.fields.date || '')) ? f.fields.date : null,
    text: f.body.slice(0, MAX_SUMMARY)
  };
}

/**
 * Held changes with the lead's explanation and the diff. One `agent-kit-gate
 * held`, one pull of gate-out (as the agent: it is the agent's folder), one
 * read-only diff script. Never throws; an unreachable VM gives an error.
 */
export async function heldChanges(project) {
  const res = await kit(project, 'agent-kit-gate', ['held']);
  if (res.code !== 0) return { held: [], settled: [], error: (res.stderr || `exit ${res.code}`).trim().slice(-200) };
  const held = parseHeld(res.stdout);
  const decisions = readDecisions(project);
  const rec = await reconcile(held, decisions, async (topic) => {
    const r = await kit(project, 'gate-status', [topic]);
    if (r.code !== 0) throw new Error('no result');
    return r.stdout;
  });
  if (JSON.stringify(rec.keep) !== JSON.stringify(decisions)) writeDecisions(project, rec.keep);
  if (!held.length) return { held: [], settled: rec.settled, error: null };
  fs.mkdirSync(outDir(project), { recursive: true });
  await pull(project, [`${project.kit.state}/gate-out/`], outDir(project), {
    as: 'agent',
    maxSize: '64k',
    timeout: 60000,
    filters: ['--include=*.md', '--exclude=*']
  }).catch(() => {});
  const marker = crypto.randomBytes(8).toString('hex').toUpperCase();
  const d = await readScript(project, diffScript(held.map((h) => h.sha), marker), { timeout: 30000 }).catch(() => null);
  const diffs = d && d.code === 0 ? parseDiffs(d.stdout, marker) : {};
  return {
    settled: rec.settled,
    held: rec.items.map((h) => {
      const e = explanation(project, h.topic);
      return {
        ...h,
        summary: e ? { text: e.text, at: e.at, current: e.sha === h.sha } : null,
        diff: diffs[h.sha] || null
      };
    }),
    error: d && d.code === 0 ? null : 'could not read the diff'
  };
}

/** The owner's decision on one held change. */
export async function decideHeld(user, project, sha, decision, topic = '') {
  if (!SHA_RE.test(sha)) throw new Error('Bad commit');
  if (!['approve', 'deny'].includes(decision)) throw new Error('Bad decision');
  const res = await kit(project, 'agent-kit-gate', [decision, sha]);
  const ok = res.code === 0;
  const detail = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-200);
  audit(user, project.id, decision === 'approve' ? 'gate-approve' : 'gate-deny', { sha }, { ok, detail });
  invalidateStatus(project.id);
  if (!ok) throw new Error(detail);
  // Remember it until the VM lists it as approved or stops listing it: a reload must not bring the buttons back.
  const all = readDecisions(project);
  all[sha] = { decision, topic: TOPIC_RE.test(topic) && !topic.includes('..') ? topic : '', at: new Date().toISOString() };
  writeDecisions(project, all);
  return { ok: true, message: (res.stdout || '').trim().slice(0, 300), at: all[sha].at };
}
