import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { progress } from '$lib/server/aggregate.js';
import { history as publishHistory } from '$lib/server/publish.js';

export function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  return { progress: progress(project), publishes: project.publish?.remote ? publishHistory(project, 50) : null };
}
