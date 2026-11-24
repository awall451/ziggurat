import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { peekStatus } from '$lib/server/live.js';
import { list, get, syncTalk, kitHasTalk, TALK_RE } from '$lib/server/talk.js';
import { info } from '$lib/server/controls.js';

/** The Chat tab: the conversations with the lead, and the open one (`?c=`). */
export async function load({ params, parent, url }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent();
  const status = peekStatus(project.id);
  const ready = !!status?.reachable && kitHasTalk(status.kitVersion);
  const want = url.searchParams.get('c') || '';
  const live = !!status?.chat?.talk;
  if (ready) {
    // Wait briefly for the lead's answers (and, while it answers, its steps), never long.
    await Promise.race([syncTalk(project, { conv: status?.chat?.talk || null, live }), new Promise((r) => setTimeout(r, live ? 1500 : 2500))]);
  }
  // The team's own model and chat effort, for "Team default" (cached; never wait long for it).
  const caps = ready ? ((await Promise.race([info(project).catch(() => null), new Promise((r) => setTimeout(r, 1500))]))?.caps || {}) : {};
  const conversations = list(project, status);
  const open = TALK_RE.test(want) ? get(project, want, { status }) : null;
  return {
    ready,
    kitVersion: status?.kitVersion || null,
    conversations,
    open,
    // A plan chat turn and a Chat tab turn share the lead: one answer at a time.
    busy: status ? { state: status.state, oneshot: status.oneshot || null, chat: status.chat || null } : null,
    teamModel: caps.LEAD_MODEL || null,
    teamEffort: caps.CHAT_EFFORT || null
  };
}
