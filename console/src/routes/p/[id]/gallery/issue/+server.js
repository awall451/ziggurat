import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { mediaFile } from '$lib/server/aggregate.js';
import { create } from '$lib/server/issues.js';
import { audit } from '$lib/server/audit.js';

/**
 * Raise an issue from a gallery screenshot. JSON body: title, body, kind,
 * date, file, markup (shapes) and optional markupPng (base64 PNG of the
 * screenshot with the drawing on it).
 *
 * JSON rather than a multipart form: SvelteKit refuses form posts whose
 * Origin differs from the origin it assumes (https behind adapter-node),
 * and the console's own Origin check in hooks.server.js already covers this.
 */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== 'object') error(400, 'Bad request');
  const shot = mediaFile(project, `shots/${data.date}/${data.file}`);
  if (!shot) error(400, 'No such screenshot');
  let markupPng = null;
  if (data.markupPng != null) {
    if (typeof data.markupPng !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data.markupPng)) error(400, 'Bad markup image');
    markupPng = Buffer.from(data.markupPng, 'base64');
  }
  try {
    const issue = await create(project, locals.user, {
      title: data.title,
      body: data.body,
      kind: data.kind,
      origin: { type: 'gallery', date: data.date, file: data.file },
      markup: data.markup,
      shot: shot.file,
      markupPng
    });
    audit(locals.user, project.id, 'issue-create', { id: issue.id, screen: issue.origin?.screen }, { ok: issue.delivered, detail: issue.error });
    return json({ id: issue.id, delivered: issue.delivered, error: issue.error });
  } catch (e) {
    error(400, e.message);
  }
}
