import { listProjects } from '$lib/server/config.js';
import { projectView } from '$lib/server/view.js';

export async function load() {
  // Short wait: a VM that is off must not hold up the whole page.
  const projects = await Promise.all(listProjects().map((p) => projectView(p, { wait: 2500 })));
  return { projects };
}
