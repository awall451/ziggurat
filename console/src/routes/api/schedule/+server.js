import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { body, reply } from '$lib/server/api.js';
import * as schedule from '$lib/server/schedule.js';

/**
 * Cycle schedules: {action: 'set', project, tz, slots} replaces a project's
 * schedule on its VM, {action: 'clear', project} removes it, and
 * {action: 'settings', timezone, quiet} saves the owner's time zone and quiet hours.
 */
export async function POST({ request, locals }) {
  const b = await body(request);
  const user = locals.user;
  return reply(async () => {
    if (b.action === 'settings') return schedule.saveSettings(user, { timezone: b.timezone, quiet: b.quiet });
    const project = typeof b.project === 'string' ? getProject(b.project) : null;
    if (!project) error(404, 'No such project');
    if (b.action === 'set') return schedule.setSchedule(user, project, { tz: b.tz, slots: b.slots });
    if (b.action === 'clear') return schedule.clearSchedule(user, project);
    error(400, 'Unknown action');
  });
}
