// History of how runs went, one line per finished run, kept in the console's
// data folder: <data>/metrics/<project>.jsonl. A line is written once, when
// the run's ledger line has arrived, from the ledger and the transcripts. It
// stays when the transcripts are cleaned up later. Everything it is built
// from was written inside a sandbox and is read as data only.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getPricing } from './config.js';
import { readCycles, parseGateLog } from './aggregate.js';
import { sessionUsage } from './transcripts.js';
import { makeLabeler } from './theme.js';

const DAY = 24 * 3600 * 1000;
const fileFor = (project) => path.join(DATA_DIR, 'metrics', `${project.id}.jsonl`);
const round = (n, d = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

export function readMetrics(project) {
  const out = [];
  let text = '';
  try {
    text = fs.readFileSync(fileFor(project), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o.key === 'string') out.push(o);
    } catch {
      /* skip a bad line */
    }
  }
  return out;
}

function gateRows(project) {
  try {
    return parseGateLog(fs.readFileSync(path.join(project.paths.fleet, 'history.log'), 'utf8').slice(-2_000_000)).filter((g) => !g.canary && !g.proof);
  } catch {
    return [];
  }
}

const outcomeOf = (c) => (c.limited ? 'limited' : c.overrun ? 'overrun' : c.halted ? 'halted' : c.rc !== 0 || c.isError ? 'failed' : 'done');

/** One history line for a ledger line, or null while its transcript has not arrived. */
function lineFor(project, c, { usage, item, gate, now }) {
  const base = {
    v: 1,
    key: c.kind === 'chat' ? `chat:${c.chat}` : c.session,
    kind: c.kind,
    start: c.start,
    end: c.end,
    secs: c.secs,
    outcome: outcomeOf(c),
    turns: c.turns,
    ledgerUsd: round(c.costUsd),
    estMin: c.estMin ?? item?.minutes ?? null,
    estUsd: item?.cost ?? null,
    tokens: c.tokens
  };
  if (c.kind === 'chat') return base;
  if (!usage) {
    // No transcript here. Keep what the ledger says once it is clear none will come.
    const age = now - Date.parse(c.end || c.start || '');
    return c.tokens || age > DAY ? base : null;
  }
  const tokens = { in: 0, out: 0, cr: 0, cw: 0, think: 0 };
  const byRole = {};
  let agents = 0;
  for (const [k, r] of Object.entries(usage.byRole)) {
    tokens.in += r.input;
    tokens.out += r.output;
    tokens.cr += r.cacheRead;
    tokens.cw += r.cacheWrite;
    tokens.think += r.thinking;
    agents += r.agents;
    byRole[k] = { costUsd: round(r.costUsd), agents: r.agents };
  }
  const redo = usage.areaLeads.filter((a) => a.redo);
  const inRun = gate.filter((g) => c.start && c.end && g.at >= c.start && g.at <= c.end);
  return {
    ...base,
    costUsd: round(usage.costUsd),
    tokens,
    parts: Object.fromEntries(Object.entries(usage.parts).map(([k, v]) => [k, round(v)])),
    byRole,
    agents,
    areaLeads: usage.areaLeads.map((a) => ({ model: a.model, costUsd: round(a.costUsd), redo: a.redo })),
    rewrite: { count: usage.rewrite.count, costUsd: round(usage.rewrite.costUsd) },
    redo: { count: redo.length, costUsd: round(redo.reduce((t, a) => t + a.costUsd, 0)) },
    gate: {
      merged: inRun.filter((g) => g.status === 'merged' && !g.detail.includes('contained')).length,
      refused: inRun.filter((g) => g.status === 'failed' || g.status === 'rejected').length
    }
  };
}

/**
 * Add a line for every finished run that has none yet. Safe to call often.
 * `itemForJob` gives a one-shot job's proposal (its estimate); it is passed in
 * because the backlog module is heavy and not needed by every caller.
 * @returns {number} lines added
 */
export function recordMetrics(project, { itemForJob = () => null, now = Date.now() } = {}) {
  const have = new Set(readMetrics(project).map((m) => m.key));
  const opts = { pricing: getPricing(), labeler: makeLabeler(project) };
  const gate = gateRows(project);
  const added = [];
  for (const c of readCycles(project.paths.fleet)) {
    const key = c.kind === 'chat' ? (c.chat ? `chat:${c.chat}` : null) : c.session;
    if (!key || have.has(key) || !c.start) continue;
    let usage = null;
    let item = null;
    if (c.kind !== 'chat') {
      try {
        usage = sessionUsage(project, c.session, opts);
      } catch {
        usage = null;
      }
      if (c.oneshot && c.kind === 'oneshot') item = itemForJob(project, c.oneshot);
    }
    const line = lineFor(project, c, { usage, item, gate, now });
    if (!line) continue;
    have.add(key);
    added.push(JSON.stringify(line));
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(fileFor(project)), { recursive: true });
    fs.appendFileSync(fileFor(project), added.join('\n') + '\n');
  }
  return added.length;
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

/** Monday (UTC) of the week a time falls in, as YYYY-MM-DD. */
function weekOf(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

/** Per week and kind of run: how many, what they cost and took, and how the estimates held up. Newest week first. */
export function weekly(lines) {
  const groups = new Map();
  for (const m of lines) {
    const week = weekOf(m.start);
    if (!week) continue;
    const k = `${week} ${m.kind}`;
    if (!groups.has(k)) groups.set(k, { week, kind: m.kind, rows: [] });
    groups.get(k).rows.push(m);
  }
  const ORDER = ['normal', 'oneshot', 'plan', 'chat'];
  return [...groups.values()]
    .map(({ week, kind, rows }) => {
      const cost = (m) => m.costUsd ?? m.ledgerUsd;
      const total = rows.reduce((t, m) => t + (cost(m) || 0), 0);
      const finished = rows.filter((m) => m.outcome === 'done' && m.estMin > 0 && m.secs > 0);
      return {
        week,
        kind,
        runs: rows.length,
        costUsd: round(total, 2),
        medianUsd: round(median(rows.map(cost)), 2),
        medianMin: round(median(rows.map((m) => (m.secs ?? NaN) / 60)), 0),
        // Minutes it took against the minutes estimated; the middle one of the jobs that had an estimate and finished.
        timeRatio: round(median(finished.map((m) => m.secs / 60 / m.estMin)), 1),
        costRatio: round(median(finished.filter((m) => m.estUsd > 0 && cost(m) > 0).map((m) => cost(m) / m.estUsd)), 1),
        estimated: finished.length,
        rewriteUsd: round(rows.reduce((t, m) => t + (m.rewrite?.costUsd || 0), 0), 2),
        redo: rows.reduce((t, m) => t + (m.redo?.count || 0), 0),
        redoUsd: round(rows.reduce((t, m) => t + (m.redo?.costUsd || 0), 0), 2),
        merged: rows.reduce((t, m) => t + (m.gate?.merged || 0), 0),
        refused: rows.reduce((t, m) => t + (m.gate?.refused || 0), 0),
        notDone: rows.filter((m) => m.outcome !== 'done').length
      };
    })
    .sort((a, b) => (a.week === b.week ? ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) : a.week < b.week ? 1 : -1));
}
