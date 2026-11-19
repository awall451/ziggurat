import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { digests } from '$lib/server/aggregate.js';

export function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  return { digests: digests(project) };
}
