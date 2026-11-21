// A team bundle is what a new project starts from: the charter, the gate
// contract and checks, the lead's prompt and the agents. It comes from a
// prepared project folder (<projects dir>/<name>/team, with optional seed/ and
// files/ beside it) or from an example in this repository that ships a seed.
//
// Everything in a bundle ends up inside the new VM, some of it run as root
// there. The console only reads it: nothing in a bundle is executed here, and
// the env files are parsed as plain KEY=value lines, never as shell.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, REPO_DIR, listThemes } from './config.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,100}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const ENV_LINE_RE = /^([A-Z][A-Z0-9_]{0,63})=([A-Za-z0-9@%+=:,._/-]{0,400})$/;
const DOMAIN_RE = /^\.?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const LIMITS = { teamBytes: 5 * 1024 * 1024, seedBytes: 200 * 1024 * 1024, filesBytes: 4 * 1024 * 1024 * 1024, entries: 20000 };
const REQUIRED = ['CHARTER.md', 'GATE-CONTRACT.md', 'lead-cycle.md', 'gate-checks'];
const TEAM_FILES = [...REQUIRED, 'project.env', 'agent.env.extra', 'provision.sh', 'requires-domains'];
const TEAM_DIRS = ['agents', 'checks'];
// The console writes these itself; a bundle cannot set them.
const RESERVED_ENV = ['PROJECT', 'WORKSPACE', 'BARE', 'STATE', 'LEAD_MODEL', 'FALLBACK_MODEL', 'CYCLE_BUDGET_USD', 'MAX_CYCLES_PER_DAY', 'AGENT_PROXY_URL'];

const EXAMPLES_DIR = path.join(REPO_DIR, 'examples');
// Team templates (how a team works, not the language) and the neutral seed they share.
const TEMPLATES_DIR = path.join(REPO_DIR, 'templates');
const TEMPLATE_SEED = path.join(TEMPLATES_DIR, '_seed');
// The owner's plan and design documents, put into the seed's docs/ folder.
export const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.md$/;
export const DOC_LIMITS = { files: 10, bytes: 2 * 1024 * 1024 };

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Where a source's parts are. Throws when it does not exist or its name is odd. */
export function resolveSource(source) {
  if (!source || !NAME_RE.test(source.id || '')) throw new Error('bad bundle name');
  if (source.kind === 'folder') {
    if (!PROJECTS_DIR) throw new Error('No projects folder is configured (CONSOLE_PROJECTS_DIR)');
    const base = path.join(PROJECTS_DIR, source.id);
    if (!isDir(path.join(base, 'team'))) throw new Error(`No team folder in ${source.id}`);
    return { kind: 'folder', id: source.id, team: path.join(base, 'team'), seed: isDir(path.join(base, 'seed')) ? path.join(base, 'seed') : null, files: isDir(path.join(base, 'files')) ? path.join(base, 'files') : null, flat: false };
  }
  if (source.kind === 'template') {
    const base = path.join(TEMPLATES_DIR, source.id);
    if (source.id.startsWith('_') || !isDir(base) || !fs.existsSync(path.join(base, 'template.json'))) throw new Error(`No team template named ${source.id}`);
    return { kind: 'template', id: source.id, team: base, seed: isDir(TEMPLATE_SEED) ? TEMPLATE_SEED : null, files: null, flat: false };
  }
  if (source.kind === 'example') {
    const base = path.join(EXAMPLES_DIR, source.id);
    if (!isDir(base)) throw new Error(`No example named ${source.id}`);
    return { kind: 'example', id: source.id, team: base, seed: isDir(path.join(base, 'seed')) ? path.join(base, 'seed') : null, files: isDir(path.join(base, 'files')) ? path.join(base, 'files') : null, flat: true };
  }
  throw new Error('bad bundle kind');
}

function names(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** A template's name and one line on how its team works (template.json), or null. */
function templateInfo(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, id, 'template.json'), 'utf8'));
    const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
    return { name: clean(j.name, 40) || id, about: clean(j.about, 300) };
  } catch {
    return null;
  }
}

/**
 * What a new project can start from: the team templates, and prepared team
 * folders under the projects folder that are not registered projects (a
 * registered project's folder is its running team, not a template).
 * `registered`: ids of the projects that exist.
 */
export function listSources(registered = []) {
  const out = [];
  for (const n of names(TEMPLATES_DIR)) {
    if (!NAME_RE.test(n) || n.startsWith('_') || !fs.existsSync(path.join(TEMPLATES_DIR, n, 'CHARTER.md'))) continue;
    const info = templateInfo(n);
    if (info) out.push({ kind: 'template', id: n, name: info.name, about: info.about, agents: readAgents(path.join(TEMPLATES_DIR, n)).map((a) => a.id), seed: true, files: false });
  }
  // Standard first, then the rest by name.
  out.sort((a, b) => (a.id === 'standard' ? -1 : b.id === 'standard' ? 1 : a.name.localeCompare(b.name)));
  if (PROJECTS_DIR) {
    for (const n of names(PROJECTS_DIR)) {
      if (registered.includes(n)) continue;
      if (NAME_RE.test(n) && fs.existsSync(path.join(PROJECTS_DIR, n, 'team', 'CHARTER.md'))) {
        out.push({ kind: 'folder', id: n, name: n, seed: isDir(path.join(PROJECTS_DIR, n, 'seed')), files: isDir(path.join(PROJECTS_DIR, n, 'files')) });
      }
    }
  }
  return out;
}

/** Total size of a tree; reports links and odd names instead of following them. */
function measure(dir, problems, label, { skip = [], names: checkNames = true } = {}) {
  let bytes = 0;
  let entries = 0;
  const walk = (d, rel) => {
    for (const n of names(d)) {
      if (!rel && skip.includes(n)) continue;
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (++entries > LIMITS.entries) return;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) problems.push(`${label}/${r}: is a link; links are not copied`);
      else if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) {
        bytes += st.size;
        if (checkNames && !FILE_RE.test(n)) problems.push(`${label}/${r}: file name has characters that are not allowed`);
      } else problems.push(`${label}/${r}: is not a plain file`);
    }
  };
  walk(dir, '');
  if (entries > LIMITS.entries) problems.push(`${label}: too many files`);
  return bytes;
}

/** Plain KEY=value lines. Anything else is reported, never run. */
export function parseEnv(text, label, problems) {
  const out = [];
  String(text || '')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const m = ENV_LINE_RE.exec(line);
      if (!m) problems.push(`${label} line ${i + 1}: must be KEY=value with no spaces, quotes or shell characters`);
      else out.push([m[1], m[2]]);
    });
  return out;
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** The agents in a team folder: id, model and description from each file's header. */
export function readAgents(teamDir) {
  const out = [];
  for (const f of names(path.join(teamDir, 'agents'))) {
    if (!f.endsWith('.md')) continue;
    const fm = frontmatter(read(path.join(teamDir, 'agents', f)) || '');
    if (fm) out.push({ id: f.slice(0, -3), model: fm.model || '', description: (fm.description || '').slice(0, 300) });
  }
  return out;
}

/**
 * Look at a bundle without changing anything. Returns what the wizard shows:
 * problems (block a deploy), warnings, the team, the charter, the provisioning
 * script's text, and the settings found in its env files.
 */
export function checkBundle(source) {
  const problems = [];
  const warnings = [];
  let src;
  try {
    src = resolveSource(source);
  } catch (e) {
    return { ok: false, problems: [e.message], warnings, agents: [], charter: '', provision: null, env: {}, extras: [], agentEnv: [], domains: [], seed: false, files: false, sizes: {} };
  }
  const skip = src.flat ? ['seed', 'files'] : [];
  const sizes = { team: measure(src.team, problems, 'team', { skip }) };
  if (sizes.team > LIMITS.teamBytes) problems.push(`team: larger than ${LIMITS.teamBytes / 1048576} MB`);
  if (src.seed) {
    sizes.seed = measure(src.seed, problems, 'seed', { names: false });
    if (sizes.seed > LIMITS.seedBytes) problems.push(`seed: larger than ${LIMITS.seedBytes / 1048576} MB`);
  }
  if (src.files) {
    sizes.files = measure(src.files, problems, 'files', { names: false });
    if (sizes.files > LIMITS.filesBytes) problems.push(`files: larger than ${LIMITS.filesBytes / 1073741824} GB`);
  }

  for (const f of REQUIRED) if (!fs.existsSync(path.join(src.team, f))) problems.push(`team/${f}: is missing`);
  for (const n of names(src.team)) {
    if (skip.includes(n)) continue;
    const dir = isDir(path.join(src.team, n));
    if (src.kind === 'template' && n === 'template.json') continue;
    if (dir ? !TEAM_DIRS.includes(n) : !TEAM_FILES.includes(n)) warnings.push(`team/${n}: not part of a bundle; it is left out`);
  }
  const gate = read(path.join(src.team, 'gate-checks'));
  if (gate != null && !gate.startsWith('#!')) problems.push('team/gate-checks: must start with a #! line');

  const agents = [];
  for (const f of names(path.join(src.team, 'agents'))) {
    if (!f.endsWith('.md')) {
      warnings.push(`team/agents/${f}: not an agent file; it is left out`);
      continue;
    }
    const id = f.slice(0, -3);
    const fm = frontmatter(read(path.join(src.team, 'agents', f)) || '');
    if (!AGENT_RE.test(id)) problems.push(`team/agents/${f}: the name must be lowercase letters, digits and hyphens`);
    else if (!fm) problems.push(`team/agents/${f}: has no header block (--- name, description, model ---)`);
    else if (fm.name !== id) problems.push(`team/agents/${f}: the header says name "${fm.name || ''}", the file is called ${id}`);
    else agents.push({ id, model: fm.model || '', description: (fm.description || '').slice(0, 300) });
  }
  const has = (id) => agents.some((a) => a.id === id);
  if (!has('builder')) problems.push('team/agents: no builder');
  if (!has('scout')) problems.push('team/agents: no scout');
  if (!agents.some((a) => a.id.startsWith('area-lead-'))) problems.push('team/agents: no area-lead-*');

  const envList = parseEnv(read(path.join(src.team, 'project.env')), 'team/project.env', problems);
  const env = Object.fromEntries(envList);
  const extras = envList.filter(([k]) => !RESERVED_ENV.includes(k));
  const agentEnv = parseEnv(read(path.join(src.team, 'agent.env.extra')), 'team/agent.env.extra', problems);

  const domains = [];
  for (const raw of (read(path.join(src.team, 'requires-domains')) || '').split('\n')) {
    const d = raw.split('#')[0].trim().toLowerCase();
    if (!d) continue;
    if (DOMAIN_RE.test(d)) domains.push(d);
    else problems.push(`team/requires-domains: "${d.slice(0, 60)}" is not a domain name`);
  }

  const provision = read(path.join(src.team, 'provision.sh'));
  if (provision != null && !provision.startsWith('#!')) problems.push('team/provision.sh: must start with a #! line');
  if (src.files && provision == null) warnings.push('files/: there is no provision.sh to use them');
  if (!src.seed) warnings.push('No seed folder: the project starts from an almost empty repository, and the gate may not pass on it.');

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    agents,
    charter: read(path.join(src.team, 'CHARTER.md')) || '',
    provision: provision == null ? null : provision.slice(0, 20000),
    env,
    extras,
    agentEnv,
    domains,
    seed: !!src.seed,
    files: !!src.files,
    sizes,
    // A template's charter has a {{goal}} slot: the owner's goal goes there.
    needsGoal: /\{\{\s*goal\s*\}\}/.test(read(path.join(src.team, 'CHARTER.md')) || '')
  };
}

/** The project.env the console writes for a new project. Values are checked again here. */
export function projectEnv({ id, leadModel, fallbackModel, budgetUsd, cyclesPerDay, proxyUrl, extras = [] }) {
  const lines = [
    ['PROJECT', id],
    ['WORKSPACE', `/home/agent/${id}`],
    ['BARE', `/srv/${id}.git`],
    ['STATE', '/var/lib/agent-kit'],
    ['LEAD_MODEL', leadModel],
    ['FALLBACK_MODEL', fallbackModel],
    ['CYCLE_BUDGET_USD', String(budgetUsd)],
    ['MAX_CYCLES_PER_DAY', String(cyclesPerDay)],
    ['AGENT_PROXY_URL', proxyUrl],
    ...extras.filter(([k]) => !RESERVED_ENV.includes(k))
  ].map(([k, v]) => `${k}=${v}`);
  for (const l of lines) if (!ENV_LINE_RE.test(l)) throw new Error(`project.env: "${l.slice(0, 80)}" is not a plain KEY=value line`);
  return ['# /etc/agent-kit/project.env  (root-owned; sourced by kit scripts). Written by the Ziggurat Console.', ...lines, ''].join('\n');
}

function copyTree(from, to, skip = []) {
  fs.mkdirSync(to, { recursive: true });
  for (const n of names(from)) {
    if (skip.includes(n)) continue;
    const a = path.join(from, n);
    const st = fs.lstatSync(a);
    if (st.isDirectory()) copyTree(a, path.join(to, n));
    else if (st.isFile()) {
      fs.copyFileSync(a, path.join(to, n));
      fs.chmodSync(path.join(to, n), st.mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function render(src, theme, out, goalFile = null) {
  const args = [path.join(REPO_DIR, 'tools', 'render-team.py'), src, '--theme', theme, '--out', out, ...(goalFile ? ['--goal-file', goalFile] : [])];
  return new Promise((resolve, reject) => {
    execFile('python3', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Could not render the team for theme ${theme}: ${(stderr || err.message).trim().slice(-300)}`));
      else resolve();
    });
  });
}

/** The smallest repository a team can start from, when the project has no seed folder. */
function minimalSeed(dir, { name, description }) {
  fs.mkdirSync(dir, { recursive: true });
  const clean = (s) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim();
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${clean(name) || 'New project'}\n\n${clean(description)}\n`);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Project notes\n\nA fresh repository. The team's goal is in /opt/agent-kit/CHARTER.md.\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.venv/\n__pycache__/\n');
}

const oneLine = (v) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim();

/** The owner's documents, checked again here: names, count and size. */
export function checkDocs(docs) {
  const list = Array.isArray(docs) ? docs : [];
  if (list.length > DOC_LIMITS.files) throw new Error(`At most ${DOC_LIMITS.files} documents`);
  let bytes = 0;
  const seen = new Set();
  for (const d of list) {
    if (!d || !DOC_NAME_RE.test(d.name || '') || typeof d.text !== 'string' || /\u0000/.test(d.text)) throw new Error('A document must be a .md name and text');
    if (seen.has(d.name.toLowerCase())) throw new Error(`Two documents are called ${d.name}`);
    seen.add(d.name.toLowerCase());
    bytes += Buffer.byteLength(d.text);
  }
  if (bytes > DOC_LIMITS.bytes) throw new Error(`The documents are larger than ${DOC_LIMITS.bytes / 1048576} MB together`);
  return list;
}

/** A template project's README: its name, the owner's goal, where the plan is. */
function templateReadme({ name, goal, docs }) {
  const list = docs.length ? docs.map((d) => `- [docs/${d.name}](docs/${d.name})`).join('\n') : '- (none yet)';
  return `# ${oneLine(name) || 'New project'}\n\n${String(goal || '').trim()}\n\n## Plan and design\n\n${list}\n\n## Checks\n\n\`\`\`bash\nbash tools/check /tmp/check-out\n\`\`\`\n\nThe gate runs the same script on every submitted branch.\n`;
}

/**
 * Pack what goes into the new VM into `<dir>/payload.tar.gz`: the kit from
 * this repository, the staged team (`<dir>/bundle`) and the seed. Returns the
 * archive path and the project's extra files folder, if it has one.
 * `about`: name, description, and for a new project the owner's goal and
 * documents (docs/ in the seed; a template's seed also gets a README).
 */
export async function buildPayload(dir, source, about = {}) {
  const src = resolveSource(source);
  const pay = path.join(dir, 'payload');
  const archive = path.join(dir, 'payload.tar.gz');
  // Rebuilt from scratch each time; both belong to this deploy.
  fs.rmSync(pay, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  copyTree(path.join(REPO_DIR, 'kit', 'vm'), path.join(pay, 'kit'), ['tests']);
  copyTree(path.join(dir, 'bundle'), path.join(pay, 'bundle'));
  if (src.seed) copyTree(src.seed, path.join(pay, 'seed'), ['.git']);
  else minimalSeed(path.join(pay, 'seed'), about);
  if (!names(path.join(pay, 'seed')).length) minimalSeed(path.join(pay, 'seed'), about);
  const docs = checkDocs(about.docs);
  if (docs.length) {
    fs.mkdirSync(path.join(pay, 'seed', 'docs'), { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(pay, 'seed', 'docs', d.name), d.text.endsWith('\n') ? d.text : d.text + '\n');
  }
  if (src.kind === 'template') fs.writeFileSync(path.join(pay, 'seed', 'README.md'), templateReadme({ name: about.name, goal: about.goal, docs }));
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', archive, '--owner=0', '--group=0', '-C', pay, 'kit', 'bundle', 'seed'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d) => (err += d));
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not pack the payload: ${err.trim().slice(-300)}`))));
  });
  fs.rmSync(pay, { recursive: true, force: true });
  return { archive, files: src.files };
}

/**
 * Copy the bundle's team files into `dir` (a folder the console owns), apply
 * the charter text and the generated project.env, and render the role names
 * for the theme. Returns the rendered folder and the rendered charter.
 */
export async function stageBundle(dir, source, { theme, charter, env, goal = null }) {
  if (!listThemes().includes(theme)) throw new Error(`No theme named ${theme}`);
  const src = resolveSource(source);
  const raw = path.join(dir, 'bundle-src');
  const out = path.join(dir, 'bundle');
  // Both folders belong to this deploy and are rebuilt from scratch each time.
  fs.rmSync(raw, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(raw, { recursive: true });
  for (const n of names(src.team)) {
    const a = path.join(src.team, n);
    const st = fs.lstatSync(a);
    if (st.isFile() && TEAM_FILES.includes(n)) {
      fs.copyFileSync(a, path.join(raw, n));
      fs.chmodSync(path.join(raw, n), st.mode & 0o111 || n === 'gate-checks' || n === 'provision.sh' ? 0o755 : 0o644);
    } else if (st.isDirectory() && TEAM_DIRS.includes(n)) copyTree(a, path.join(raw, n));
  }
  if (charter) fs.writeFileSync(path.join(raw, 'CHARTER.md'), charter.endsWith('\n') ? charter : charter + '\n');
  fs.writeFileSync(path.join(raw, 'project.env'), env);
  // The owner's goal fills a template charter's {{goal}} slot, inserted as written.
  let goalFile = null;
  if (goal != null && String(goal).trim()) {
    goalFile = path.join(dir, 'goal.txt');
    fs.writeFileSync(goalFile, String(goal).trim() + '\n');
  }
  await render(raw, theme, out, goalFile);
  return { dir: out, charter: read(path.join(out, 'CHARTER.md')) || '', agents: readAgents(out) };
}
