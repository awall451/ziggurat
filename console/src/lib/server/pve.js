// Read-only look at a deploy target (a Proxmox host). One fixed script, built
// only from validated target fields, asks the host what exists: guests, the
// sandbox bridge, the gateway container, the template, storage and memory.
// Nothing here changes the host.
import { hostScript, setHostKey, q } from './ssh.js';
import { validateTarget, targetNet } from './schema.js';

const CACHE_MS = 30_000;
const cache = new Map(); // target id -> {at, value}

function script(t) {
  const sec = (name, cmd) => `echo '@@${name}'; ${cmd} 2>&1; echo "@@rc $?"`;
  return [
    'export LC_ALL=C',
    sec('qm', 'qm list'),
    sec('pct', 'pct list'),
    sec('bridge', `ip -o link show ${q(t.bridge)}`),
    sec('gateway', `pct status ${t.gatewayVmid}`),
    sec('template', `qm config ${t.templateVmid}`),
    sec('snippets', `pvesh get /storage/${q(t.snippetsStorage)} --output-format json`),
    sec('storage', `pvesm status --storage ${q(t.storage)}`),
    sec('mem', 'free -m'),
    // The gateway's domain allow-list (read-only), to warn about a team that needs more:
    // the playbook's list and the domains the owner approved since (agent-allow, kit 0.16).
    // A marker line parts the two: only the owner's extra domains can be taken back.
    sec('allow', `pct exec ${t.gatewayVmid} -- sh -c 'cat /etc/squid/agent-allow.txt; echo "#--extra--"; cat /etc/squid/agent-allow-extra.txt 2>/dev/null; true'`),
    sec('version', 'pveversion')
  ].join('\n');
}

/** Split the script's output into {name: {out, rc}}. */
function sections(stdout) {
  const out = {};
  let cur = null;
  for (const line of stdout.split('\n')) {
    let m;
    if ((m = /^@@rc (-?\d+)$/.exec(line))) {
      if (cur) out[cur].rc = Number(m[1]);
      cur = null;
    } else if ((m = /^@@([a-z]+)$/.exec(line))) {
      cur = m[1];
      out[cur] = { out: '', rc: null };
    } else if (cur) out[cur].out += line + '\n';
  }
  return out;
}

function guests(sec) {
  const list = [];
  for (const line of (sec.qm?.out || '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (/^\d+$/.test(p[0]) && p.length >= 3) list.push({ vmid: Number(p[0]), name: p[1], status: p[2], kind: 'vm' });
  }
  for (const line of (sec.pct?.out || '').split('\n')) {
    const p = line.trim().split(/\s+/);
    // VMID Status [Lock] Name
    if (/^\d+$/.test(p[0]) && p.length >= 3) list.push({ vmid: Number(p[0]), name: p[p.length - 1], status: p[1], kind: 'ct' });
  }
  return list.sort((a, b) => a.vmid - b.vmid);
}

/** Turn the script output into the facts and checks the console shows. Pure, so it can be tested. */
export function parseInspect(stdout, t) {
  const sec = sections(stdout);
  const net = targetNet(t);
  const all = guests(sec);
  const taken = new Set(all.map((g) => g.vmid));
  const free = [];
  for (let i = t.vmidMin; i <= t.vmidMax; i++) if (!taken.has(i) && !t.criticalVmids.includes(i)) free.push(i);

  let pool = null;
  for (const line of (sec.storage?.out || '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === t.storage && p.length >= 7) {
      const pct = Number(String(p[6]).replace('%', ''));
      if (Number.isFinite(pct)) {
        pool = { type: p[1], pct, totalKb: Number(p[3]) || 0, availKb: Number(p[5]) || 0 };
        pool.level = pct >= t.poolBlockPct ? 'block' : pct >= t.poolWarnPct ? 'warn' : 'ok';
      }
    }
  }
  let memFreeMb = null;
  const mem = /^Mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(sec.mem?.out || '');
  if (mem) memFreeMb = Number(mem[6]);

  const first = (s) => (s?.out || '').trim().split('\n')[0] || '';
  const tpl = sec.template?.out || '';
  let snippets = false;
  try {
    snippets = String(JSON.parse(sec.snippets?.out || '{}').content || '').split(',').includes('snippets');
  } catch {
    snippets = false;
  }
  const gw = all.find((g) => g.vmid === t.gatewayVmid);
  const inRange = all.filter((g) => g.vmid >= t.vmidMin && g.vmid <= t.vmidMax);

  const checks = [
    { id: 'bridge', label: `Sandbox bridge ${t.bridge} exists`, ok: sec.bridge?.rc === 0, detail: sec.bridge?.rc === 0 ? '' : first(sec.bridge) },
    {
      id: 'gateway',
      label: `Gateway container ${t.gatewayVmid} is running`,
      ok: sec.gateway?.rc === 0 && /running/.test(sec.gateway.out),
      detail: gw ? `${gw.name}: ${first(sec.gateway)}` : first(sec.gateway)
    },
    {
      id: 'template',
      label: `Template ${t.templateVmid} exists`,
      ok: sec.template?.rc === 0 && /^template:\s*1/m.test(tpl),
      detail: sec.template?.rc === 0 ? (/^name:\s*(.+)$/m.exec(tpl)?.[1] || '') + (/^template:\s*1/m.test(tpl) ? '' : ' (not marked as a template)') : first(sec.template)
    },
    { id: 'snippets', label: `Storage ${t.snippetsStorage} holds snippets`, ok: snippets, detail: snippets ? '' : 'enable the "snippets" content type on it' },
    {
      id: 'pool',
      label: `Storage ${t.storage} has room`,
      ok: !!pool && pool.level !== 'block',
      warn: pool?.level === 'warn',
      detail: pool ? `${pool.pct.toFixed(1)}% used (warn at ${t.poolWarnPct}%, no deploys at ${t.poolBlockPct}%)` : first(sec.storage) || 'not found'
    },
    { id: 'vmids', label: `Free VM ids in ${t.vmidMin}–${t.vmidMax}`, ok: free.length > 0, detail: `${free.length} free, ${inRange.length} in use` }
  ];
  const next = free[0] ?? null;
  const names = (text) =>
    text
      .split('\n')
      .map((l) => l.split('#')[0].trim().toLowerCase())
      .filter((l) => /^\.?[a-z0-9.-]+$/.test(l));
  const allowed = sec.allow?.rc === 0 ? names(sec.allow.out) : null;
  // What the owner added through the console since the gateway was made (after the marker).
  const allowedExtra = sec.allow?.rc === 0 && sec.allow.out.includes('#--extra--') ? names(sec.allow.out.split('#--extra--')[1]) : null;
  return {
    ok: checks.every((c) => c.ok),
    checks,
    guests: all.map((g) => ({ ...g, critical: t.criticalVmids.includes(g.vmid), inRange: g.vmid >= t.vmidMin && g.vmid <= t.vmidMax })),
    free: free.slice(0, 50),
    next: next == null ? null : { vmid: next, ip: net.vmIp(next) },
    pool,
    memFreeMb,
    allowed,
    allowedExtra,
    version: first(sec.version)
  };
}

/** Does the gateway's allow-list let `domain` through? A leading dot covers sub-domains too. */
export function domainAllowed(allowed, domain) {
  const d = domain.replace(/^\./, '').toLowerCase();
  return (allowed || []).some((a) => (a.startsWith('.') ? d === a.slice(1) || d.endsWith(a) : d === a));
}

/**
 * Ask the target's Proxmox host. Never throws: a host that cannot be reached
 * comes back as {ok: false, error}.
 */
export async function inspect(target, { fresh = false } = {}) {
  let t;
  try {
    t = validateTarget(target);
  } catch (e) {
    return { ok: false, error: `This target's settings are not valid: ${e.message}`, checks: [], guests: [], at: Date.now() };
  }
  const hit = cache.get(t.id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value;
  if (!t.pveHostKey) {
    value = { ok: false, error: 'No host key is saved for this target. Add the Proxmox host key first; the console does not trust a host on first contact.', checks: [], guests: [] };
  } else {
    try {
      setHostKey(t.pveHost, t.pveHostKey);
      const res = await hostScript({ host: t.pveHost, user: t.pveUser, jump: t.bastion || null }, script(t), { timeout: 45000 });
      if (res.code !== 0 && !res.stdout.includes('@@qm')) {
        value = { ok: false, error: `Could not reach the Proxmox host: ${(res.stderr || `ssh exit ${res.code}`).trim().split('\n').slice(-2).join(' ').slice(-300)}`, checks: [], guests: [] };
      } else value = parseInspect(res.stdout, t);
    } catch (e) {
      value = { ok: false, error: e.message, checks: [], guests: [] };
    }
  }
  value.at = Date.now();
  cache.set(t.id, { at: value.at, value });
  return value;
}

export function forgetInspect(id) {
  cache.delete(id);
}
