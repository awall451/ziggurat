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
canoneshot=$([ -x /opt/agent-kit/bin/agent-kit-oneshot ] && echo yes || echo no)
f=$(grep -l "all checks passed" "$STATE"/gate/results/*.json 2>/dev/null | xargs -r ls -t | head -1)
shots=$([ -n "$f" ] && jq -r '.shots // empty' "$f" 2>/dev/null)
jq -nc --arg control "$control" --arg lead "$lead" --arg timer "$timer" --arg since "$since" \\
  --arg head "$head" --arg ready "$ready" --arg remote "$remote" --arg current "$current" \\
  --arg newest "$newest" --arg worktrees "$worktrees" --arg haltat "$haltat" \\
  --arg gatepaused "$gatepaused" --arg kitver "$kitver" --arg shots "$shots" \\
  --arg oneshot "$oneshot" --arg canoneshot "$canoneshot" \\
  --arg host "$(hostname)" --arg now "$(date +%s)" \\
  '{control:$control, lead:$lead, timer:$timer, since:$since, head:$head, ready:$ready, remote:$remote,
    current:$current, newest:$newest, worktrees:($worktrees|tonumber? // 0), haltat:$haltat,
    gatepaused:$gatepaused, kitver:$kitver, shots:$shots, oneshot:$oneshot, canoneshot:$canoneshot, host:$host, now:($now|tonumber? // 0)}'
`;
}

function shape(raw) {
  const [sha, date, ...subject] = (raw.head || '').split('\t');
  const stopped = /^stop/.test(raw.control || '');
  const running = raw.lead === 'active' || raw.lead === 'activating';
  // Session of the cycle in progress: the kit's `current` file when present,
  // otherwise the newest transcript in the workspace's folder.
  let session = (raw.current || '').trim().split(/\s+/)[0] || '';
  if (!UUID_RE.test(session)) {
    const m = /([0-9a-f-]{36})\.jsonl$/.exec(raw.newest || '');
    session = m ? m[1] : '';
  }
  const [haltEpoch, ...haltReason] = (raw.haltat || '').trim().split(/\s+/);
  const [jobId, jobSince] = (raw.oneshot || '').trim().split(/\s+/);
  return {
    reachable: true,
    state: running ? 'running' : stopped ? 'halted' : 'idle',
    control: raw.control || '',
    leadActive: running,
    leadSince: running ? raw.since : null,
    timerEnabled: raw.timer === 'enabled',
    main: sha ? { sha, date, subject: subject.join('\t') } : null,
    ready: raw.ready ? raw.ready.split(',') : [],
    worktrees: raw.worktrees,
    remote: raw.remote || null,
    session: UUID_RE.test(session) ? session : null,
    haltAt: /^\d+$/.test(haltEpoch || '') ? { epoch: Number(haltEpoch), reason: haltReason.join(' ') } : null,
    gatePaused: raw.gatepaused === 'yes',
    kitVersion: raw.kitver || null,
    // A one-shot job in progress: one cycle for one owner message, then halted again.
    oneshot: /^[0-9]{8}T[0-9]{6}Z-o-[a-z0-9-]{1,40}$/.test(jobId || '') ? { id: jobId, since: jobSince || null } : null,
    canOneshot: raw.canoneshot === 'yes',
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

export { UUID_RE };
