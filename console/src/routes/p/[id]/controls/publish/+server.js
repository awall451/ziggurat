import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { body, reply } from '$lib/server/api.js';
import * as publish from '$lib/server/publish.js';

/**
 * Publishing main to a remote repository: {action: 'remote' | 'verify' | 'now'}.
 * Only the public half of the project's key is ever part of an answer.
 */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await body(request);
  const user = locals.user;
  return reply(async () => {
    switch (b.action) {
      case 'remote':
        return publish.setRemote(user, project, typeof b.remote === 'string' ? b.remote : '');
      case 'verify':
        return publish.verify(user, project, { fingerprint: typeof b.fingerprint === 'string' ? b.fingerprint : null });
      case 'now':
        return publish.publish(user, project, { manual: true });
      default:
        error(400, 'Unknown action');
    }
  });
}
