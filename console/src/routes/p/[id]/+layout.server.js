import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { projectView } from '$lib/server/view.js';

export async function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  return { project: await projectView(project) };
}
