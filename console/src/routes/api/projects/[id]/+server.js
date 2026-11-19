import { body, reply } from '$lib/server/api.js';
import * as registry from '$lib/server/registry.js';

export const GET = ({ params }) => reply(() => registry.getProject(params.id));

export async function PUT({ params, request, locals }) {
  const b = await body(request);
  return reply(() => registry.storeProject(locals.user, b, params.id));
}

// Removes the entry from projects.json only: the VM and all pulled data stay.
export const DELETE = ({ params, locals }) => reply(() => registry.removeProject(locals.user, params.id));
