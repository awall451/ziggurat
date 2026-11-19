import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { saveDraftAttachment } from '$lib/server/feedback.js';

/** Upload one attachment for a message being written. The body is the raw file. */
export async function POST({ params, request, url }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const data = Buffer.from(await request.arrayBuffer());
  try {
    return json(saveDraftAttachment(project, url.searchParams.get('name') || 'file', data));
  } catch (e) {
    error(400, e.message);
  }
}
