import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { startPlan, cancelAt, moveAt, decide, runNow, runAt, chatSay, chatEnd, syncBacklog } from '$lib/server/backlog.js';
import { oneshot } from '$lib/server/controls.js';

/** Every owner action on the Backlog tab: one JSON body {action, ...}. */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') error(400, 'Bad request');
  const s = (v) => String(v ?? '');
  try {
    switch (b.action) {
      case 'plan':
        return json(await startPlan(locals.user, project, { focus: s(b.focus), at: b.at == null ? null : Number(b.at), skip: b.skip || null }));
      case 'move-at':
        return json(await moveAt(locals.user, project, s(b.id), Number(b.at), b.skip || null));
      case 'cancel-at':
        return json(await cancelAt(locals.user, project, s(b.id)));
      case 'decide':
        return json(await decide(locals.user, project, s(b.pid), s(b.status)));
      case 'run':
        return json(await runNow(locals.user, project, s(b.pid), oneshot));
      case 'run-at':
        return json(await runAt(locals.user, project, s(b.pid), Number(b.at), b.skip || null));
      case 'chat': {
        const out = await chatSay(locals.user, project, s(b.plan), s(b.text));
        return json(out);
      }
      case 'chat-end':
        return json(await chatEnd(locals.user, project, s(b.plan)));
      case 'sync':
        await syncBacklog(project, { force: true });
        return json({ ok: true });
      default:
        error(400, 'Unknown action');
    }
  } catch (e) {
    if (e?.status) throw e;
    error(400, e.message);
  }
}
