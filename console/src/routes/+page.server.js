import { listProjects, DEPLOY_ENABLED } from '$lib/server/config.js';
import { projectView } from '$lib/server/view.js';
import { peekStatus } from '$lib/server/live.js';

export async function load() {
  // A VM that is off must not hold up the page: use the last known state when
  // there is one (it is refreshed in the background), wait briefly otherwise.
  const projects = await Promise.all(listProjects().map((p) => projectView(p, { wait: p.hidden || peekStatus(p.id) ? 150 : 1200 })));
  return { projects, deploy: DEPLOY_ENABLED };
}
