// Strict checks for everything that can be saved through the console: a
// deploy target and a project entry. Values end up in ssh arguments, generated
// Ansible variables and remote commands, so each field has one narrow pattern
// and unknown fields are refused. Nothing here may start with "-".
import path from 'node:path';
import { ID_RE } from './config.js';

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const JUMP_RE = /^([a-z_][a-z0-9_-]{0,31}@)?[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[0-9]{1,5})?$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOSTKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]{40,1100}={0,3}$/;
const BRIDGE_RE = /^vmbr[0-9]{1,4}$/;
const STORAGE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ABS_RE = /^\/[A-Za-z0-9._/-]{1,250}$/;
const UNIT_RE = /^[A-Za-z0-9@._-]{1,64}$/;
const THEME_RE = /^[a-z0-9-]{1,40}$/;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const TEXT_RE = /^[^\u0000-\u001f\u007f]*$/;

export function isIPv4(v) {
  if (typeof v !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return false;
  return v.split('.').every((o) => Number(o) <= 255);
}

/** Collects problems as "field: what is wrong", then throws them together. */
class Checker {
  constructor(input, known) {
    this.problems = [];
    this.input = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!this.input) this.problems.push('expected an object');
    else for (const k of Object.keys(this.input)) if (!known.includes(k)) this.problems.push(`${k}: unknown field`);
  }
  get(key) {
    return this.input ? this.input[key] : undefined;
  }
  bad(key, what) {
    this.problems.push(`${key}: ${what}`);
    return undefined;
  }
  str(key, re, what, { fallback, required = true } = {}) {
    let v = this.get(key);
    if (v == null || v === '') {
      if (fallback !== undefined) return fallback;
      return required ? this.bad(key, 'is required') : undefined;
    }
    if (typeof v !== 'string') return this.bad(key, 'must be text');
    v = v.trim();
    if (!(re instanceof RegExp ? re.test(v) : re(v))) return this.bad(key, what);
    return v;
  }
  text(key, max, { fallback = '', required = false } = {}) {
    const v = this.get(key);
    if (v == null || v === '') return required ? this.bad(key, 'is required') : fallback;
    if (typeof v !== 'string' || v.length > max || !TEXT_RE.test(v)) return this.bad(key, `must be plain text, at most ${max} characters`);
    return v.trim();
  }
  int(key, min, max, { fallback } = {}) {
    const v = this.get(key);
    if (v == null || v === '') return fallback !== undefined ? fallback : this.bad(key, 'is required');
    const n = typeof v === 'string' && /^[0-9]{1,9}$/.test(v) ? Number(v) : v;
    if (!Number.isInteger(n) || n < min || n > max) return this.bad(key, `must be a whole number from ${min} to ${max}`);
    return n;
  }
  bool(key, fallback) {
    const v = this.get(key);
    if (v == null) return fallback;
    if (typeof v !== 'boolean') return this.bad(key, 'must be true or false');
    return v;
  }
  done(value) {
    if (this.problems.length) throw new Error(this.problems.join('; '));
    return value;
  }
}

const TARGET_KEYS = [
  'id', 'name', 'pveHost', 'pveUser', 'bastion', 'pveHostKey', 'bridge', 'subnetPrefix', 'gatewayVmid',
  'gatewayLanIp', 'gatewayHostKey', 'lanGateway', 'pveLanIp', 'templateVmid', 'vmidMin', 'vmidMax', 'storage',
  'snippetsStorage', 'snippetsDir', 'criticalVmids', 'adminUser', 'poolWarnPct', 'poolBlockPct'
];

/** A deploy target: one Proxmox host with an agent sandbox network already set up. */
export function validateTarget(input) {
  const c = new Checker(input, TARGET_KEYS);
  const hostOrIp = (v) => isIPv4(v) || HOST_RE.test(v);
  const t = {
    id: c.str('id', ID_RE, 'lowercase letters, digits and hyphens'),
    name: c.text('name', 80) || c.get('id'),
    pveHost: c.str('pveHost', hostOrIp, 'must be an address or a host name'),
    pveUser: c.str('pveUser', USER_RE, 'must be a login name', { fallback: 'root' }),
    bastion: c.str('bastion', JUMP_RE, 'must be [user@]host', { fallback: '' }),
    pveHostKey: c.str('pveHostKey', HOSTKEY_RE, 'must be "<key type> <key>" as printed by ssh-keyscan, without the host name', { fallback: '' }),
    bridge: c.str('bridge', BRIDGE_RE, 'must look like vmbr1'),
    subnetPrefix: c.str('subnetPrefix', (v) => isIPv4(`${v}.0`), 'must be the first three numbers of the sandbox subnet, like 10.66.0'),
    gatewayVmid: c.int('gatewayVmid', 100, 999999999),
    gatewayLanIp: c.str('gatewayLanIp', hostOrIp, 'must be an address or a host name'),
    gatewayHostKey: c.str('gatewayHostKey', HOSTKEY_RE, 'must be "<key type> <key>"', { fallback: '' }),
    lanGateway: c.str('lanGateway', isIPv4, 'must be an IPv4 address'),
    pveLanIp: c.str('pveLanIp', isIPv4, 'must be an IPv4 address', { fallback: isIPv4(c.get('pveHost')) ? c.get('pveHost') : undefined }),
    templateVmid: c.int('templateVmid', 100, 999999999),
    vmidMin: c.int('vmidMin', 100, 999999999),
    vmidMax: c.int('vmidMax', 100, 999999999),
    storage: c.str('storage', STORAGE_RE, 'must be a storage name'),
    snippetsStorage: c.str('snippetsStorage', STORAGE_RE, 'must be a storage name', { fallback: 'local' }),
    snippetsDir: c.str('snippetsDir', ABS_RE, 'must be an absolute path', { fallback: '/var/lib/vz/snippets' }),
    adminUser: c.str('adminUser', USER_RE, 'must be a login name'),
    poolWarnPct: c.int('poolWarnPct', 1, 100, { fallback: 80 }),
    poolBlockPct: c.int('poolBlockPct', 1, 100, { fallback: 90 }),
    criticalVmids: []
  };
  const crit = c.get('criticalVmids');
  if (crit != null) {
    if (!Array.isArray(crit) || crit.length > 200 || crit.some((n) => !Number.isInteger(n) || n < 100 || n > 999999999)) {
      c.bad('criticalVmids', 'must be a list of VM ids');
    } else t.criticalVmids = [...new Set(crit)].sort((a, b) => a - b);
  }
  if (Number.isInteger(t.vmidMin) && Number.isInteger(t.vmidMax)) {
    if (t.vmidMin > t.vmidMax) c.bad('vmidMax', 'must not be below vmidMin');
    // A VM's address is <subnetPrefix>.(vmid - vmidMin + 10), which must stay below 255.
    else if (t.vmidMax - t.vmidMin > 244) c.bad('vmidMax', 'the range may hold at most 245 ids (one address each)');
  }
  if (Number.isInteger(t.poolWarnPct) && Number.isInteger(t.poolBlockPct) && t.poolWarnPct > t.poolBlockPct) {
    c.bad('poolWarnPct', 'must not be above poolBlockPct');
  }
  if (typeof t.pveLanIp !== 'string' && !c.problems.some((p) => p.startsWith('pveLanIp'))) {
    c.bad('pveLanIp', 'is required when pveHost is a name');
  }
  return c.done(t);
}

/** Addresses derived from a target, in one place. */
export function targetNet(t) {
  return {
    gatewayBridgeIp: `${t.subnetPrefix}.1`,
    proxyUrl: `http://${t.subnetPrefix}.1:3128`,
    vmIp: (vmid) => `${t.subnetPrefix}.${vmid - t.vmidMin + 10}`
  };
}

// git@host:owner/repo.git or ssh://[user@]host[:port]/path. No leading "-", no spaces.
const REMOTE_RE = /^(?=.{1,200}$)(?:ssh:\/\/(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?\/[A-Za-z0-9._][A-Za-z0-9._\/-]*|[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._][A-Za-z0-9._\/-]*)$/;
const PROJECT_KEYS = ['id', 'name', 'description', 'theme', 'accent', 'hidden', 'pull', 'ssh', 'kit', 'paths', 'agentAliases', 'target', 'vmid', 'publish'];

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A project entry as stored in projects.json. `roots` limits where pulled data
 * may be written: {allowed: [dir, ...], forbidden: [dir, ...]}.
 */
export function validateProject(input, roots = {}) {
  const c = new Checker(input, PROJECT_KEYS);
  const p = { id: c.str('id', ID_RE, 'lowercase letters, digits and hyphens') };
  const name = c.text('name', 80);
  if (name) p.name = name;
  const description = c.text('description', 200);
  if (description) p.description = description;
  const theme = c.str('theme', THEME_RE, 'must be a theme name', { required: false });
  if (theme) p.theme = theme;
  const accent = c.str('accent', ACCENT_RE, 'must be a colour like #4fd8ff', { required: false });
  if (accent) p.accent = accent;
  for (const k of ['hidden', 'pull']) {
    const v = c.bool(k, undefined);
    if (v !== undefined) p[k] = v;
  }
  const target = c.str('target', ID_RE, 'must be a target id', { required: false });
  if (target) p.target = target;
  if (c.get('vmid') != null) p.vmid = c.int('vmid', 100, 999999999);

  const sub = (key, fields) => {
    const raw = c.get(key);
    if (raw == null) return null;
    const s = new Checker(raw, Object.keys(fields));
    const out = {};
    for (const [k, [re, what]] of Object.entries(fields)) {
      const v = s.str(k, re, what, { required: false });
      if (v) out[k] = v;
    }
    for (const m of s.problems) c.problems.push(`${key}.${m}`);
    return out;
  };

  const ssh = sub('ssh', {
    alias: [ALIAS_RE, 'must be a host alias from the ssh config'],
    host: [(v) => isIPv4(v) || HOST_RE.test(v), 'must be an address or a host name'],
    user: [USER_RE, 'must be a login name'],
    jump: [JUMP_RE, 'must be [user@]host'],
    key: [ABS_RE, 'must be an absolute path']
  });
  if (!ssh || (!ssh.alias && !ssh.host)) c.bad('ssh', 'needs an alias or a host');
  else p.ssh = ssh;

  const kit = sub('kit', {
    state: [ABS_RE, 'must be an absolute path'],
    leadUnit: [UNIT_RE, 'must be a unit name'],
    agentHome: [ABS_RE, 'must be an absolute path'],
    workspace: [ABS_RE, 'must be an absolute path'],
    bare: [ABS_RE, 'must be an absolute path']
  });
  if (kit && Object.keys(kit).length) p.kit = kit;

  const paths = sub('paths', {
    transcripts: [ABS_RE, 'must be an absolute path'],
    fleet: [ABS_RE, 'must be an absolute path']
  });
  if (paths && Object.keys(paths).length) {
    for (const [k, v] of Object.entries(paths)) {
      const abs = path.resolve(v);
      if ((roots.forbidden || []).some((d) => inside(abs, d))) c.bad(`paths.${k}`, 'may not be inside the config folder');
      else if (roots.allowed?.length && !roots.allowed.some((d) => inside(abs, d))) c.bad(`paths.${k}`, 'must be inside one of the console data folders');
    }
    p.paths = paths;
  }

  // Where main is published. An ssh address only; publish.js checks it again before use.
  const publish = sub('publish', { remote: [REMOTE_RE, 'must be an ssh address: git@host:owner/repo.git or ssh://host/path'] });
  if (publish?.remote) p.publish = publish;

  const aliases = c.get('agentAliases');
  if (aliases != null) {
    const ok =
      typeof aliases === 'object' &&
      !Array.isArray(aliases) &&
      Object.keys(aliases).length <= 100 &&
      Object.entries(aliases).every(([k, v]) => AGENT_RE.test(k) && typeof v === 'string' && AGENT_RE.test(v));
    if (!ok) c.bad('agentAliases', 'must map agent ids to agent ids');
    else if (Object.keys(aliases).length) p.agentAliases = { ...aliases };
  }
  return c.done(p);
}

const MODEL_RE = /^[a-z][a-z0-9.-]{1,39}$/;
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEPLOY_KEYS = ['id', 'name', 'description', 'remote', 'target', 'source', 'charter', 'theme', 'accent', 'cores', 'memoryMb', 'diskGb', 'vmid', 'leadModel', 'fallbackModel', 'budgetUsd', 'cyclesPerDay'];

/** What the "New project" form sends. `target` (validated) gives the id range. */
export function validateDeployRequest(input, target = null) {
  const c = new Checker(input, DEPLOY_KEYS);
  const r = {
    // Also the VM's host name: no leading or trailing hyphen.
    id: c.str('id', (v) => ID_RE.test(v) && !v.endsWith('-') && !/^[0-9]+$/.test(v), 'lowercase letters, digits and hyphens; not only digits'),
    name: c.text('name', 80) || c.get('id'),
    description: c.text('description', 200),
    target: c.str('target', ID_RE, 'must be a target id'),
    theme: c.str('theme', THEME_RE, 'must be a theme name', { fallback: 'plain' }),
    accent: c.str('accent', ACCENT_RE, 'must be a colour like #4fd8ff', { fallback: '#4fd8ff' }),
    cores: c.int('cores', 1, 16, { fallback: 4 }),
    memoryMb: c.int('memoryMb', 2048, 65536, { fallback: 12288 }),
    diskGb: c.int('diskGb', 20, 200, { fallback: 40 }),
    leadModel: c.str('leadModel', MODEL_RE, 'must be a model name', { fallback: 'fable' }),
    fallbackModel: c.str('fallbackModel', MODEL_RE, 'must be a model name', { fallback: 'opus' }),
    budgetUsd: c.int('budgetUsd', 1, 500, { fallback: 40 }),
    cyclesPerDay: c.int('cyclesPerDay', 0, 200, { fallback: 6 }),
    vmid: null,
    charter: null,
    remote: null
  };
  const remote = c.get('remote');
  if (remote != null && remote !== '') {
    if (typeof remote !== 'string' || !REMOTE_RE.test(remote)) c.bad('remote', 'must be an ssh address: git@host:owner/repo.git or ssh://host/path');
    else r.remote = remote;
  }
  const src = c.get('source');
  if (!src || typeof src !== 'object' || !['folder', 'example'].includes(src.kind) || typeof src.id !== 'string' || !SOURCE_RE.test(src.id)) {
    c.bad('source', 'pick a project folder or an example');
  } else r.source = { kind: src.kind, id: src.id };
  const charter = c.get('charter');
  if (charter != null && charter !== '') {
    if (typeof charter !== 'string' || charter.length > 40000 || /\u0000/.test(charter)) c.bad('charter', 'must be text, at most 40000 characters');
    else r.charter = charter;
  }
  if (c.get('vmid') != null && c.get('vmid') !== '') {
    r.vmid = c.int('vmid', 100, 999999999);
    if (target && Number.isInteger(r.vmid)) {
      if (r.vmid < target.vmidMin || r.vmid > target.vmidMax) c.bad('vmid', `must be in the target's range ${target.vmidMin} to ${target.vmidMax}`);
      else if (target.criticalVmids.includes(r.vmid)) c.bad('vmid', 'is a protected id');
    }
  }
  return c.done(r);
}
