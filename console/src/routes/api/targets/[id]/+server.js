import { body, reply } from '$lib/server/api.js';
import * as registry from '$lib/server/registry.js';

export const GET = ({ params }) => reply(() => registry.getTarget(params.id));

export async function PUT({ params, request, locals }) {
  const b = await body(request);
  return reply(() => registry.storeTarget(locals.user, b, params.id));
}

// Removes the entry from targets.json. Nothing on the Proxmox host is touched.
export const DELETE = ({ params, locals }) => reply(() => registry.removeTarget(locals.user, params.id));
