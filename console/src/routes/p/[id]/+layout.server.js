import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { projectView } from '$lib/server/view.js';
import { getSettings } from '$lib/server/schedule.js';
import { quietIntervals } from '$lib/schedule.js';

export async function load({ params }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const now = Date.now();
  // Whether now is inside the owner's quiet hours (Schedule): said before a cycle is started by hand.
  const quietNow = quietIntervals(getSettings(), now - 1000, now + 1000).some((q) => now >= q.from && now < q.to);
  return { project: await projectView(project), quietNow };
}
