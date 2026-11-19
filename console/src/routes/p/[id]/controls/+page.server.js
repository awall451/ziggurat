import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { info } from '$lib/server/controls.js';
import { readAudit } from '$lib/server/audit.js';
import { peekStatus } from '$lib/server/live.js';
import { tokenConfigured } from '$lib/server/token.js';

export async function load({ params, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent();
  const status = peekStatus(project.id);
  const ready = !!(status?.reachable && status.kitVersion);
  const controls = ready
    ? await Promise.race([info(project), new Promise((r) => setTimeout(() => r({ caps: {}, units: [], error: 'The VM is slow to answer.' }), 6000))])
    : { caps: {}, units: [], error: null };
  return { controls, audit: readAudit(project.id, 100), tokenSaved: tokenConfigured() };
}
