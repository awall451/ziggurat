import { error } from '@sveltejs/kit';
import { getProject, getPricing } from '$lib/server/config.js';
import { listSessions, sessionUsage } from '$lib/server/transcripts.js';
import { makeLabeler } from '$lib/server/theme.js';
import { trials } from '$lib/server/aggregate.js';

const MAX_CYCLES = 30;

export function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const opts = { pricing: getPricing(), labeler: makeLabeler(project) };
  const sessions = listSessions(project).slice(0, MAX_CYCLES);
  const cycles = [];
  for (const s of sessions) {
    const u = sessionUsage(project, s.id, opts);
    if (u) cycles.push({ ...u, number: s.number, state: s.state, ledgerUsd: s.costUsd });
  }
  cycles.reverse(); // oldest first, for the charts
  return { cycles, trials: trials(project), maxCycles: MAX_CYCLES };
}
