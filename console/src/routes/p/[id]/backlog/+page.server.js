import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { list, syncBacklog, kitHasBacklog } from '$lib/server/backlog.js';
import { noteScheduledStart } from '$lib/server/feedback.js';
import { peekStatus } from '$lib/server/live.js';
import { getSettings } from '$lib/server/schedule.js';

export async function load({ params, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent();
  const status = peekStatus(project.id);
  const ready = !!status?.reachable && kitHasBacklog(status.kitVersion);
  if (ready) {
    // Wait briefly for the lead's proposals and answers, never long.
    await Promise.race([syncBacklog(project), new Promise((r) => setTimeout(r, 2500))]);
    noteScheduledStart(project, status);
  }
  const settings = getSettings();
  return {
    backlog: list(project, status),
    ready,
    kitVersion: status?.kitVersion || null,
    atJobs: status?.atJobs || [],
    busy: status ? { state: status.state, oneshot: status.oneshot || null, chat: status.chat || null } : null,
    clock: settings.clock || '24',
    timezone: settings.timezone || 'UTC'
  };
}
