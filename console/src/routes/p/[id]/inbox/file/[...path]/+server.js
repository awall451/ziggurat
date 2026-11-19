import fs from 'node:fs';
import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { attachment } from '$lib/server/feedback.js';

/**
 * An attachment: /inbox/file/sent/<message id>/<name> or /inbox/file/reply/<message id>/<name>.
 * Images are shown in the page; every other type is offered as a download,
 * because a reply's files were written inside a sandbox.
 */
export function GET({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const [kind, id, name, ...rest] = params.path.split('/');
  if (rest.length) error(404, 'Not found');
  const found = attachment(project, kind, id || '', name || '');
  if (!found) error(404, 'Not found');
  const data = fs.readFileSync(found.file);
  return new Response(data, {
    headers: {
      'Content-Type': found.type,
      'Content-Length': String(data.length),
      'Content-Disposition': `${found.inline ? 'inline' : 'attachment'}; filename="${found.name}"`,
      'Cache-Control': 'private, max-age=300'
    }
  });
}
