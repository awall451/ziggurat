// What the pages show about a project: config, live status, progress numbers.
import { getStatus, peekStatus } from './live.js';
import { touch, pullInfo } from './pull.js';
import { summary } from './aggregate.js';
import { tierNames } from './theme.js';
import { listSessions } from './transcripts.js';
import { openAskCount } from './feedback.js';
import { openCount as openIssueCount } from './issues.js';

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
  const sessions = listSessions(project, status);
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
    // One-shot jobs need kit 0.3.
    canOneshot: !!status.canOneshot,
    cycle: current
      ? { number: current.number, started: current.started, agents: current.agents }
      : sessions[0]
        ? { number: sessions[0].number, started: sessions[0].started, state: sessions[0].state, agents: sessions[0].agents }
        : null,
    pull: pullInfo(project.id),
    now: Date.now()
  };
}
