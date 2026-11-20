import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { create, safeName } from '$lib/server/issues.js';
import { getStatus, kitAtLeast } from '$lib/server/live.js';
import { audit } from '$lib/server/audit.js';

const B64_RE = /^[A-Za-z0-9+/=]+$/;
const buf = (v, what) => {
  if (typeof v !== 'string' || !B64_RE.test(v)) error(400, `Bad ${what}`);
  return Buffer.from(v, 'base64');
};

/**
 * Raise an issue on the Issues page. JSON body: title, body, kind, and
 * optionally picture {name, png} (the main picture, already a PNG), markup
 * (shapes on it), markupPng (the picture with the drawing), attachments
 * [{name, data}] (more files, base64). JSON for the same reason as the
 * gallery's issue route: SvelteKit's own form-origin check.
 */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== 'object') error(400, 'Bad request');
  const list = Array.isArray(data.attachments) ? data.attachments : [];
  const attachments = list.map((a) => ({ name: safeName(a?.name), data: buf(a?.data, 'attachment') }));
  if (attachments.some((a) => !a.name)) error(400, 'An attachment has a name that cannot be used');
  if (attachments.length) {
    // The VM keeps attachments from kit 0.7 on; an older kit would refuse the whole issue.
    const status = await getStatus(project);
    if (status.reachable && !kitAtLeast(status.kitVersion, '0.7.0')) {
      error(400, `Attachments need kit 0.7 on the VM (it runs ${status.kitVersion || 'an older kit'}). Keep one picture, or upgrade the kit.`);
    }
  }
  const pic = data.picture && typeof data.picture === 'object' ? data.picture : null;
  try {
    const issue = await create(project, locals.user, {
      title: data.title,
      body: data.body,
      kind: data.kind,
      origin: pic ? { type: 'upload', name: pic.name } : null,
      markup: pic ? data.markup : [],
      shotPng: pic ? buf(pic.png, 'picture') : null,
      markupPng: pic && data.markupPng != null ? buf(data.markupPng, 'markup image') : null,
      attachments
    });
    audit(locals.user, project.id, 'issue-create', { id: issue.id, page: 'issues', files: attachments.length + (pic ? 1 : 0) }, { ok: issue.delivered, detail: issue.error });
    return json({ id: issue.id, delivered: issue.delivered, error: issue.error });
  } catch (e) {
    error(400, e.message);
  }
}
