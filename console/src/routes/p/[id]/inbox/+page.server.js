import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/config.js';
import { threads, syncOutbox } from '$lib/server/feedback.js';
import { peekStatus } from '$lib/server/live.js';
import { notes } from '$lib/server/aggregate.js';
import { list as backlog } from '$lib/server/backlog.js';
import { heldChanges, kitHasGateHold } from '$lib/server/gatehold.js';
import { requests as packageRequests, extraDomains, kitHasPackages } from '$lib/server/packages.js';
import { publishView } from '$lib/server/publish.js';

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
  // Changes to what "done" means, held by the gate for the owner (kit 0.14).
  let gateHeld = null;
  if (status?.reachable && kitHasGateHold(status.kitVersion)) {
    gateHeld = await Promise.race([heldChanges(project), new Promise((r) => setTimeout(() => r({ held: [], error: 'the VM took too long to answer' }), 12000))]);
  }
  // System packages and domains the lead asked for (kit 0.16).
  let packages = null;
  if (status?.reachable && kitHasPackages(status.kitVersion)) {
    packages = await Promise.race([packageRequests(project), new Promise((r) => setTimeout(() => r({ requests: [], error: 'the VM took too long to answer', gateway: null }), 12000))]);
  }
  // Domains the owner added on the gateway for earlier requests: they can be taken back.
  if (packages?.requests.length && !packages.extra) {
    packages.extra = await Promise.race([extraDomains(project).catch(() => null), new Promise((r) => setTimeout(() => r(null), 6000))]);
  }
  // Publishing the console could not get to work by itself (a key without write access, a new host).
  const pub = publishView(project);
  const publishing = pub.auto?.waiting ? { remote: pub.remote, error: pub.auto.error, need: pub.auto.need, lastAt: pub.auto.lastAt } : null;
  return { ...threads(project), escalations: notes(project).escalations, backlogChat, gateHeld, packages, publishing };
}
