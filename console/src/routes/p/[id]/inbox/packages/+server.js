import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { decideRequest } from '$lib/server/packages.js';

/** The owner approves or declines a package or domain request (kit 0.16). JSON body {decision, rid}. */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') error(400, 'Bad request');
  try {
    return json(await decideRequest(locals.user, project, String(b.rid ?? ''), String(b.decision ?? '')));
  } catch (e) {
    error(400, e.message);
  }
}
