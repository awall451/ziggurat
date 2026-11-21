import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { threads, syncOutbox } from '$lib/server/feedback.js';
import { peekStatus } from '$lib/server/live.js';
import { notes } from '$lib/server/aggregate.js';
import { list as backlog } from '$lib/server/backlog.js';

export async function load({ params, parent }) {
  const project = getProject(params.id);
  if (!project) error(404, 'No such project');
  await parent();
  const status = peekStatus(project.id);
  // Wait briefly for fresh replies, but never hold the page for a slow VM.
  if (status?.reachable && status.kitVersion) {
    await Promise.race([syncOutbox(project), new Promise((r) => setTimeout(r, 2500))]);
  }
  // The chat with the lead about the latest plan lives on the Backlog tab.
  const plan = backlog(project, status).plans.find((x) => x.newest && !x.ended && x.chat.length);
  const backlogChat = plan ? { answered: plan.chat.filter((c) => c.reply).length, waiting: plan.waiting } : null;
  return { ...threads(project), escalations: notes(project).escalations, backlogChat };
}
