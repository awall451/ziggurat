import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { body, reply } from '$lib/server/api.js';
import * as schedule from '$lib/server/schedule.js';

/** The timeline as JSON (for the Backlog's "place on the timeline" pop-up): ?view=day&date=YYYY-MM-DD. */
export async function GET({ url }) {
  const view = ['day', 'week'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'day';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : null;
  return new Response(JSON.stringify(await schedule.timeline({ view, date })), { headers: { 'content-type': 'application/json' } });
}

/**
 * Cycle schedules: {action: 'set', project, tz, slots} replaces a project's
 * schedule on its VM, {action: 'clear', project} removes it, and
 * {action: 'settings', timezone, quiet, clock} saves the owner's time zone, quiet hours and 12 or 24 hour clock.
 * {action: 'once-set' | 'once-move' | 'once-cancel', project, at, id, pastCap} sets, moves or cancels a one-time cycle.
 */
export async function POST({ request, locals }) {
  const b = await body(request);
  const user = locals.user;
  return reply(async () => {
    if (b.action === 'settings') return schedule.saveSettings(user, { timezone: b.timezone, quiet: b.quiet, clock: b.clock });
    const project = typeof b.project === 'string' ? getProject(b.project) : null;
    if (!project) error(404, 'No such project');
    if (b.action === 'set') return schedule.setSchedule(user, project, { tz: b.tz, slots: b.slots, changes: b.changes });
    if (b.action === 'clear') return schedule.clearSchedule(user, project);
    // One-time cycles (kit 0.26): {at} in unix seconds, {id}, and "past the cap".
    if (b.action === 'once-set') return schedule.onceSet(user, project, { at: b.at, pastCap: b.pastCap === true });
    if (b.action === 'once-move') return schedule.onceMove(user, project, { id: b.id, at: b.at, pastCap: b.pastCap === true });
    if (b.action === 'once-cancel') return schedule.onceCancel(user, project, { id: b.id });
    error(400, 'Unknown action');
  });
}
