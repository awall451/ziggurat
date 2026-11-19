import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { close } from '$lib/server/feedback.js';
import { audit } from '$lib/server/audit.js';

/** The owner is done with a message: the lead is no longer shown it. */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const body = await request.json().catch(() => null);
  try {
    const meta = await close(project, String(body?.id || ''));
    audit(locals.user, project.id, 'message-close', { id: meta.id });
    return json({ ok: true });
  } catch (e) {
    audit(locals.user, project.id, 'message-close', { id: String(body?.id || '') }, { ok: false, detail: e.message });
    error(400, e.message);
  }
}
