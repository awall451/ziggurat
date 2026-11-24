import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { stepDetail } from '$lib/server/talk.js';

/** One step of the lead's answer in full (its input and output), when the owner opens it. */
export function GET({ params, url }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const step = stepDetail(project, url.searchParams.get('c') || '', url.searchParams.get('m') || '', Number(url.searchParams.get('i')));
  if (!step) error(404, 'No such step');
  return json(step, { headers: { 'cache-control': 'no-store' } });
}
