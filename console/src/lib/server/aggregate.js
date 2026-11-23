// Progress numbers for one project, computed from the pulled files in its
// fleet folder: cycles, gate verdicts, tests, issues, notes, screenshots,
// digests, trials. Everything here was written inside a sandbox, so it is
// read as data only and paths are checked before any file is served.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openEscalationCount } from './escalations.js';

const DAY = 24 * 3600 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readText(file, max = 2_000_000) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return '';
    const s = fs.readFileSync(file, 'utf8');
    return s.length > max ? s.slice(-max) : s;
  } catch {
    return '';
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The ledger's token counts as plain numbers, or null. */
function tokensOf(t) {
  if (!t || typeof t !== 'object') return null;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return { in: n(t.in), out: n(t.out), cr: n(t.cr), cw: n(t.cw), think: n(t.think) };
}

export function readCycles(fleet) {
  const out = [];
  for (const line of readText(path.join(fleet, 'cycles.jsonl')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      out.push({
        start: c.start ?? null,
        end: c.end ?? null,
        secs: c.secs ?? null,
        rc: c.rc ?? null,
        costUsd: c.cost_usd ?? null,
        turns: c.turns ?? null,
        session: c.session ?? null,
        limited: !!c.limited,
        halted: !!c.halted,
        // The overrun brake stopped it (kit 0.18).
        overrun: !!c.overrun,
        counted: c.counted !== false,
        isError: !!c.is_error,
        summary: c.summary || '',
        // Kit 0.10: normal, oneshot, plan or chat. Older lines have no kind.
        kind: ['normal', 'oneshot', 'plan', 'chat'].includes(c.kind) ? c.kind : c.oneshot ? 'oneshot' : 'normal',
        oneshot: typeof c.oneshot === 'string' ? c.oneshot : null,
        // A normal cycle the owner started with no job (kit 0.25).
        free: c.free === true,
        plan: typeof c.plan === 'string' ? c.plan : null,
        // A chat turn's own id.
        chat: typeof c.chat === 'string' && /^[0-9]{8}T[0-9]{6}Z-c-[a-f0-9]{6}$/.test(c.chat) ? c.chat : null,
        // Kit 0.19: the job's estimate in minutes, and the tokens of the whole run.
        estMin: Number.isInteger(c.est_min) && c.est_min > 0 && c.est_min <= 1440 ? c.est_min : null,
        tokens: tokensOf(c.tokens),
        // The schedule slot that started it (kit 0.9), as "daily@18:00".
        slot: typeof c.slot === 'string' && /^[a-z,]{3,27}@\d{2}:\d{2}$/.test(c.slot) ? c.slot : null
      });
    } catch {
      /* skip a bad line */
    }
  }
  return out;
}

/**
 * What a normal cycle of this team typically takes: the median length and cost
 * of its last ten real cycles (normal ones and one-shot jobs; planning cycles
 * and chat turns are short and say nothing about a cycle). {secs, costUsd, n}.
 */
export function typicalCycle(cycles) {
  const real = cycles.filter((c) => c.counted && !c.halted && c.kind !== 'chat' && c.kind !== 'plan' && Number.isFinite(c.secs) && c.secs > 60).slice(-10);
  const median = (xs) => {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  return { secs: median(real.map((c) => c.secs)), costUsd: median(real.map((c) => c.costUsd)), n: real.length };
}

// "<time> <topic> <sha> <status> <detail>"
const GATE_RE = /^(\S+) (\S+) (\S+) (\S+) ?(.*)$/;

export function parseGateLog(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = GATE_RE.exec(line.trim());
    if (!m) continue;
    const [, at, topic, sha, status, detail] = m;
    const t = /\((\d+) tests\)/.exec(detail);
    rows.push({
      at,
      topic,
      sha: sha.slice(0, 9),
      status,
      detail,
      tests: t ? Number(t[1]) : null,
      canary: topic.startsWith('canary'),
      // The owner's gate proof (agent-kit-gate-proof): one branch that must be
      // merged and one that must be refused. Not the team's work.
      proof: topic.startsWith('gate-proof-')
    });
  }
  return rows;
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseIssue(name, text) {
  const stem = name.replace(/\.md$/, '');
  const meta = {};
  let body = text;
  const m = FM_RE.exec(text);
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  return {
    file: name,
    id: meta.id || stem.split('-')[0],
    title: meta.title || stem,
    severity: (meta.severity || 'n/a').toLowerCase(),
    area: meta.area || '',
    status: (meta.status || 'open').toLowerCase(),
    found: meta.found || '',
    body: body.trim()
  };
}

const CLOSED = new Set(['closed', 'fixed', 'done']);
const isRecent = (iso, since) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? false : t >= since;
};

/** Small summary for the projects page and the project header. */
export function summary(project) {
  const fleet = project.paths.fleet;
  const cycles = readCycles(fleet);
  const gate = parseGateLog(readText(path.join(fleet, 'history.log')));
  const since = Date.now() - DAY;
  // A chat turn with the lead is not a cycle: its cost counts, the turn does not.
  const recent = cycles.filter((c) => isRecent(c.start, since));
  const recentCycles = recent.filter((c) => c.kind !== 'chat');
  // The team's own results only: a gate proof's refused branch is the gate
  // working, and must not read as a failure of the team.
  const recentGate = gate.filter((g) => !g.canary && !g.proof && isRecent(g.at, since));
  let testsNow = null;
  for (const g of gate) if (g.tests != null) testsNow = g.tests;
  const issuesDir = path.join(fleet, 'notes', 'agents', 'issues');
  const issues = listDir(issuesDir)
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => parseIssue(d.name, readText(path.join(issuesDir, d.name), 20000)));
  const last = cycles.findLast((c) => c.kind !== 'chat') || null;
  return {
    last24: {
      cycles: recentCycles.length,
      costUsd: Math.round(recent.reduce((t, c) => t + (c.costUsd || 0), 0) * 100) / 100,
      merged: recentGate.filter((g) => g.status === 'merged' && !g.detail.includes('contained')).length,
      failed: recentGate.filter((g) => g.status === 'failed' || g.status === 'rejected').length,
      minutes: Math.round(recentCycles.reduce((t, c) => t + (c.secs || 0), 0) / 60)
    },
    testsNow,
    cyclesCounted: cycles.filter((c) => c.counted).length,
    lastCycle: last,
    issuesOpen: issues.filter((i) => !CLOSED.has(i.status) && i.severity !== 'n/a').length,
    // Only the entries that still wait for the owner (see escalations.js).
    escalations: openEscalationCount(project)
  };
}

export function progress(project) {
  const fleet = project.paths.fleet;
  const cycles = readCycles(fleet).filter((c) => c.kind !== 'chat');
  const gate = parseGateLog(readText(path.join(fleet, 'history.log')));
  return {
    cycles,
    gate: gate.slice().reverse().slice(0, 80),
    testsSeries: gate.filter((g) => g.tests != null).map((g) => ({ at: g.at, tests: g.tests }))
  };
}

/** Markdown files under notes/, as relative paths, for the Notes tab's file list. */
function walkNotes(dir, rel = '', out = [], depth = 0) {
  if (depth > 4 || out.length > 400) return out;
  for (const d of listDir(dir)) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) walkNotes(path.join(dir, d.name), r, out, depth + 1);
    else if (d.isFile() && d.name.endsWith('.md')) out.push(r);
  }
  return out;
}

export function notes(project) {
  const dir = path.join(project.paths.fleet, 'notes');
  const agents = path.join(dir, 'agents');
  const issuesDir = path.join(agents, 'issues');
  const order = { blocker: 0, critical: 0, major: 1, minor: 2, polish: 3 };
  const issues = listDir(issuesDir)
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => parseIssue(d.name, readText(path.join(issuesDir, d.name), 60000)))
    .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.id.localeCompare(b.id));
  return {
    state: readText(path.join(agents, 'STATE.md')),
    journal: readText(path.join(agents, 'JOURNAL.md'), 60000),
    escalations: readText(path.join(agents, 'ESCALATIONS.md')),
    issues,
    files: walkNotes(dir)
      .filter((f) => !f.startsWith('agents/issues/') && !/^agents\/(STATE|JOURNAL|ESCALATIONS)\.md$/.test(f))
      .sort()
  };
}

/** One markdown file from notes/, by relative path. Returns null if the path is not allowed. */
export function noteFile(project, rel) {
  const file = resolveInside(path.join(project.paths.fleet, 'notes'), rel);
  return file && file.endsWith('.md') ? readText(file) : null;
}

export function gallery(project) {
  const dir = path.join(project.paths.fleet, 'shots');
  const days = {};
  for (const d of listDir(dir)) {
    if (!d.isDirectory() || !DATE_RE.test(d.name)) continue;
    const files = listDir(path.join(dir, d.name))
      .filter((f) => f.isFile() && /^[A-Za-z0-9._-]+\.png$/.test(f.name))
      .map((f) => f.name)
      .sort();
    if (files.length) days[d.name] = files;
  }
  return Object.keys(days)
    .sort()
    .reverse()
    .map((date) => ({ date, files: days[date] }));
}

const SHA40_RE = /^[0-9a-f]{40}$/;
const SHOT_FILE_RE = /^[A-Za-z0-9._-]{1,100}\.png$/;
const TOPIC_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const ms = (iso) => Date.parse(iso || '');

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

// sha256 of screenshots already hashed. A build folder never changes after the
// pull (rsync keeps the times), so path + size + time names the content.
const hashed = new Map();

/** Screen key -> sha256 for the screenshots of one build folder. */
function shotHashes(dir, files) {
  const out = new Map();
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      const id = `${file}:${st.size}:${st.mtimeMs}`;
      let h = hashed.get(id);
      if (!h) {
        h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        hashed.set(id, h);
      }
      out.set(screenKey(f), h);
    } catch {
      // unreadable: left out, so it shows as new rather than hidden
    }
  }
  return out;
}

/**
 * Screenshots of every merged build (kit 0.13: the gate keeps them by sha and
 * writes shots/index, "<iso> <sha> <topic>"), grouped by the cycle that made
 * them. A merge belongs to the newest cycle that started at or before it: the
 * gate judges a branch minutes after the cycle that submitted it. Merges before
 * the first cycle (the gate proof, the seed) are "setup". Chat turns are not
 * cycles. `live` is the cycle in progress ({session, start}), which has no
 * ledger line yet. Only cycles with at least one build are returned, newest
 * first, each with its builds newest first.
 */
export function galleryCycles(project, live = null) {
  const fleet = project.paths.fleet;
  const dir = path.join(fleet, 'shots');
  const builds = [];
  const seen = new Set();
  for (const line of readText(path.join(dir, 'index'), 500_000).split('\n')) {
    const [at, sha, topic] = line.trim().split(/\s+/);
    if (!SHA40_RE.test(sha || '') || seen.has(sha) || !Number.isFinite(ms(at))) continue;
    const files = listDir(path.join(dir, sha))
      .filter((f) => f.isFile() && SHOT_FILE_RE.test(f.name))
      .map((f) => f.name)
      .sort();
    if (!files.length) continue;
    seen.add(sha);
    builds.push({ sha, topic: TOPIC_RE.test(topic || '') ? topic : '', at, files });
  }

  // Numbered like the Topology and Briefs pickers: counted ledger lines, in order.
  let n = 0;
  const cycles = [];
  for (const c of readCycles(fleet)) {
    const number = c.counted && c.session ? ++n : null;
    if (c.kind === 'chat' || !Number.isFinite(ms(c.start))) continue;
    cycles.push({ key: c.session || c.start, session: c.session, start: c.start, end: c.end, kind: c.kind, number, live: false });
  }
  if (live?.session && Number.isFinite(ms(live.start)) && !cycles.some((c) => c.session === live.session)) {
    cycles.push({ key: live.session, session: live.session, start: live.start, end: null, kind: live.kind || 'normal', number: n + 1, live: true });
  }
  cycles.sort((a, b) => ms(a.start) - ms(b.start));

  const groups = new Map();
  for (const b of builds) {
    let owner = null;
    for (const c of cycles) {
      if (ms(c.start) <= ms(b.at)) owner = c;
      else break;
    }
    const key = owner ? owner.key : 'setup';
    if (!groups.has(key)) groups.set(key, { ...(owner || { key: 'setup', session: null, start: null, end: null, kind: 'setup', number: null, live: false }), builds: [] });
    groups.get(key).builds.push(b);
  }
  const out = [...groups.values()];
  for (const g of out) g.builds.sort((a, b) => ms(b.at) - ms(a.at));

  // What each cycle made or changed. The gate renders every screen again on
  // every build, so a build folder is always the full set: a screenshot counts
  // for a cycle only if its bytes differ from the newest build before the cycle.
  const oldestFirst = [...out].sort((a, b) => (a.start == null ? -1 : b.start == null ? 1 : ms(a.start) - ms(b.start)));
  let before = null;
  for (const g of oldestFirst) {
    for (const b of g.builds) {
      const now = shotHashes(path.join(dir, b.sha), b.files);
      if (!before) {
        b.fresh = b.files.map((file) => ({ file, why: 'new' }));
        b.removed = 0;
      } else {
        b.fresh = [];
        for (const file of b.files) {
          const was = before.get(screenKey(file));
          if (was === undefined) b.fresh.push({ file, why: 'new' });
          else if (was !== now.get(screenKey(file))) b.fresh.push({ file, why: 'changed' });
        }
        b.removed = [...before.keys()].filter((k) => !now.has(k)).length;
      }
      b.hashes = now;
    }
    before = g.builds[0].hashes;
  }
  for (const g of out) for (const b of g.builds) delete b.hashes;
  // Newest first; setup (before any cycle) last.
  out.sort((a, b) => (a.start == null ? 1 : b.start == null ? -1 : ms(b.start) - ms(a.start)));
  return out;
}

const SID_NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(md|mp3)$/;

/**
 * Briefs written by workstation/agent-brief, one per finished cycle:
 * session id -> {md, mp3}. Reads the text of `only` (a session id) alone.
 */
export function briefs(project, only = null) {
  const dir = path.join(project.paths.fleet, 'briefs');
  const out = new Map();
  for (const d of listDir(dir)) {
    const m = d.isFile() && SID_NAME_RE.exec(d.name);
    if (!m) continue;
    const b = out.get(m[1]) || { md: null, mp3: false };
    if (m[2] === 'mp3') b.mp3 = true;
    else b.md = only === m[1] ? readText(path.join(dir, d.name), 100000) : '';
    out.set(m[1], b);
  }
  return out;
}

export function digests(project) {
  const dir = path.join(project.paths.fleet, 'digests');
  const names = new Set(listDir(dir).map((d) => d.name));
  return [...names]
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .sort()
    .reverse()
    .slice(0, 60)
    .map((n) => {
      const date = n.slice(0, 10);
      return { date, md: readText(path.join(dir, n), 100000), mp3: names.has(`${date}.mp3`) };
    });
}

export function trials(project) {
  const dir = path.join(project.paths.fleet, 'trials');
  const baseline = readJsonFile(path.join(dir, 'baseline-old-model.json'));
  const pngs = (d) =>
    listDir(d)
      .filter((f) => f.isFile() && /^[A-Za-z0-9._-]+\.png$/.test(f.name))
      .map((f) => f.name)
      .sort();
  return listDir(dir)
    .filter((d) => d.isFile() && d.name.endsWith('-result.json'))
    .map((d) => {
      const name = d.name.slice(0, -'-result.json'.length);
      const before = pngs(path.join(dir, name, 'before'));
      const after = pngs(path.join(dir, name, 'after'));
      return {
        name,
        result: readJsonFile(path.join(dir, d.name)),
        baseline,
        summary: readText(path.join(dir, name, 'lead-summary.md')) || readText(path.join(dir, name, 'eru-summary.md')),
        before,
        after,
        newScreens: after.filter((a) => !before.includes(a))
      };
    });
}

/**
 * Resolve `rel` under `base` and refuse anything that escapes it, including
 * through a symlink. Returns the real path or null.
 */
export function resolveInside(base, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const target = path.resolve(base, rel);
  let realBase;
  let real;
  try {
    realBase = fs.realpathSync(base);
    real = fs.realpathSync(target);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real === realBase || real.startsWith(realBase + path.sep) ? real : null;
}

const MEDIA = { '.png': 'image/png', '.mp3': 'audio/mpeg' };
const MEDIA_ROOTS = ['shots', 'digests', 'briefs', 'trials'];

/** A screenshot or digest audio file from the fleet folder, or null. */
export function mediaFile(project, rel) {
  const top = String(rel).split('/')[0];
  if (!MEDIA_ROOTS.includes(top)) return null;
  const type = MEDIA[path.extname(rel).toLowerCase()];
  if (!type) return null;
  const file = resolveInside(project.paths.fleet, rel);
  return file ? { file, type } : null;
}
