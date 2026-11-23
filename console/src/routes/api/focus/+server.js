import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { body, reply } from '$lib/server/api.js';
import * as focus from '$lib/server/focus.js';

/** Every team, for the focus dialog: can it be in focus, its typical cycle, its jobs set for a time. */
export async function GET() {
  return json({ teams: focus.focusView(), now: Date.now() });
}

/**
 * Focus mode (kit 0.27):
 * {action: 'start', project, mode: 'until' | 'cycles' | 'open', until, cycles, perDay, pauseOthers}
 * {action: 'stop', project}
 */
export async function POST({ request, locals }) {
  const b = await body(request);
  const user = locals.user;
  return reply(async () => {
    const project = typeof b.project === 'string' ? getProject(b.project) : null;
    if (!project) error(404, 'No such project');
    if (b.action === 'start') {
      return focus.startFocus(user, project, {
        mode: b.mode,
        until: Number.isInteger(b.until) ? b.until : null,
        cycles: Number.isInteger(b.cycles) ? b.cycles : null,
        perDay: Number.isInteger(b.perDay) ? b.perDay : null,
        pauseOthers: b.pauseOthers === true
      });
    }
    if (b.action === 'stop') return focus.stopFocus(user, project);
    error(400, 'Unknown action');
  });
}
