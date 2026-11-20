import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { info } from '$lib/server/controls.js';
import { readAudit } from '$lib/server/audit.js';
import { peekStatus } from '$lib/server/live.js';
import { tokenConfigured } from '$lib/server/token.js';
import { history as publishHistory, ensureKey, publicKey } from '$lib/server/publish.js';

export async function load({ params, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  // A project that got its remote at deploy time has no key yet: make it before the page shows it.
  if (project.publish?.remote && !publicKey(project)) await ensureKey(project).catch(() => {});
  await parent();
  const status = peekStatus(project.id);
  const ready = !!(status?.reachable && status.kitVersion);
  const controls = ready
    ? await Promise.race([info(project), new Promise((r) => setTimeout(() => r({ caps: {}, units: [], error: 'The VM is slow to answer.' }), 6000))])
    : { caps: {}, units: [], error: null };
  return { controls, audit: readAudit(project.id, 100), tokenSaved: tokenConfigured(), publishHistory: publishHistory(project, 20) };
}
