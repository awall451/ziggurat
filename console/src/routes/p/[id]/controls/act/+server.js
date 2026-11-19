import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import * as controls from '$lib/server/controls.js';
import { audit } from '$lib/server/audit.js';

/**
 * One owner action on a team: {action, ...}. Each maps to a fixed kit script
 * on the VM; nothing here passes free text to a shell.
 */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await request.json().catch(() => null);
  if (!b || typeof b.action !== 'string') error(400, 'Bad request');
  const user = locals.user;
  try {
    let out;
    switch (b.action) {
      case 'halt':
        out = await controls.halt(user, project, b.reason);
        break;
      case 'resume':
        out = await controls.resume(user, project);
        break;
      case 'halt-at':
        out = await controls.haltAt(user, project, b.epoch, b.reason);
        break;
      case 'halt-at-clear':
        out = await controls.clearHaltAt(user, project);
        break;
      case 'cap':
        out = await controls.setCap(user, project, b.key, b.value);
        break;
      case 'gate':
        out = await controls.gate(user, project, !!b.on, b.reason);
        break;
      case 'apply-token':
        out = await controls.applyToken(user, project);
        break;
      default:
        error(400, 'Unknown action');
    }
    controls.forgetInfo(project.id);
    if (!out.ok) error(502, out.detail || 'The VM refused the action');
    return json(out);
  } catch (e) {
    if (e?.status) throw e; // already an HTTP error
    audit(user, project.id, b.action, {}, { ok: false, detail: e.message });
    error(400, e.message);
  }
}
