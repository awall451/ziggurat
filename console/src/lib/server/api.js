// Shared shape for the JSON API routes: read a JSON body, run the action, and
// turn an error that carries a status into that HTTP error.
import { error, json } from '@sveltejs/kit';

export async function body(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) error(415, 'Send JSON (Content-Type: application/json)');
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) error(400, 'Bad request');
  return b;
}

export async function reply(fn, status = 200) {
  try {
    return json((await fn()) ?? { ok: true }, { status });
  } catch (e) {
    if (e?.status && e?.body) throw e; // already an HTTP error
    error(e?.status || 500, e?.message || 'Failed');
  }
}
