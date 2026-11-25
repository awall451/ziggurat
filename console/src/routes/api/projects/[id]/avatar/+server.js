import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { saveAvatar, removeAvatar, MAX_AVATAR } from '$lib/server/avatar.js';

/** Upload the project's picture: the raw file as the body. */
export async function PUT({ params, request, locals }) {
  if (!getProject(params.id)) error(404, 'No such project');
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_AVATAR) error(413, 'The picture is over 2 MB');
  const buf = Buffer.from(await request.arrayBuffer());
  try {
    return json(saveAvatar(locals.user, params.id, buf));
  } catch (e) {
    error(e.status || 400, e.message);
  }
}

/** Back to the letter. */
export function DELETE({ params, locals }) {
  if (!getProject(params.id)) error(404, 'No such project');
  return json(removeAvatar(locals.user, params.id));
}
