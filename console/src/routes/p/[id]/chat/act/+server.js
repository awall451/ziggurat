import { error, json } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { say, rename, archiveConv, seen, syncTalk } from '$lib/server/talk.js';
import { peekStatus } from '$lib/server/live.js';

/** Every owner action on the Chat tab: one JSON body {action, ...}. */
export async function POST({ params, request, locals }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') error(400, 'Bad request');
  const s = (v) => String(v ?? '');
  try {
    switch (b.action) {
      case 'say':
        return json(await say(locals.user, project, { conv: s(b.conv), text: s(b.text), model: s(b.model), effort: s(b.effort), attachments: Array.isArray(b.attachments) ? b.attachments.slice(0, 8) : [] }));
      case 'rename':
        rename(project, s(b.conv), s(b.title));
        return json({ ok: true });
      case 'archive':
        archiveConv(project, s(b.conv), b.archived !== false);
        return json({ ok: true });
      case 'seen':
        return json(seen(project, s(b.conv)));
      case 'sync': {
        const chat = peekStatus(project.id)?.chat;
        await syncTalk(project, { conv: chat?.talk || null, live: !!chat?.talk, force: true });
        return json({ ok: true });
      }
      default:
        error(400, 'Unknown action');
    }
  } catch (e) {
    if (e?.status) throw e;
    error(400, e.message);
  }
}
