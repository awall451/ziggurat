import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { send } from '$lib/server/feedback.js';
import { findEscalation, closeEscalation, reopenEscalation } from '$lib/server/escalations.js';
import { audit } from '$lib/server/audit.js';

/**
 * The owner deals with an escalation: {action: 'answer', key, text} sends the
 * answer to the lead as a note and closes the entry; 'dismiss' closes it with
 * nothing sent; 'reopen' takes the owner's mark back.
 */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const body = await request.json().catch(() => null);
  const action = String(body?.action || '');
  const key = String(body?.key || '');
  try {
    if (action === 'dismiss') {
      closeEscalation(project, key, 'dismissed', { by: locals.user.name });
      audit(locals.user, project.id, 'escalation-dismiss', { key });
      return json({ ok: true });
    }
    if (action === 'reopen') {
      reopenEscalation(project, key);
      audit(locals.user, project.id, 'escalation-reopen', { key });
      return json({ ok: true });
    }
    if (action === 'answer') {
      const entry = findEscalation(project, key);
      const text = String(body?.text || '').trim();
      if (!text) throw new Error('Write an answer first');
      // The heading is the team's own text: quoted so the lead knows which entry this is about.
      const meta = await send(project, locals.user, { tier: 'note', text: `About your escalation "${entry.title}":\n\n${text}`, attachments: [], inReplyTo: null });
      closeEscalation(project, key, 'answered', { by: locals.user.name, messageId: meta.id });
      audit(locals.user, project.id, 'escalation-answer', { key, id: meta.id }, { ok: meta.delivered, detail: meta.error });
      return json({ ok: true, id: meta.id, delivered: meta.delivered, error: meta.error });
    }
    throw new Error('Unknown action');
  } catch (e) {
    audit(locals.user, project.id, ['answer', 'dismiss', 'reopen'].includes(action) ? `escalation-${action}` : 'escalation-unknown', { key: key.slice(0, 40) }, { ok: false, detail: e.message });
    error(400, e.message);
  }
}
