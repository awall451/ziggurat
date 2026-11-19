import { reply } from '$lib/server/api.js';
import * as deploy from '$lib/server/deploy.js';

export const POST = ({ params, locals }) => reply(() => deploy.continueCreate(locals.user, params.id), 202);
