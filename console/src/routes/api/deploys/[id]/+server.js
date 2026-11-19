import { reply } from '$lib/server/api.js';
import * as deploy from '$lib/server/deploy.js';

export const GET = ({ params }) => reply(() => deploy.getDeploy(params.id));

// Gives the deploy up. Only the record changes: nothing on the host is touched.
export const DELETE = ({ params, locals }) => reply(() => deploy.abandon(locals.user, params.id));
