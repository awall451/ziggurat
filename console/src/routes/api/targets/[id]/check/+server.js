import { reply } from '$lib/server/api.js';
import * as registry from '$lib/server/registry.js';
import { inspect } from '$lib/server/pve.js';

// A read-only look at the target's Proxmox host. POST because it opens an ssh
// connection, so another site must not be able to trigger it.
export const POST = ({ params }) => reply(() => inspect(registry.getTarget(params.id), { fresh: true }));
