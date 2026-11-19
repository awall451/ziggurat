import { error } from '@sveltejs/kit';
import { DEPLOY_ENABLED } from '$lib/server/config.js';
import { eventsFile } from '$lib/server/deploy.js';
import { activeRun } from '$lib/server/runner.js';
import { stream } from '$lib/server/events.js';

// Live events of one run, as server-sent events. `offset` (or the browser's
// Last-Event-ID on a reconnect) continues from where the page already is.
export function GET({ params, url, request }) {
  if (!DEPLOY_ENABLED) error(404, 'Not found');
  const run = url.searchParams.get('run') || '';
  let file;
  try {
    file = eventsFile(params.id, run);
  } catch (e) {
    error(400, e.message);
  }
  const from = Number(request.headers.get('last-event-id') ?? url.searchParams.get('offset') ?? 0);
  const body = stream(file, { offset: Number.isInteger(from) && from > 0 ? from : 0, isActive: () => activeRun()?.runId === run });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
}
