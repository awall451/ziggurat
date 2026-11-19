import { body, reply } from '$lib/server/api.js';
import * as registry from '$lib/server/registry.js';

export const GET = () => reply(() => ({ projects: registry.listProjects() }));

export async function POST({ request, locals }) {
  const b = await body(request);
  return reply(() => registry.storeProject(locals.user, b), 201);
}
