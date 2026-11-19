import { error, text } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { noteFile } from '$lib/server/aggregate.js';

/** One markdown file from the project's merged docs, as plain text. */
export function GET({ params, url }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const body = noteFile(project, url.searchParams.get('path') || '');
  if (body == null) error(404, 'Not found');
  return text(body);
}
