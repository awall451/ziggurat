import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { threads, syncOutbox } from '$lib/server/feedback.js';
import { peekStatus } from '$lib/server/live.js';
import { notes } from '$lib/server/aggregate.js';

export async function load({ params, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent();
  const status = peekStatus(project.id);
  // Wait briefly for fresh replies, but never hold the page for a slow VM.
  if (status?.reachable && status.kitVersion) {
    await Promise.race([syncOutbox(project), new Promise((r) => setTimeout(r, 2500))]);
  }
  return { ...threads(project), escalations: notes(project).escalations };
}
