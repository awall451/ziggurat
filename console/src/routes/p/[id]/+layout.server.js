import { error } from '@sveltejs/kit';
import { getProject, listProjects } from '$lib/server/config.js';
import { peekStatus } from '$lib/server/live.js';
import { avatarUrl } from '$lib/server/avatar.js';
import { projectView } from '$lib/server/view.js';
import { getSettings } from '$lib/server/schedule.js';
import { quietIntervals } from '$lib/schedule.js';

export async function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const now = Date.now();
  // Whether now is inside the owner's quiet hours (Schedule): said before a cycle is started by hand.
  const quietNow = quietIntervals(getSettings(), now - 1000, now + 1000).some((q) => now >= q.from && now < q.to);
  // The project switcher beside the name: every project that is not hidden, with its state as last seen.
  const projects = listProjects()
    .filter((x) => !x.hidden || x.id === project.id)
    .map((x) => ({ id: x.id, name: x.name || x.id, accent: x.accent || null, avatar: avatarUrl(x.id), state: peekStatus(x.id)?.state || null }));
  return { project: await projectView(project), quietNow, projects };
}
