import { error } from '@sveltejs/kit';
import { userFor } from '$lib/server/user.js';
import { startScheduler } from '$lib/server/pull.js';
import { recover as recoverDeploys } from '$lib/server/deploy.js';

startScheduler();
// A deploy run that a restart cut off is recorded as failed (nothing is retried).
recoverDeploys().catch((e) => console.error('deploy: recovery failed', e));

// Origins allowed to send requests that change something. The page's own
// origin is always allowed; add others (comma separated) only if needed.
const EXTRA = (process.env.CONSOLE_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

export async function handle({ event, resolve }) {
  const user = userFor(event.request);
  if (!user) error(401, 'Not signed in');
  event.locals.user = user;

  const method = event.request.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    // A page on another site must not be able to fire actions through the
    // owner's browser, so anything that changes state needs a matching Origin.
    // The browser sets Host to the address the request is really sent to, so
    // comparing it with Origin works the same behind a reverse proxy.
    const h = event.request.headers;
    const origin = h.get('origin');
    const host = h.get('x-forwarded-host') || h.get('host');
    let same = false;
    try {
      same = !!origin && !!host && new URL(origin).host === host;
    } catch {
      same = false;
    }
    if (!same && !(origin && EXTRA.includes(origin))) error(403, 'Cross-site request refused');
  }

  const response = await resolve(event);
  response.headers.set('Content-Security-Policy', CSP);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
}
