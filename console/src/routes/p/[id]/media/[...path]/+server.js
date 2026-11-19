import fs from 'node:fs';
import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { mediaFile } from '$lib/server/aggregate.js';

/** Screenshots and digest audio from the project's pulled data. */
export function GET({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const found = mediaFile(project, params.path);
  if (!found) error(404, 'Not found');
  const data = fs.readFileSync(found.file);
  return new Response(data, {
    headers: {
      'Content-Type': found.type,
      'Content-Length': String(data.length),
      'Cache-Control': 'private, max-age=300'
    }
  });
}
