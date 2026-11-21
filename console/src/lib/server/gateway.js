// Adding a domain to the agent gateway's allow-list, after the owner approved
// a team's request (kit 0.16). One fixed helper on the gateway does the work
// (/usr/local/sbin/agent-allow, installed by create-agent-gateway.yml): it
// checks the name again, appends it to agent-allow-extra.txt and reloads
// squid. The list is shared by every agent VM behind that gateway.
import { hostScript } from './ssh.js';
import { forgetInspect } from './pve.js';
import { audit } from './audit.js';

export const DOMAIN_RE = /^\.?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The script, built only from checked values. */
export function allowScript(target, domains) {
  if (!Number.isInteger(target?.gatewayVmid)) throw new Error('The target has no gateway');
  const list = [...new Set(domains.map((d) => String(d).toLowerCase()))];
  if (!list.length || list.length > 10 || !list.every((d) => DOMAIN_RE.test(d) && d.length <= 253)) throw new Error('Not a list of domain names');
  return ['set -e', ...list.map((d) => `pct exec ${target.gatewayVmid} -- /usr/local/sbin/agent-allow add ${d}`)].join('\n');
}

/** Add domains on the target's gateway. Throws with the gateway's answer when it refuses. */
export async function allowDomains(user, target, domains, { project = null } = {}) {
  const script = allowScript(target, domains);
  const res = await hostScript({ host: target.pveHost, user: target.pveUser, jump: target.bastion || null }, script, { timeout: 60000 });
  const ok = res.code === 0;
  const detail = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-300);
  audit(user, project, 'gateway-allow', { target: target.id, domains }, { ok, detail });
  forgetInspect(target.id);
  if (!ok) throw new Error(`The gateway did not add ${domains.join(', ')}: ${detail}`);
  return { ok: true, added: domains };
}
