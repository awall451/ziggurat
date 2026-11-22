import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { list, syncBacklog, kitHasBacklog } from '$lib/server/backlog.js';
import { noteScheduledStart } from '$lib/server/feedback.js';
import { peekStatus, kitAtLeast } from '$lib/server/live.js';
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
  const backlog = list(project, status);
  // How long a planning cycle of this team takes: for placing one on the timeline.
  const mins = backlog.plans.map((x) => x.minutes).filter((m) => Number.isFinite(m)).sort((a, b) => a - b);
  return {
    backlog,
    planMinutes: mins.length ? Math.max(1, mins[Math.floor(mins.length / 2)]) : 5,
    ready,
    kitVersion: status?.kitVersion || null,
    // A time limit for a job (told to wrap up, then stopped) needs kit 0.18.
    canBrake: kitAtLeast(status?.kitVersion, '0.18.0'),
    atJobs: status?.atJobs || [],
    busy: status ? { state: status.state, oneshot: status.oneshot || null, chat: status.chat || null } : null,
    clock: settings.clock || '24',
    timezone: settings.timezone || 'UTC'
  };
}
