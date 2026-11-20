import fs from 'node:fs';
import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { attachment } from '$lib/server/issues.js';

// Raster images open in the browser; everything else (SVG included) downloads.
const INLINE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** A file the owner attached to an issue. */
export function GET({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const file = attachment(project, params.issue, params.name);
  if (!file) error(404, 'Not found');
  const data = fs.readFileSync(file);
  const ext = (params.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  const type = INLINE[ext];
  return new Response(data, {
    headers: {
      'Content-Type': type || 'application/octet-stream',
      'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename="${params.name}"`,
      'Content-Length': String(data.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600'
    }
  });
}
