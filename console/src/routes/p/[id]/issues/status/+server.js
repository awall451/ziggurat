import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { setStatus, deliver } from '$lib/server/issues.js';
import { audit } from '$lib/server/audit.js';

/** Owner moves an issue ({id, status, note}) or retries delivery ({retry: id}). */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') error(400, 'Bad request');
  try {
    if (body.retry) {
      const issue = await deliver(project, String(body.retry));
      audit(locals.user, project.id, 'issue-retry', { id: issue.id }, { ok: issue.delivered, detail: issue.error });
      return json({ id: issue.id, delivered: issue.delivered, error: issue.error });
    }
    const issue = await setStatus(project, locals.user, String(body.id || ''), String(body.status || ''), body.note);
    audit(locals.user, project.id, 'issue-status', { id: issue.id, status: issue.status });
    return json({ id: issue.id, status: issue.status });
  } catch (e) {
    error(400, e.message);
  }
}
