import { reply } from '$lib/server/api.js';
import * as drafts from '$lib/server/drafts.js';

export const GET = ({ params }) => reply(() => drafts.getDraft(params.id));
export const DELETE = ({ params, locals }) => reply(() => drafts.deleteDraft(locals.user, params.id));
