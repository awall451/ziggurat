import fs from 'node:fs';
import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { image } from '$lib/server/issues.js';

/** The screenshot or markup drawing kept with an issue. */
export function GET({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const file = image(project, params.issue, params.name);
  if (!file) error(404, 'Not found');
  const data = fs.readFileSync(file);
  return new Response(data, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(data.length), 'Cache-Control': 'private, max-age=3600' } });
}
