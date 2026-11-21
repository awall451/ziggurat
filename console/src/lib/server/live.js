// Live state of one sandbox VM: a single read-only ssh round trip, cached
// briefly. "Running" is decided only from facts on the VM (unit state, the
// VM's own clock), never by comparing against the workstation clock.
import { readScript, q } from './ssh.js';

const STATUS_TTL = 10_000;
const DOWN_TTL = 60_000; // do not hammer a VM that is off
const statusCache = new Map(); // id -> {at, value, pending}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function statusScript(p) {
  const k = p.kit;
  return `
STATE=${q(k.state)}; UNIT=${q(k.leadUnit)}; BARE=${q(k.bare)}; WS=${q(k.workspace)}
PROJ=${q(`${k.agentHome}/.claude/projects/${p.slug}`)}
g() { git -c safe.directory="$BARE" -C "$BARE" "$@" 2>/dev/null; }
control=$(head -c 300 "$STATE/control" 2>/dev/null)
lead=$(systemctl is-active "$UNIT.service" 2>/dev/null)
timer=$(systemctl is-enabled "$UNIT.timer" 2>/dev/null)
since=$(systemctl show "$UNIT.service" -p ActiveEnterTimestamp --value 2>/dev/null)
# The lead unit is Type=oneshot: it stays "activating" while a cycle runs and
# never sets ActiveEnterTimestamp. The start is when it left "inactive".
[ -n "$since" ] || since=$(systemctl show "$UNIT.service" -p InactiveExitTimestamp --value 2>/dev/null)
head=$(g log -1 --format='%h%x09%cI%x09%s' main)
ready=$(g for-each-ref --format='%(refname:short)' 'refs/heads/ready/*' | paste -sd, -)
remote=$(g config --get remote.origin.url)
current=$(head -c 200 "$STATE/ledger/current" 2>/dev/null)
newest=$(sudo -n -u agent sh -c 'ls -t "$1"/*.jsonl 2>/dev/null | head -1' _ "$PROJ")
worktrees=$(sudo -n -u agent sh -c 'ls "$1" 2>/dev/null | wc -l' _ "$WS/.claude/worktrees")
haltat=$(head -c 200 "$STATE/halt-at" 2>/dev/null)
gatepaused=$([ -e "$STATE/gate/paused" ] && echo yes || echo no)
kitver=$(head -c 40 /opt/agent-kit/VERSION 2>/dev/null)
oneshot=$(head -c 200 "$STATE/oneshot" 2>/dev/null)
# A chat turn with the lead, and jobs set for a time (kit 0.10).
chat=$(head -c 200 "$STATE/chat" 2>/dev/null)
atjobs=$([ -d "$STATE/oneshot-at" ] && sudo -n /opt/agent-kit/bin/agent-kit-oneshot list-at 2>/dev/null | head -50)
haltafter=$(head -c 300 "$STATE/halt-after" 2>/dev/null)
canhaltafter=$([ -x /opt/agent-kit/bin/agent-kit-halt-after ] && echo yes || echo no)
canoneshot=$([ -x /opt/agent-kit/bin/agent-kit-oneshot ] && echo yes || echo no)
# Cycle slots (agent-kit-schedule, kit 0.9): empty when cycles simply follow each other.
schedule=$(head -c 6000 /etc/agent-kit/schedule 2>/dev/null)
# Why an idle team is idle: the daily cap (owner's caps.env wins over project.env,
# as in lead-cycle), cycles counted today by the VM's own date, the timer's next run.
cap=$(sed -nE 's/^MAX_CYCLES_PER_DAY=([0-9]{1,5})$/\\1/p' /etc/agent-kit/project.env /etc/agent-kit/caps.env 2>/dev/null | tail -1)
today=$(jq -s --arg d "$(date +%F)" '[.[] | select(.date == $d and .counted != false)] | length' "$STATE/ledger/cycles.jsonl" 2>/dev/null)
next=$(systemctl show "$UNIT.timer" -p NextElapseUSecRealtime --value 2>/dev/null)
next=$([ -n "$next" ] && date -d "$next" +%s 2>/dev/null)
dayend=$(date -d 'tomorrow 00:00' +%s 2>/dev/null)
f=$(grep -l '"status": *"merged"' "$STATE"/gate/results/*.json 2>/dev/null | xargs -r grep -l "all checks passed" | xargs -r ls -t | head -1)
shots=$([ -n "$f" ] && jq -r '.shots // empty' "$f" 2>/dev/null)
jq -nc --arg control "$control" --arg lead "$lead" --arg timer "$timer" --arg since "$since" \\
  --arg head "$head" --arg ready "$ready" --arg remote "$remote" --arg current "$current" \\
  --arg newest "$newest" --arg worktrees "$worktrees" --arg haltat "$haltat" \\
  --arg gatepaused "$gatepaused" --arg kitver "$kitver" --arg shots "$shots" \\
  --arg oneshot "$oneshot" --arg canoneshot "$canoneshot" --arg chat "$chat" --arg atjobs "$atjobs" \\
  --arg haltafter "$haltafter" --arg canhaltafter "$canhaltafter" \\
  --arg cap "$cap" --arg today "$today" --arg next "$next" --arg dayend "$dayend" \\
  --arg schedule "$schedule" \\
  --arg host "$(hostname)" --arg now "$(date +%s)" \\
  '{control:$control, lead:$lead, timer:$timer, since:$since, head:$head, ready:$ready, remote:$remote,
    current:$current, newest:$newest, worktrees:($worktrees|tonumber? // 0), haltat:$haltat,
    gatepaused:$gatepaused, kitver:$kitver, shots:$shots, oneshot:$oneshot, canoneshot:$canoneshot, chat:$chat, atjobs:$atjobs,
    haltafter:$haltafter, canhaltafter:$canhaltafter, cap:$cap, today:$today, next:$next, dayend:$dayend, schedule:$schedule,
    host:$host, now:($now|tonumber? // 0)}'
`;
}

/** A chat turn in progress: "<plan-id> <msgid> <since>". */
function chatOf(text) {
  const [plan, msg, since] = String(text || '').trim().split(/\s+/);
  return /^[0-9]{8}T[0-9]{6}Z-p-[a-z0-9-]{1,40}$/.test(plan || '') && /^[0-9]{8}T[0-9]{6}Z-c-[a-f0-9]{6}$/.test(msg || '') ? { plan, msg, since: since || null } : null;
}

/** Jobs set for a time: "<id> <unix> <from>" lines. */
function atJobsOf(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([id, at]) => /^[0-9]{8}T[0-9]{6}Z-[op]-[a-z0-9-]{1,40}$/.test(id || '') && /^\d{9,11}$/.test(at || ''))
    .map(([id, at, from]) => ({ id, at: Number(at), from: /^[A-Za-z0-9._@-]{1,80}$/.test(from || '') ? from : null, plan: /-p-/.test(id) }));
}

const count = (v) => (/^\d{1,10}$/.test(String(v ?? '')) ? Number(v) : null);

/**
 * Why a team that is set to run has no cycle running. `cap`: the daily cycle
 * cap is used up, and the next cycle waits for the VM's next day. `timer-off`:
 * no cycle starts on its own. `halt-after`: a halt is pending. `between`: the
 * next cycle comes when the timer next fires.
 */
function idleWhy(raw, haltAfter) {
  const today = count(raw.today);
  const cap = count(raw.cap);
  const reason = haltAfter ? 'halt-after' : cap != null && today != null && today >= cap ? 'cap' : raw.timer !== 'enabled' ? 'timer-off' : 'between';
  return { reason, today, cap, nextAt: count(raw.next), dayEndsAt: count(raw.dayend) };
}

function shape(raw) {
  const [sha, date, ...subject] = (raw.head || '').split('\t');
  const stopped = /^stop/.test(raw.control || '');
  const running = raw.lead === 'active' || raw.lead === 'activating';
  // Session of the cycle in progress: the kit's `current` file when present,
  // otherwise the newest transcript in the workspace's folder.
  const [curSid, curStart] = (raw.current || '').trim().split(/\s+/);
  let session = curSid || '';
  // When the kit's `current` file names the session, its second field is the start ("date -Is").
  const sessionStart = UUID_RE.test(session) && Number.isFinite(Date.parse(curStart || '')) ? curStart : null;
  if (!UUID_RE.test(session)) {
    const m = /([0-9a-f-]{36})\.jsonl$/.exec(raw.newest || '');
    session = m ? m[1] : '';
  }
  const [haltEpoch, ...haltReason] = (raw.haltat || '').trim().split(/\s+/);
  const [jobId, jobSince, jobAfter] = (raw.oneshot || '').trim().split(/\s+/);
  const [afterSet, afterMode, ...afterReason] = (raw.haltafter || '').trim().split(/\s+/);
  const haltAfter = /^\d{9,11}$/.test(afterSet || '') ? { since: Number(afterSet), wrapUp: afterMode === 'wrap', reason: afterReason.join(' ') } : null;
  const state = running ? 'running' : stopped ? 'halted' : 'idle';
  return {
    reachable: true,
    state,
    idle: state === 'idle' ? idleWhy(raw, haltAfter) : null,
    control: raw.control || '',
    leadActive: running,
    leadSince: running ? raw.since : null,
    timerEnabled: raw.timer === 'enabled',
    main: sha ? { sha, date, subject: subject.join('\t') } : null,
    ready: raw.ready ? raw.ready.split(',') : [],
    worktrees: raw.worktrees,
    remote: raw.remote || null,
    session: UUID_RE.test(session) ? session : null,
    sessionStart,
    haltAt: /^\d+$/.test(haltEpoch || '') ? { epoch: Number(haltEpoch), reason: haltReason.join(' ') } : null,
    gatePaused: raw.gatepaused === 'yes',
    kitVersion: raw.kitver || null,
    // The daily cycle cap, and the schedule file as the VM holds it (parsed by lib/schedule.js).
    cap: count(raw.cap),
    schedule: typeof raw.schedule === 'string' ? raw.schedule.slice(0, 6000) : '',
    // A one-shot job in progress: one cycle for one owner message, then halted
    // again, or (started on an idle team, kit 0.6) back to running.
    // From kit 0.10 also a planning cycle (an id with -p-).
    oneshot: /^[0-9]{8}T[0-9]{6}Z-[op]-[a-z0-9-]{1,40}$/.test(jobId || '')
      ? { id: jobId, since: jobSince || null, runsOn: jobAfter === 'run', plan: /-p-/.test(jobId) }
      : null,
    chat: chatOf(raw.chat),
    atJobs: atJobsOf(raw.atjobs),
    canOneshot: raw.canoneshot === 'yes',
    // A halt that waits for the cycle in progress to end (and for the gate after it).
    haltAfter,
    canHaltAfter: raw.canhaltafter === 'yes',
    shotsDir: /^\/var\/lib\/agent-kit\/[A-Za-z0-9._\/-]+$/.test(raw.shots || '') ? raw.shots : null,
    host: raw.host,
    vmNow: raw.now
  };
}

async function fetchStatus(project) {
  const res = await readScript(project, statusScript(project), { timeout: 25000 });
  if (res.code !== 0) {
    return { reachable: false, state: 'unreachable', leadActive: false, error: (res.stderr || '').trim().slice(-300) };
  }
  try {
    return shape(JSON.parse(res.stdout.trim().split('\n').pop()));
  } catch {
    return { reachable: false, state: 'unreachable', leadActive: false, error: 'bad status output' };
  }
}

/** Cached live status; never throws. Concurrent callers share one ssh call. */
export function getStatus(project, { fresh = false } = {}) {
  const c = statusCache.get(project.id);
  if (c?.pending) return c.pending;
  if (!fresh && c?.value) {
    const ttl = c.value.reachable ? STATUS_TTL : DOWN_TTL;
    if (Date.now() - c.at < ttl) return Promise.resolve(c.value);
  }
  const pending = fetchStatus(project).then((value) => {
    statusCache.set(project.id, { at: Date.now(), value });
    return value;
  });
  statusCache.set(project.id, { ...(c || {}), pending });
  return pending;
}

/** Last known status without waiting for the network (may be null). */
export function peekStatus(id) {
  return statusCache.get(id)?.value || null;
}

export function invalidateStatus(id) {
  const c = statusCache.get(id);
  if (c) statusCache.set(id, { ...c, at: 0 });
}

/** Kit version on the VM is at least `want` ("0.6.0"). */
export function kitAtLeast(have, want) {
  const a = String(have || '').trim().split('.').map(Number);
  const b = want.split('.').map(Number);
  if (a.length < 2 || a.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < b.length; i++) {
    const x = a[i] || 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

export { UUID_RE };
export const _test = { shape, statusScript };
