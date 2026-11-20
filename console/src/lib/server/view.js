// What the pages show about a project: config, live status, progress numbers.
import { getStatus, peekStatus, kitAtLeast } from './live.js';
import { touch, pullInfo, ledgerPulledAt } from './pull.js';
import { summary } from './aggregate.js';
import { tierNames } from './theme.js';
import { listSessions } from './transcripts.js';
import { openAskCount } from './feedback.js';
import { openCount as openIssueCount } from './issues.js';
import { publishView, PUBLISH_KIT } from './publish.js';

const CHECKING = { reachable: null, state: 'checking', leadActive: false };

/** Live status, but never keep a page waiting on a VM that does not answer. */
export function statusSoon(project, ms = 3500) {
  return Promise.race([
    getStatus(project),
    new Promise((resolve) => setTimeout(() => resolve(peekStatus(project.id) || CHECKING), ms))
  ]);
}

export async function projectView(project, { wait = 3500 } = {}) {
  const status = await statusSoon(project, wait);
  touch(project, status);
  const sum = summary(project);
  const sessions = listSessions(project, status, { ledgerAt: ledgerPulledAt(project.id) });
  const current = sessions.find((s) => s.live) || null;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    theme: project.theme,
    accent: project.accent,
    hidden: !!project.hidden,
    tiers: tierNames(project),
    status: {
      state: status.state,
      reachable: status.reachable,
      leadActive: !!status.leadActive,
      leadSince: status.leadSince || null,
      timerEnabled: !!status.timerEnabled,
      control: status.control || '',
      main: status.main || null,
      ready: status.ready || [],
      worktrees: status.worktrees ?? null,
      remote: status.remote || null,
      session: status.session || null,
      haltAt: status.haltAt || null,
      gatePaused: !!status.gatePaused,
      kitVersion: status.kitVersion || null,
      oneshot: status.oneshot || null,
      idle: status.idle || null,
      haltAfter: status.haltAfter || null,
      vmNow: status.vmNow || null,
      error: status.error || null
    },
    summary: sum,
    // Questions from the lead that the owner has not answered yet.
    asks: openAskCount(project),
    // Owner issues not yet done or declined.
    issues: openIssueCount(project),
    // Owner feedback and controls need the kit's 0.2 scripts on the VM.
    canControl: !!status.kitVersion,
    // One-shot jobs need kit 0.4.
    canOneshot: !!status.canOneshot,
    // One-shot jobs on an idle team (set to run, no cycle running) need kit 0.6.
    canOneshotIdle: !!status.canOneshot && kitAtLeast(status.kitVersion, '0.6.0'),
    // Files attached to an issue (beyond its one picture) need kit 0.7.
    canIssueFiles: kitAtLeast(status.kitVersion, '0.7.0'),
    // Publishing main to a remote repository needs kit 0.8.
    canPublish: kitAtLeast(status.kitVersion, PUBLISH_KIT),
    publish: publishView(project),
    // Halting after the cycle needs kit 0.5.
    canHaltAfter: !!status.canHaltAfter,
    cycle: current
      ? { number: current.number, started: current.started, agents: current.agents }
      : sessions[0]
        ? { number: sessions[0].number, started: sessions[0].started, state: sessions[0].state, agents: sessions[0].agents }
        : null,
    pull: pullInfo(project.id),
    now: Date.now()
  };
}
