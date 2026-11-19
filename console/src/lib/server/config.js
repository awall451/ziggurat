// Registry: projects, deploy targets and the price table live as JSON files in
// CONSOLE_CONFIG_DIR (outside the repo), so they can be edited by hand or
// through the API.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR = path.resolve(process.env.CONSOLE_CONFIG_DIR || './config');
export const DATA_DIR = path.resolve(process.env.CONSOLE_DATA_DIR || './data');
export const THEMES_DIR = path.resolve(process.env.ZIGGURAT_THEMES_DIR || '../themes');

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

export function saveProject(project) {
  if (!ID_RE.test(project.id || '')) throw new Error('invalid project id');
  const file = path.join(CONFIG_DIR, 'projects.json');
  const raw = readJson(file, { projects: [] });
  const i = raw.projects.findIndex((p) => p.id === project.id);
  if (i >= 0) raw.projects[i] = { ...raw.projects[i], ...project };
  else raw.projects.push(project);
  writeJson(file, raw);
  return getProject(project.id);
}

export function listTargets() {
  return readJson(path.join(CONFIG_DIR, 'targets.json'), { targets: [] }).targets || [];
}

export function saveTarget(target) {
  if (!ID_RE.test(target.id || '')) throw new Error('invalid target id');
  const file = path.join(CONFIG_DIR, 'targets.json');
  const raw = readJson(file, { targets: [] });
  const i = raw.targets.findIndex((t) => t.id === target.id);
  if (i >= 0) raw.targets[i] = { ...raw.targets[i], ...target };
  else raw.targets.push(target);
  writeJson(file, raw);
  return target;
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
