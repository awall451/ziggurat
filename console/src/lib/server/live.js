// Live state of one sandbox VM: a single read-only ssh round trip, cached
// briefly. "Running" is decided only from facts on the VM (unit state, the
// VM's own clock), never by comparing against the workstation clock.
import { readScript, q, setVmIdentity } from './ssh.js';

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
# Which project this VM says it is (the kit writes PROJECT= at install).
vmproject=$(sed -n 's/^PROJECT=//p' /etc/agent-kit/project.env 2>/dev/null | head -1 | head -c 80)
# A chat turn with the lead, and jobs set for a time (kit 0.10).
chat=$(head -c 200 "$STATE/chat" 2>/dev/null)
atjobs=$([ -d "$STATE/oneshot-at" ] && sudo -n /opt/agent-kit/bin/agent-kit-oneshot list-at 2>/dev/null | head -50)
haltafter=$(head -c 300 "$STATE/halt-after" 2>/dev/null)
canhaltafter=$([ -x /opt/agent-kit/bin/agent-kit-halt-after ] && echo yes || echo no)
canoneshot=$([ -x /opt/agent-kit/bin/agent-kit-oneshot ] && echo yes || echo no)
# Whether the session in progress is stuck, and why (kit 0.24): one JSON line.
stall=$([ -x /opt/agent-kit/bin/agent-kit-stall ] && sudo -n /opt/agent-kit/bin/agent-kit-stall 2>/dev/null | head -c 600)
# Focus mode (kit 0.27): this team in focus, paused for another's, and how the last focus ended.
focus=$([ -x /opt/agent-kit/bin/agent-kit-focus ] && sudo -n /opt/agent-kit/bin/agent-kit-focus show 2>/dev/null | head -c 1000)
# Cycle slots (agent-kit-schedule, kit 0.9): empty when cycles simply follow each other.
schedule=$(head -c 6000 /etc/agent-kit/schedule 2>/dev/null)
# Why an idle team is idle: the daily cap (owner's caps.env wins over project.env,
# as in lead-cycle), cycles counted today by the VM's own date, the timer's next run.
cap=$(sed -nE 's/^MAX_CYCLES_PER_DAY=([0-9]{1,5})$/\\1/p' /etc/agent-kit/project.env /etc/agent-kit/caps.env 2>/dev/null | tail -1)
today=$(jq -s --arg d "$(date +%F)" '[.[] | select(.date == $d and .counted != false)] | length' "$STATE/ledger/cycles.jsonl" 2>/dev/null)
next=$(systemctl show "$UNIT.timer" -p NextElapseUSecRealtime --value 2>/dev/null)
next=$([ -n "$next" ] && date -d "$next" +%s 2>/dev/null)
dayend=$(date -d 'tomorrow 00:00' +%s 2>/dev/null)
# What waits for the owner besides the lead's questions: changes to the checks that
# the gate holds (kit 0.14), and package or domain requests without a decision
# (kit 0.16). Counted from files anyone may read; an older kit has none.
held=$(grep -l '"status": *"held"' "$STATE"/gate/results/*.json 2>/dev/null | wc -l)
pkgwait=0
for r in "$STATE"/packages-out/*.md; do
  [ -f "$r" ] && [ ! -L "$r" ] || continue
  r=$(basename "$r" .md)
  [[ $r =~ ^[0-9]{8}T[0-9]{6}Z-k-[a-f0-9]{6}$ ]] || continue
  [ -e "$STATE/packages/.owner/$r" ] || pkgwait=$((pkgwait + 1))
done
# Requests whose files the console has to bring (kit 0.17).
pkgfetch=0
for r in "$STATE"/packages/results/*; do
  read -r w _ < "$r" 2>/dev/null
  [ "$w" = fetching ] && [ ! -e "$STATE/packages/files/$(basename "$r")/.ready" ] && pkgfetch=$((pkgfetch + 1))
done
f=$(grep -l '"status": *"merged"' "$STATE"/gate/results/*.json 2>/dev/null | xargs -r grep -l "all checks passed" | xargs -r ls -t | head -1)
shots=$([ -n "$f" ] && jq -r '.shots // empty' "$f" 2>/dev/null)
jq -nc --arg control "$control" --arg lead "$lead" --arg timer "$timer" --arg since "$since" \\
  --arg head "$head" --arg ready "$ready" --arg remote "$remote" --arg current "$current" \\
  --arg newest "$newest" --arg worktrees "$worktrees" --arg haltat "$haltat" \\
  --arg gatepaused "$gatepaused" --arg kitver "$kitver" --arg shots "$shots" \\
  --arg oneshot "$oneshot" --arg canoneshot "$canoneshot" --arg chat "$chat" --arg atjobs "$atjobs" --arg vmproject "$vmproject" \\
  --arg haltafter "$haltafter" --arg canhaltafter "$canhaltafter" --arg stall "$stall" --arg focus "$focus" \\
  --arg cap "$cap" --arg today "$today" --arg next "$next" --arg dayend "$dayend" \\
  --arg schedule "$schedule" --arg held "$held" --arg pkgwait "$pkgwait" --arg pkgfetch "$pkgfetch" \\
  --arg host "$(hostname)" --arg now "$(date +%s)" \\
  '{control:$control, lead:$lead, timer:$timer, since:$since, head:$head, ready:$ready, remote:$remote,
    current:$current, newest:$newest, worktrees:($worktrees|tonumber? // 0), haltat:$haltat,
    gatepaused:$gatepaused, kitver:$kitver, shots:$shots, oneshot:$oneshot, canoneshot:$canoneshot, chat:$chat, atjobs:$atjobs, vmproject:$vmproject,
    haltafter:$haltafter, canhaltafter:$canhaltafter, stall:$stall, focus:$focus, cap:$cap, today:$today, next:$next, dayend:$dayend, schedule:$schedule,
    held:$held, pkgwait:$pkgwait, pkgfetch:$pkgfetch,
    host:$host, now:($now|tonumber? // 0)}'
`;
}

/** A chat turn in progress: "<plan-id> <msgid> <since>". */
function chatOf(text) {
  const [plan, msg, since] = String(text || '').trim().split(/\s+/);
  return /^[0-9]{8}T[0-9]{6}Z-p-[a-z0-9-]{1,40}$/.test(plan || '') && /^[0-9]{8}T[0-9]{6}Z-c-[a-f0-9]{6}$/.test(msg || '') ? { plan, msg, since: since || null } : null;
}

const WAIT_RE = /^(busy|pending|running|failed|held|merge)$/;

/**
 * Jobs set for a time: "<id> <unix> <from>" lines. From kit 0.18 also why a
 * job whose time has come has not started, and the job it waits for.
 */
function atJobsOf(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([id, at]) => /^[0-9]{8}T[0-9]{6}Z-[opf]-[a-z0-9-]{1,40}$/.test(id || '') && /^\d{9,11}$/.test(at || ''))
    .map(([id, at, from, why, dep, pc]) => ({
      id,
      at: Number(at),
      from: /^[A-Za-z0-9._@-]{1,80}$/.test(from || '') ? from : null,
      plan: /-p-/.test(id),
      // A normal cycle set for a time, with no job (kit 0.25).
      free: /-f-/.test(id),
      // Set to run past the daily cap (kit 0.26).
      pastCap: pc === 'past-cap',
      wait: WAIT_RE.test(why || '') ? { reason: why, job: /^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(dep || '') ? dep : null } : null
    }));
}

const STALL_REASONS = ['usage-limit', 'api-error', 'no-progress'];
const epoch = (v) => (Number.isInteger(v) && v > 1e9 && v < 1e11 ? v : null);

/**
 * Why the session in progress is stuck (agent-kit-stall, kit 0.24), or null.
 * `since` and `resetsAt` are unix seconds on the VM's clock.
 */
export function stallOf(text) {
  let o;
  try {
    o = JSON.parse(String(text || '').trim().split('\n').at(-1));
  } catch {
    return null;
  }
  if (!o || o.stalled !== true || !STALL_REASONS.includes(o.reason)) return null;
  const small = (v) => (Number.isInteger(v) && v >= 0 && v < 100000 ? v : null);
  return {
    reason: o.reason,
    since: epoch(o.since),
    resetsAt: o.reason === 'usage-limit' ? epoch(o.resetsAt) : null,
    limit: o.reason === 'usage-limit' && /^[a-z_]{1,40}$/.test(o.limit || '') ? o.limit : null,
    status: o.reason === 'api-error' ? small(o.status) : null,
    attempt: o.reason === 'api-error' ? small(o.attempt) : null,
    minutes: o.reason === 'no-progress' ? small(o.minutes) : null,
    chat: o.kind === 'chat'
  };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const posInt = (v) => (Number.isInteger(v) && v >= 0 && v < 1e11 ? v : null);

/**
 * Focus mode as the VM says (agent-kit-focus show, kit 0.27): {on, paused, ended}
 * or null on an older kit. `on`: this team runs in focus; `paused`: it waits for
 * another team's focus; `ended`: when and why its last focus ended.
 */
export function focusOf(text) {
  let o;
  try {
    o = JSON.parse(String(text || '').trim().split('\n').at(-1));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const f = o.focus && typeof o.focus === 'object' ? o.focus : null;
  const p = o.paused && typeof o.paused === 'object' ? o.paused : null;
  const e = o.ended && typeof o.ended === 'object' ? o.ended : null;
  // A planned job due before a new focus cycle would end (kit 0.28): no focus cycle starts in its way.
  const h = o.hold && typeof o.hold === 'object' && /^[0-9]{8}T[0-9]{6}Z-[opf]-[a-z0-9-]{1,40}$/.test(o.hold.id || '') && posInt(o.hold.at) ? { id: o.hold.id, at: o.hold.at, kind: /-f-/.test(o.hold.id) ? 'once' : /-p-/.test(o.hold.id) ? 'plan' : 'job' } : null;
  return {
    on: f && posInt(f.since) ? { since: f.since, until: posInt(f.until), cycles: posInt(f.cycles), perDay: posInt(f.perDay), done: posInt(f.done) ?? 0, hold: h } : null,
    paused: p && posInt(p.until) && NAME_RE.test(p.for || '') ? { since: posInt(p.since), until: p.until, for: p.for } : null,
    ended: e && posInt(e.at) ? { at: e.at, reason: String(e.reason || '').replace(/[^A-Za-z0-9 .,:;()_@/-]/g, '').slice(0, 200) } : null
  };
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
    // Cycles counted today by the VM's own date, as lead-cycle counts them.
    today: count(raw.today),
    schedule: typeof raw.schedule === 'string' ? raw.schedule.slice(0, 6000) : '',
    // A one-shot job in progress: one cycle for one owner message, then halted
    // again, or (started on an idle team, kit 0.6) back to running.
    // From kit 0.10 also a planning cycle (an id with -p-).
    // From kit 0.25 also a normal cycle the owner started with no job (an id with -f-).
    oneshot: /^[0-9]{8}T[0-9]{6}Z-[opf]-[a-z0-9-]{1,40}$/.test(jobId || '')
      ? { id: jobId, since: jobSince || null, runsOn: jobAfter === 'run', plan: /-p-/.test(jobId), free: /-f-/.test(jobId) }
      : null,
    chat: chatOf(raw.chat),
    atJobs: atJobsOf(raw.atjobs),
    canOneshot: raw.canoneshot === 'yes',
    // The cycle (or chat turn) in progress is stuck, and why (kit 0.24): shown as Stalled.
    stalled: running || chatOf(raw.chat) ? stallOf(raw.stall) : null,
    // Focus mode (kit 0.27).
    focus: focusOf(raw.focus),
    // A halt that waits for the cycle in progress to end (and for the gate after it).
    haltAfter,
    canHaltAfter: raw.canhaltafter === 'yes',
    // Waiting for the owner on the Inbox tab, besides the lead's questions.
    heldChanges: count(raw.held) ?? 0,
    packageRequests: count(raw.pkgwait) ?? 0,
    // Approved recipes that wait for files the console fetches.
    packageFetches: count(raw.pkgfetch) ?? 0,
    shotsDir: /^\/var\/lib\/agent-kit\/[A-Za-z0-9._\/-]+$/.test(raw.shots || '') ? raw.shots : null,
    host: raw.host,
    vmNow: raw.now
  };
}

async function fetchStatus(project) {
  // Two entries reach one VM: neither may show the other's team as its own.
  if (project.vmShared?.length) {
    return { reachable: false, state: 'unreachable', leadActive: false, vmShared: project.vmShared, error: `Shares its VM with ${project.vmShared.join(', ')} in this console. Remove the stale project.` };
  }
  const res = await readScript(project, statusScript(project), { timeout: 25000 });
  if (res.code !== 0) {
    return { reachable: false, state: 'unreachable', leadActive: false, error: (res.stderr || '').trim().slice(-300) };
  }
  let raw;
  try {
    raw = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    return { reachable: false, state: 'unreachable', leadActive: false, error: 'bad status output' };
  }
  // The VM names its project (PROJECT= in its project.env). A VM that names
  // another one was handed to another team (a deleted VM's id and address
  // reused): show nothing of it as this project's, and send it nothing.
  const expected = project.vmProject || project.id;
  const found = /^[A-Za-z0-9._-]{1,80}$/.test(raw.vmproject || '') ? raw.vmproject : null;
  if (found && found !== expected) {
    setVmIdentity(project.id, found);
    return { reachable: false, state: 'unreachable', leadActive: false, vmMismatch: { expected, found }, error: `This VM now belongs to the project "${found}", not to ${project.name || project.id}. Nothing is sent to it.` };
  }
  setVmIdentity(project.id, null);
  return { ...shape(raw), vmProject: found };
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
/** The kit that can start a normal cycle with no job (agent-kit-oneshot --free). */
export const FREE_KIT = '0.25.0';

/**
 * Can the owner start one normal cycle now ("Run a cycle now", kit 0.25)?
 * {can, why} and, when it can, whether the team is halted (it halts again
 * after) and whether the daily cap is reached (then only past the cap).
 */
export function runCycleState(st) {
  const no = (why) => ({ can: false, why });
  if (!st?.reachable) return no(st?.state === 'checking' ? 'Checking the VM' : 'The VM is not reachable');
  if (st.vmMismatch || st.vmShared) return no('Not this project\'s VM');
  if (!kitAtLeast(st.kitVersion, FREE_KIT)) return no(`The VM needs kit ${FREE_KIT} or later (it has ${st.kitVersion || 'an older one'})`);
  if (st.oneshot) return no(st.oneshot.free ? 'A cycle you started is running' : st.oneshot.plan ? 'A planning cycle is running' : 'A one-shot job is running');
  if (st.leadActive) return no('A cycle is running');
  if (st.haltAfter) return no('A halt is pending. Cancel it under Controls first');
  const atCap = Number.isInteger(st.cap) && Number.isInteger(st.today) && st.today >= st.cap;
  return { can: true, why: null, halted: st.state === 'halted', atCap, today: st.today ?? null, cap: st.cap ?? null };
}

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
