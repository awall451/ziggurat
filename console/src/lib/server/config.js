// Registry: projects, deploy targets and the price table live as JSON files in
// CONSOLE_CONFIG_DIR (outside the repo), so they can be edited by hand or
// through the API.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR = path.resolve(process.env.CONSOLE_CONFIG_DIR || './config');
export const DATA_DIR = path.resolve(process.env.CONSOLE_DATA_DIR || './data');
export const THEMES_DIR = path.resolve(process.env.ZIGGURAT_THEMES_DIR || '../themes');
// Creating projects (and everything that talks to a Proxmox host) is off unless asked for.
export const DEPLOY_ENABLED = process.env.CONSOLE_DEPLOY === '1';
// Folders pulled data may be written to; set by the compose file.
export const FLEET_ROOT = process.env.FLEET_DATA ? path.resolve(process.env.FLEET_DATA) : null;
export const TRANSCRIPTS_ROOT = process.env.TRANSCRIPTS_DIR ? path.resolve(process.env.TRANSCRIPTS_DIR) : null;

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${e.message}`);
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const KIT_DEFAULTS = {
  state: '/var/lib/agent-kit',
  leadUnit: 'agent-kit-lead',
  agentHome: '/home/agent'
};

function normalizeProject(p) {
  const kit = { ...KIT_DEFAULTS, ...(p.kit || {}) };
  kit.workspace ||= `${kit.agentHome}/${p.id}`;
  kit.bare ||= `/srv/${p.id}.git`;
  return {
    theme: 'plain',
    accent: '#4fd8ff',
    hidden: false,
    pull: true,
    description: '',
    agentAliases: {},
    ...p,
    name: p.name || p.id,
    kit,
    // Claude Code names a project's transcript folder after its path.
    slug: kit.workspace.replace(/[^A-Za-z0-9]/g, '-'),
    paths: {
      transcripts: p.paths?.transcripts || path.join(DATA_DIR, 'boxes', p.id, 'projects'),
      fleet: p.paths?.fleet || path.join(DATA_DIR, 'boxes', p.id, 'fleet')
    }
  };
}

export function listProjects() {
  const raw = readJson(path.join(CONFIG_DIR, 'projects.json'), { projects: [] });
  return (raw.projects || []).filter((p) => ID_RE.test(p.id || '')).map(normalizeProject);
}

export function getProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

/** Entries exactly as stored (no defaults filled in), for the editor. */
export function rawProjects() {
  return readJson(path.join(CONFIG_DIR, 'projects.json'), { projects: [] }).projects || [];
}

/** Where a project's pulled data may live (see schema.validateProject). */
export function pathRoots() {
  return { allowed: [DATA_DIR, FLEET_ROOT, TRANSCRIPTS_ROOT].filter(Boolean), forbidden: [CONFIG_DIR] };
}

// One list file with entries keyed by id. `replace` swaps the whole entry
// (the editor); without it the given fields are merged into the stored one.
function saveEntry(name, entry, replace) {
  if (!ID_RE.test(entry.id || '')) throw new Error(`invalid ${name.slice(0, -1)} id`);
  const file = path.join(CONFIG_DIR, `${name}.json`);
  const raw = readJson(file, { [name]: [] });
  raw[name] ||= [];
  const i = raw[name].findIndex((e) => e.id === entry.id);
  if (i >= 0) raw[name][i] = replace ? entry : { ...raw[name][i], ...entry };
  else raw[name].push(entry);
  writeJson(file, raw);
}

/** Removes the registry entry only. Nothing on a VM or a host is touched. */
function deleteEntry(name, id) {
  const file = path.join(CONFIG_DIR, `${name}.json`);
  const raw = readJson(file, { [name]: [] });
  const before = (raw[name] || []).length;
  raw[name] = (raw[name] || []).filter((e) => e.id !== id);
  if (raw[name].length === before) return false;
  writeJson(file, raw);
  return true;
}

export function saveProject(project, { replace = false } = {}) {
  saveEntry('projects', project, replace);
  return getProject(project.id);
}

export function deleteProject(id) {
  return deleteEntry('projects', id);
}

export function listTargets() {
  return readJson(path.join(CONFIG_DIR, 'targets.json'), { targets: [] }).targets || [];
}

export function getTarget(id) {
  return listTargets().find((t) => t.id === id) || null;
}

export function saveTarget(target, { replace = false } = {}) {
  saveEntry('targets', target, replace);
  return getTarget(target.id);
}

export function deleteTarget(id) {
  return deleteEntry('targets', id);
}

export function listThemes() {
  try {
    return fs
      .readdirSync(THEMES_DIR)
      .filter((f) => /^[a-z0-9-]{1,40}\.yml$/.test(f))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

const DEFAULT_PRICING = {
  cacheWrite5mFactor: 1.25,
  cacheWrite1hFactor: 2.0,
  models: [],
  default: { input: 4, output: 20, cacheRead: 0.2 }
};

let pricingCache = { at: 0, value: DEFAULT_PRICING };

export function getPricing() {
  if (Date.now() - pricingCache.at > 60_000) {
    const raw = readJson(path.join(CONFIG_DIR, 'pricing.json'), null);
    pricingCache = { at: Date.now(), value: raw ? { ...DEFAULT_PRICING, ...raw } : DEFAULT_PRICING };
  }
  return pricingCache.value;
}
