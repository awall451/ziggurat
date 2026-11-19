import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { list, syncIssues } from '$lib/server/issues.js';
import { peekStatus } from '$lib/server/live.js';

export async function load({ params, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent();
  const status = peekStatus(project.id);
  // Wait briefly for the lead's updates, but never hold the page for a slow VM.
  if (status?.reachable && status.kitVersion) {
    await Promise.race([syncIssues(project), new Promise((r) => setTimeout(r, 2500))]);
  }
  return { issues: list(project) };
}
