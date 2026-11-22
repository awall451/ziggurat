import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { decideRequest, retryRequest, removeDomain, watchFetch, describe } from '$lib/server/packages.js';

/**
 * The owner approves or declines a package or domain request (kit 0.16), tries a
 * failed one again, or takes a domain back off the gateway (kit 0.17).
 * JSON body {decision: 'approve'|'deny'|'retry', rid} or {decision: 'remove-domain', domain}.
 */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') error(400, 'Bad request');
  try {
    if (b.decision === 'remove-domain') return json(await removeDomain(locals.user, project, String(b.domain ?? '')));
    if (b.decision === 'retry') {
      const out = await retryRequest(locals.user, project, String(b.rid ?? ''));
      watchFetch(project);
      return json(out);
    }
    const out = await decideRequest(locals.user, project, String(b.rid ?? ''), String(b.decision ?? ''));
    // A recipe with files to fetch: look for what it needs soon, not at the next full pull.
    if (b.decision === 'approve' && describe(out.request)?.fetch?.length) watchFetch(project);
    return json(out);
  } catch (e) {
    error(400, e.message);
  }
}
