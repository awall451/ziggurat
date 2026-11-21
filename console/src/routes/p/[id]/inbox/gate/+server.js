import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { decideHeld } from '$lib/server/gatehold.js';

/** The owner approves or declines a change the gate held (kit 0.14). JSON body {decision, sha}. */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') error(400, 'Bad request');
  try {
    return json(await decideHeld(locals.user, project, String(b.sha ?? ''), String(b.decision ?? '')));
  } catch (e) {
    error(400, e.message);
  }
}
