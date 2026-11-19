import { body, reply } from '$lib/server/api.js';
import * as deploy from '$lib/server/deploy.js';

export const GET = () => reply(() => ({ deploys: deploy.listDeploys() }));

// Create a draft from the "New project" form, or replace one that has no VM yet.
export async function POST({ request, locals }) {
  const b = await body(request);
  return reply(() => deploy.putDeploy(locals.user, b), 201);
}
