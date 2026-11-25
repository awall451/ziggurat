import fs from 'node:fs';
import { error } from '@sveltejs/kit';
import { avatarFile } from '$lib/server/avatar.js';

/** The project's picture, if the owner uploaded one. Its address changes with it, so it can be cached. */
export function GET({ params }) {
  const a = avatarFile(params.id);
  if (!a) error(404, 'No picture');
  return new Response(fs.readFileSync(a.file), {
    headers: { 'content-type': a.type, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }
  });
}
