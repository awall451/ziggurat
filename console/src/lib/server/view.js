// What the pages show about a project: config, live status, progress numbers.
import { getStatus, peekStatus, kitAtLeast, runCycleState, IDLE_KIT } from './live.js';
import { touch, pullInfo, ledgerPulledAt } from './pull.js';
import { summary, readCycles, typicalCycle } from './aggregate.js';
import { tierNames } from './theme.js';
import { listSessions } from './transcripts.js';
import { openAskCount } from './feedback.js';
import { openCount as openIssueCount } from './issues.js';
import { publishView, PUBLISH_KIT } from './publish.js';
import { chatUnread } from './backlog.js';
import { avatarUrl } from './avatar.js';
import { unread as talkUnread, kitHasTalk } from './talk.js';
import { parseScheduleText, nextStart } from '../schedule.js';

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
  // Cycle slots: with a schedule, the next cycle starts at the next slot, not when the timer fires.
  const schedule = parseScheduleText(status.schedule);
  const nextSlot = schedule ? nextStart(schedule) : null;
  const sessions = listSessions(project, status, { ledgerAt: ledgerPulledAt(project.id) });
  const current = sessions.find((s) => s.live) || null;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    theme: project.theme,
    accent: project.accent,
    // The owner's picture for the project, or null: then its tile shows the first letter.
    avatar: avatarUrl(project.id),
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
      idle: status.idle ? { ...status.idle, nextSlot } : null,
      schedule: schedule ? { tz: schedule.tz, slots: schedule.slots.length, next: nextSlot } : null,
      haltAfter: status.haltAfter || null,
      // The cycle in progress is stuck, and why (kit 0.24).
      stalled: status.stalled || null,
      // Focus mode (kit 0.27): in focus, paused for another team's, how the last one ended.
      focus: status.focus || null,
      // The daily cycle cap, as the VM counts it.
      cap: Number.isInteger(status.cap) ? status.cap : null,
      vmNow: status.vmNow || null,
      error: status.error || null,
      // The VM is not this project's (kit PROJECT= names another one), or another entry shares it.
      vmMismatch: status.vmMismatch || null,
      vmShared: project.vmShared || null
    },
    summary: sum,
    // Questions from the lead that the owner has not answered yet.
    asks: openAskCount(project),
    // Everything that waits for the owner (see waitingParts in format.js).
    waiting: {
      asks: openAskCount(project),
      escalations: sum.escalations || 0,
      packages: status.packageRequests || 0,
      held: status.heldChanges || 0,
      // Answers of the lead in the Backlog chat that the owner has not opened.
      chat: chatUnread(project, status),
      // Answers of the lead in the Chat tab's conversations that the owner has not opened (kit 0.33).
      talk: talkUnread(project, status),
      // Publishing that the console could not get to work by itself.
      publishing: publishView(project).auto?.waiting ? 1 : 0
    },
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
    // The Chat tab's conversations with the lead need kit 0.33.
    canTalk: kitHasTalk(status.kitVersion),
    // Issues as tickets (numbers, priority, edits, notes, files later) need kit 0.12.
    canTickets: kitAtLeast(status.kitVersion, '0.12.0'),
    // Trying a failed package install again needs kit 0.17.
    canRetryPackages: kitAtLeast(status.kitVersion, '0.17.0'),
    // Cycle slots need kit 0.9.
    canSchedule: kitAtLeast(status.kitVersion, '0.9.0'),
    // Idle without start times or focus (kit 0.35, #132); before, back to back until the cap.
    idleByDefault: kitAtLeast(status.kitVersion, IDLE_KIT),
    // Publishing main to a remote repository needs kit 0.8.
    canPublish: kitAtLeast(status.kitVersion, PUBLISH_KIT),
    publish: publishView(project),
    // Halting after the cycle needs kit 0.5.
    canHaltAfter: !!status.canHaltAfter,
    // Run a cycle now (kit 0.25): whether it can, why not, and what a cycle of this team typically takes.
    runCycle: { ...runCycleState(status), typical: typicalCycle(readCycles(project.paths.fleet)) },
    // Focus mode needs kit 0.27.
    canFocus: kitAtLeast(status.kitVersion, '0.27.0'),
    cycle: current
      ? { number: current.number, started: current.started, agents: current.agents }
      : sessions[0]
        ? { number: sessions[0].number, started: sessions[0].started, state: sessions[0].state, agents: sessions[0].agents }
        : null,
    pull: pullInfo(project.id),
    now: Date.now()
  };
}
