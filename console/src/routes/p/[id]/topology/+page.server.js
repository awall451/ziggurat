import { error } from '@sveltejs/kit';
import { getProject, getPricing } from '$lib/server/config.js';
import { peekStatus } from '$lib/server/live.js';
import { listSessions, sessionTree } from '$lib/server/transcripts.js';
import { makeLabeler } from '$lib/server/theme.js';
import { ledgerPulledAt } from '$lib/server/pull.js';
import { taskAtHand } from '$lib/server/task.js';

export async function load({ params, url, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent(); // the layout has just refreshed the live status
  const status = peekStatus(project.id);
  const ledgerAt = ledgerPulledAt(project.id);
  const sessions = listSessions(project, status, { ledgerAt });
  const wanted = url.searchParams.get('s');
  const pick = sessions.find((s) => s.id === wanted) || sessions.find((s) => s.live) || sessions[0] || null;
  const tree = pick ? sessionTree(project, pick.id, { status, pricing: getPricing(), labeler: makeLabeler(project), ledgerAt }) : null;
  // What this cycle is for; with no cycle running and none picked by hand, also why and what is next.
  const task = taskAtHand(project, { status, tree, row: pick, following: !wanted });
  return { sessions, picked: pick?.id || null, following: !wanted, tree, task };
}
