import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import { getProject, getPricing } from '$lib/server/config.js';
import { listSessions, sessionUsage } from '$lib/server/transcripts.js';
import { makeLabeler } from '$lib/server/theme.js';
import { trials, parseGateLog, readCycles } from '$lib/server/aggregate.js';
import { readMetrics, recordMetrics, weekly } from '$lib/server/metrics.js';
import { itemForJob } from '$lib/server/backlog.js';

const MAX_CYCLES = 30;

function gateRows(project) {
  try {
    const file = path.join(project.paths.fleet, 'history.log');
    if (!fs.lstatSync(file).isFile()) return [];
    return parseGateLog(fs.readFileSync(file, 'utf8').slice(-2_000_000));
  } catch {
    return [];
  }
}

/**
 * The gate's latest word on a work branch since the cycle began: "merged",
 * "failed", "rejected", or null when it was never submitted under that name.
 */
function gateResult(rows, branch, since) {
  const topic = String(branch || '').replace(/^(work|ready)\//, '');
  if (!topic) return null;
  let last = null;
  for (const g of rows) if (g.topic === topic && (!since || g.at >= since)) last = g.status;
  return last;
}

export function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const opts = { pricing: getPricing(), labeler: makeLabeler(project) };
  const sessions = listSessions(project).slice(0, MAX_CYCLES);
  const gate = gateRows(project);
  const cycles = [];
  for (const s of sessions) {
    const u = sessionUsage(project, s.id, opts);
    if (!u) continue;
    for (const a of u.areaLeads) a.gate = gateResult(gate, a.branch, u.started);
    cycles.push({ ...u, number: s.number, state: s.state, ledgerUsd: s.costUsd });
  }
  cycles.reverse(); // oldest first, for the charts
  // Normally written after each pull; here too, so the history is never behind the ledger shown.
  try {
    recordMetrics(project, { itemForJob });
  } catch {
    /* the page still shows what is recorded */
  }
  // Turns in the Chat tab (kit 0.33) over the same span as the cycles above: from the ledger,
  // since they belong to no cycle's session.
  const since = Math.min(...cycles.map((c) => Date.parse(c.started) || Infinity));
  const talkLines = readCycles(project.paths.fleet).filter((c) => c.kind === 'talk' && (!Number.isFinite(since) || Date.parse(c.start) >= since));
  const talk = { turns: talkLines.length, costUsd: talkLines.reduce((t, c) => t + (Number(c.costUsd) || 0), 0) };
  return { cycles, talk, trials: trials(project), maxCycles: MAX_CYCLES, overTime: weekly(readMetrics(project)).slice(0, 40) };
}
