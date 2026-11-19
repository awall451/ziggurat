import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { refresh, pullInfo } from '$lib/server/pull.js';
import { invalidateStatus } from '$lib/server/live.js';

/** Pull fresh data from the VM now (read-only on the VM side). */
export async function POST({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  invalidateStatus(project.id);
  await refresh(project);
  return json(pullInfo(project.id));
}
