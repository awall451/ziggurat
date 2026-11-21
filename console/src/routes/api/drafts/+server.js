import { body, reply } from '$lib/server/api.js';
import * as drafts from '$lib/server/drafts.js';

export const GET = () => reply(() => ({ drafts: drafts.listDrafts() }));

// Store a draft of the "New project" form (see console/docs/new-project.schema.json).
// It deploys nothing: open the returned url, read it, change it, send it.
export async function POST({ request, locals }) {
  const b = await body(request);
  return reply(() => drafts.putDraft(locals.user, b), 201);
}
