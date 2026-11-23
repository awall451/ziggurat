import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import { getProject, getPricing } from '$lib/server/config.js';
import { listSessions, sessionUsage } from '$lib/server/transcripts.js';
import { makeLabeler } from '$lib/server/theme.js';
import { trials, parseGateLog } from '$lib/server/aggregate.js';

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
  return { cycles, trials: trials(project), maxCycles: MAX_CYCLES };
}
