import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { send, deliver } from '$lib/server/feedback.js';
import { audit } from '$lib/server/audit.js';

/** Send a message to the lead, or retry one that did not arrive ({retry: id}). */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') error(400, 'Bad request');
  try {
    const meta = body.retry
      ? await deliver(project, String(body.retry))
      : await send(project, locals.user, {
          tier: body.tier,
          text: body.text,
          attachments: Array.isArray(body.attachments) ? body.attachments.map(String) : [],
          inReplyTo: body.inReplyTo || null
        });
    audit(locals.user, project.id, body.retry ? 'message-retry' : 'message-send', { id: meta.id, tier: meta.tier, inReplyTo: meta.inReplyTo }, {
      ok: meta.delivered,
      detail: meta.error
    });
    return json({ id: meta.id, delivered: meta.delivered, error: meta.error });
  } catch (e) {
    error(400, e.message);
  }
}
