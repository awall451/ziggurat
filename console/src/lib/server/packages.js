// Package and domain requests from a team's lead (kit 0.16). The lead asks
// with owner-packages; the owner approves or declines here. Approving first
// adds the domains the request needs to the gateway's allow-list (gateway.js),
// then tells the VM; the VM installs it as root between cycles. What the lead
// wrote is data: the request is checked here and again on the VM.
import fs from 'node:fs';
import path from 'node:path';
import * as config from './config.js';
import { kit, pull } from './ssh.js';
import { parseHeaderFile } from './headerfile.js';
import { audit } from './audit.js';
import { kitAtLeast } from './live.js';
import { validateTarget } from './schema.js';
import { inspect, domainAllowed } from './pve.js';
import { allowDomains, DOMAIN_RE } from './gateway.js';

export const PACKAGES_KIT = '0.16.0';
const RID_RE = /^[0-9]{8}T[0-9]{6}Z-k-[a-f0-9]{6}$/;
const APT_RE = /^apt:[a-z0-9][a-z0-9+.-]{1,62}$/;
const RECIPE_RE = /^recipe:([a-z0-9][a-z0-9-]{0,39})(@([0-9][0-9A-Za-z.+-]{0,30}))?$/;
const DOMAIN_REQ_RE = /^domain:(.+)$/;
const RECIPES = path.join(config.REPO_DIR, 'kit', 'vm', 'recipes');

export const kitHasPackages = (version) => kitAtLeast(version, PACKAGES_KIT);
const outDir = (project) => path.join(config.DATA_DIR, 'packages', project.id, 'out');

/** What a request is, and the domains it needs; null for anything the kit would not install. */
export function describe(request) {
  const r = String(request || '');
  if (APT_RE.test(r)) return { kind: 'apt', name: r.slice(4), version: null, domains: [] };
  let m = RECIPE_RE.exec(r);
  if (m) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(RECIPES, `${m[1]}.sh`), 'utf8');
    } catch {
      return null;
    }
    const domains = (/^# Domains: (.*)$/m.exec(text)?.[1] || '').split(/\s+/).filter((d) => DOMAIN_RE.test(d));
    const about = text
      .split('\n')
      .filter((l) => /^# /.test(l) && !/^# [A-Z][a-z]*: /.test(l))
      .map((l) => l.slice(2))
      .join(' ')
      .slice(0, 400);
    return { kind: 'recipe', name: m[1], version: m[3] || null, domains, about };
  }
  m = DOMAIN_REQ_RE.exec(r);
  if (m && DOMAIN_RE.test(m[1])) return { kind: 'domain', name: m[1], version: null, domains: [m[1]] };
  return null;
}

/** Parse `agent-kit-packages status`: one JSON object per line. */
export function parseStatus(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || !RID_RE.test(o.rid || '')) continue;
    const what = describe(o.request);
    if (!what) continue;
    const decision = ['approved', 'denied'].includes(o.decision) ? o.decision : null;
    const result = ['installing', 'ok', 'failed'].includes(o.result) ? o.result : null;
    out.push({ rid: o.rid, request: o.request, what, decision, decidedAt: decision ? o.decidedAt || null : null, result, resultAt: result ? o.resultAt || null : null });
  }
  return out;
}

const stateOf = (r) => (r.decision === 'denied' ? 'declined' : r.decision === 'approved' ? { ok: 'installed', failed: 'failed', installing: 'installing' }[r.result] || 'approved' : 'waiting');

/** The project's target, checked, or null (projects added by hand may have none). */
function targetFor(project) {
  const raw = project.target ? config.getTarget(project.target) : null;
  if (!raw) return null;
  try {
    return validateTarget(raw);
  } catch {
    return null;
  }
}

/**
 * The project's requests, newest first, with the lead's reason and which
 * domains the gateway still lacks. Never throws; an unreachable VM gives an error.
 */
export async function requests(project) {
  const res = await kit(project, 'agent-kit-packages', ['status']);
  if (res.code !== 0) return { requests: [], error: (res.stderr || `exit ${res.code}`).trim().slice(-200), gateway: null };
  const list = parseStatus(res.stdout);
  if (list.some((r) => !r.decision)) {
    fs.mkdirSync(outDir(project), { recursive: true });
    await pull(project, [`${project.kit.state}/packages-out/`], outDir(project), { as: 'agent', maxSize: '16k', timeout: 60000, filters: ['--include=*.md', '--exclude=*'] }).catch(() => {});
  }
  const target = targetFor(project);
  let allowed = null;
  if (target && list.some((r) => !r.decision && r.what.domains.length)) {
    const seen = await inspect(target).catch(() => null);
    allowed = seen?.allowed || null;
  }
  const out = list.map((r) => {
    const f = parseHeaderFile(path.join(outDir(project), `${r.rid}.md`), 6000);
    const reason = f && f.fields.request === r.request ? f.body.slice(0, 2000) : null;
    const missing = allowed ? r.what.domains.filter((d) => !domainAllowed(allowed, d.replace(/^\./, ''))) : null;
    return { ...r, state: stateOf(r), reason, missing };
  });
  out.sort((a, b) => (a.rid < b.rid ? 1 : -1));
  return { requests: out, error: null, gateway: target ? (allowed ? 'checked' : 'unknown') : 'none' };
}

/** The owner's decision. Approving adds the missing domains on the gateway first. */
export async function decideRequest(user, project, rid, decision) {
  if (!RID_RE.test(rid)) throw new Error('Bad request id');
  if (!['approve', 'deny'].includes(decision)) throw new Error('Bad decision');
  let added = [];
  if (decision === 'approve') {
    const { requests: list } = await requests(project);
    const r = list.find((x) => x.rid === rid);
    if (!r) throw new Error('No such request');
    if (r.decision) throw new Error('Already decided');
    if (r.what.domains.length) {
      const target = targetFor(project);
      if (!target) throw new Error(`This project has no deploy target, so the console cannot add ${r.what.domains.join(', ')} to the gateway. Add them by hand, then approve again.`);
      if (r.missing == null) throw new Error('Could not read the gateway\'s allow-list; try again');
      if (r.missing.length) {
        await allowDomains(user, target, r.missing, { project: project.id });
        added = r.missing;
      }
    }
  }
  const res = await kit(project, 'agent-kit-packages', [decision, rid]);
  const ok = res.code === 0;
  const detail = ok ? null : (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(-200);
  audit(user, project.id, decision === 'approve' ? 'package-approve' : 'package-deny', { rid, added }, { ok, detail });
  if (!ok) throw new Error(detail);
  return { ok: true, added };
}
