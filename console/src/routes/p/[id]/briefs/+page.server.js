import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { peekStatus } from '$lib/server/live.js';
import { listSessions, leadReport } from '$lib/server/transcripts.js';
import { briefs } from '$lib/server/aggregate.js';
import { ledgerPulledAt } from '$lib/server/pull.js';

/**
 * One brief per finished cycle (written on the workstation by
 * workstation/agent-brief). A cycle without one yet shows the lead's own
 * final report instead.
 */
export async function load({ params, url, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent(); // the layout has just refreshed the live status
  const status = peekStatus(project.id);
  const sessions = listSessions(project, status, { ledgerAt: ledgerPulledAt(project.id) });
  const all = briefs(project);
  const cycles = sessions.map((s) => ({
    id: s.id,
    number: s.number,
    state: s.state,
    live: s.live,
    started: s.started,
    ended: s.live ? null : s.ended,
    costUsd: s.costUsd,
    secs: s.secs,
    agents: s.agents,
    brief: all.get(s.id)?.md != null,
    mp3: !!all.get(s.id)?.mp3
  }));
  const wanted = url.searchParams.get('s');
  const pick = cycles.find((c) => c.id === wanted) || cycles.find((c) => !c.live) || cycles[0] || null;
  const md = pick?.brief ? briefs(project, pick.id).get(pick.id)?.md || null : null;
  return {
    cycles,
    picked: pick?.id || null,
    brief: md,
    report: pick && !md && !pick.live ? leadReport(project, pick.id) : null
  };
}
