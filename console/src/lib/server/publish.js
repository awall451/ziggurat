// Publishing a project's gate-approved main to a remote git repository.
//
// A sandbox VM holds no key and cannot reach a forge. The console does the
// publishing, from outside:
//   1. the lead asks (a note in its publish-out folder, pulled like the outbox)
//   2. the console waits until the cycle is over and the gate has judged it
//   3. it fetches main as a git bundle through one fixed kit script
//   4. it checks what is new: fast-forward only, no secrets, no CI files
//   5. it pushes main with a key that only this console holds, one per project
//
// The remote is a one-way mirror with the same commits. Nothing is ever
// fetched from it into a VM, and nothing is ever force-pushed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, rawProjects, saveProject } from './config.js';
import { kit, kitToFile, pull } from './ssh.js';
import { audit } from './audit.js';
import { getStatus, peekStatus, kitAtLeast } from './live.js';
import { readToken } from './token.js';
import { maskSecrets } from './mask.js';

export const PUBLISH_KIT = '0.8.0';
// ssh addresses only: git@host:owner/repo.git or ssh://[user@]host[:port]/path.
// The same pattern as agent-kit-publish on the VM.
// Characters are limited to what a kit script argument may hold (ssh.js ARG_RE).
const SCP_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9._][A-Za-z0-9._/-]*)$/;
const URL_RE = /^ssh:\/\/(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::([0-9]{1,5}))?\/([A-Za-z0-9._][A-Za-z0-9._/-]*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const KEYLINE_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]{40,1100}={0,3}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9@%+=:,._/-]+$/;
// Files that make a forge run code. An agent must not be able to add one.
const CI_PATHS = [
  /^\.github\/workflows\//,
  /^\.gitea\/workflows\//,
  /^\.forgejo\/workflows\//,
  /^\.gitlab-ci\.yml$/,
  /^azure-pipelines\.ya?ml$/,
  /^\.azure-pipelines\//,
  /^\.circleci\//
];
const gitleaksBin = () => process.env.GITLEAKS_BIN || 'gitleaks';
const MAX_BUNDLE = 2 * 1024 ** 3;
const CHECK_EVERY = 60_000; // how often a waiting request looks at the VM
const RETRY_BLOCKED = 15 * 60_000;

let localRemotes = false; // tests publish to a folder on disk

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** {host, port, form} for a remote address, or null when it is not one we accept. */
export function parseRemote(remote) {
  if (typeof remote !== 'string' || remote.length > 200) return null;
  if (localRemotes && path.isAbsolute(remote) && SAFE_PATH_RE.test(remote)) return { host: 'local', port: 22, local: true };
  let m = SCP_RE.exec(remote);
  if (m) return { host: m[2], port: 22 };
  m = URL_RE.exec(remote);
  if (m) {
    const port = m[3] ? Number(m[3]) : 22;
    return port >= 1 && port <= 65535 ? { host: m[2], port } : null;
  }
  return null;
}

const dir = (id) => path.join(DATA_DIR, 'publish', id);
const file = (id, name) => path.join(dir(id), name);
const mirror = (id) => file(id, 'mirror.git');

function readState(id) {
  try {
    const s = JSON.parse(fs.readFileSync(file(id, 'state.json'), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function writeState(id, patch) {
  const next = { ...readState(id), ...patch };
  fs.mkdirSync(dir(id), { recursive: true, mode: 0o700 });
  const tmp = file(id, `state.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file(id, 'state.json'));
  return next;
}

function addHistory(id, row) {
  fs.mkdirSync(dir(id), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file(id, 'history.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });
}

export function history(project, limit = 50) {
  let text = '';
  try {
    text = fs.readFileSync(file(project.id, 'history.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip a bad line */
    }
  }
  return rows.slice(-limit).reverse();
}

function run(cmd, argv, { env, input, timeout = 60000, maxBytes = 4 * 1024 * 1024, onData } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => {
      if (onData) onData(d);
      else if (stdout.length < maxBytes) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 65536) stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e), missing: e.code === 'ENOENT' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\nkilled: ${signal}` : stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const tail = (res, n = 300) => maskSecrets((res.stderr || res.stdout || `exit ${res.code}`).trim().split('\n').slice(-3).join(' · ').slice(-n));

// ---- the project's own key and the forge's host key ------------------------

/** The public half of the project's deploy key, making the key first if there is none. */
export async function ensureKey(project) {
  const key = file(project.id, 'key');
  if (!SAFE_PATH_RE.test(key)) throw fail(500, 'The console data folder has a space or special character in its path');
  fs.mkdirSync(dir(project.id), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(key)) {
    const res = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `ziggurat-${project.id}`, '-f', key]);
    if (res.code !== 0) throw fail(500, `Could not make a key: ${tail(res)}`);
    fs.chmodSync(key, 0o600);
  }
  return publicKey(project);
}

/** "<type> <key> <comment>", or null. Only this half ever leaves the server. */
export function publicKey(project) {
  try {
    const line = fs.readFileSync(file(project.id, 'key.pub'), 'utf8').trim().split('\n')[0];
    return KEYLINE_RE.test(line.split(' ').slice(0, 2).join(' ')) ? line : null;
  } catch {
    return null;
  }
}

const hostPattern = ({ host, port }) => (port === 22 ? host : `[${host}]:${port}`);

async function fingerprintOf(id, keyLine) {
  const tmp = file(id, `hostkey.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `host ${keyLine}\n`, { mode: 0o600 });
  try {
    const res = await run('ssh-keygen', ['-l', '-f', tmp]);
    const fp = res.stdout.trim().split(/\s+/)[1] || '';
    return res.code === 0 && FP_RE.test(fp) ? fp : null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Ask the forge for its host key. Nothing is trusted here: the owner confirms the fingerprint. */
async function scanHostKey(id, where) {
  const res = await run('ssh-keyscan', ['-T', '10', '-t', 'ed25519,ecdsa,rsa', '-p', String(where.port), where.host], { timeout: 20000 });
  const lines = res.stdout
    .split('\n')
    .map((l) => l.trim().split(' ').slice(1, 3).join(' '))
    .filter((l) => KEYLINE_RE.test(l));
  const keyLine = lines.find((l) => l.startsWith('ssh-ed25519 ')) || lines[0];
  if (!keyLine) throw fail(502, `Could not read the host key of ${where.host}: ${tail(res) || 'no answer'}`);
  const fingerprint = await fingerprintOf(id, keyLine);
  if (!fingerprint) throw fail(502, 'Could not read the host key fingerprint');
  return { keyLine, fingerprint, type: keyLine.split(' ')[0] };
}

function writeKnownHosts(id, where, keyLine) {
  fs.writeFileSync(file(id, 'known_hosts'), `${hostPattern(where)} ${keyLine}\n`, { mode: 0o600 });
}

/** Environment for a git command. `remote`: the command talks to the forge. */
function gitEnv(id, remote = false) {
  const env = {
    PATH: process.env.PATH,
    HOME: dir(id),
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0'
  };
  if (remote) {
    // Only this project's key, only the pinned host key, and no ssh config of the console's.
    env.GIT_SSH_VARIANT = 'ssh';
    env.GIT_SSH_COMMAND = [
      'ssh', '-F', '/dev/null', '-i', file(id, 'key'),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${file(id, 'known_hosts')}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=15'
    ].join(' ');
  }
  return env;
}

const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=user', '-c', 'gc.auto=0'];

function git(id, argv, { remote = false, ...opts } = {}) {
  return run('git', [...GIT_SAFE, '-C', mirror(id), ...argv], { env: gitEnv(id, remote), ...opts });
}

async function ensureMirror(id) {
  if (fs.existsSync(path.join(mirror(id), 'HEAD'))) return;
  fs.mkdirSync(dir(id), { recursive: true, mode: 0o700 });
  const res = await run('git', ['init', '-q', '--bare', mirror(id)], { env: gitEnv(id) });
  if (res.code !== 0) throw fail(500, `Could not create the local mirror: ${tail(res)}`);
}

const hasCommit = async (id, sha) => SHA_RE.test(sha || '') && (await git(id, ['cat-file', '-e', `${sha}^{commit}`])).code === 0;

/** The remote's main, '' when it has none yet. Throws when the remote cannot be read. */
async function remoteMain(project) {
  const res = await git(project.id, ['ls-remote', project.publish.remote, 'refs/heads/main'], { remote: true, timeout: 45000 });
  if (res.code !== 0) throw fail(502, `Could not read the remote: ${tail(res)}`);
  const sha = res.stdout.trim().split(/\s+/)[0] || '';
  return SHA_RE.test(sha) ? sha : '';
}

// ---- setup: remote address, key, verify ------------------------------------

/** Set or clear (empty string) the remote address of a project. */
export async function setRemote(user, project, remote) {
  const value = String(remote ?? '').trim();
  if (value && !parseRemote(value)) throw fail(400, 'The remote must be an ssh address: git@host:owner/repo.git or ssh://host/path');
  const entry = rawProjects().find((e) => e.id === project.id);
  if (!entry) throw fail(404, 'No such project');
  const next = { ...entry };
  if (value) next.publish = { remote: value };
  else delete next.publish;
  saveProject(next, { replace: true });
  // A new address has to be verified again before anything is pushed to it.
  writeState(project.id, { verified: null, blocked: null, attemptAt: 0 });
  audit(user, project.id, value ? 'publish-remote' : 'publish-off', { remote: value || null });
  if (!value) {
    const status = peekStatus(project.id);
    if (status?.reachable && kitAtLeast(status.kitVersion, PUBLISH_KIT)) await kit(project, 'agent-kit-publish', ['disable']);
    return { remote: null };
  }
  return { remote: value, publicKey: await ensureKey(project) };
}

/**
 * Check that publishing can work: the forge's host key (confirmed by the owner
 * once, by its fingerprint), read access, and write access (a dry run).
 * Returns {ok:false, need:'hostkey', fingerprint} until the fingerprint is confirmed.
 */
export async function verify(user, project, { fingerprint = null } = {}) {
  const remote = project.publish?.remote;
  const where = parseRemote(remote);
  if (!where) throw fail(400, 'Set the remote address first');
  await ensureKey(project);
  await ensureMirror(project.id);
  let state = readState(project.id);

  if (!where.local) {
    const pinned = state.hostKey && state.hostKey.host === where.host && state.hostKey.port === where.port ? state.hostKey : null;
    if (!pinned) {
      const scan = await scanHostKey(project.id, where);
      if (!fingerprint) return { ok: false, need: 'hostkey', host: where.host, fingerprint: scan.fingerprint, type: scan.type };
      if (!FP_RE.test(fingerprint) || fingerprint !== scan.fingerprint) throw fail(409, 'The host key changed between the two checks. Look again before confirming.');
      state = writeState(project.id, { hostKey: { host: where.host, port: where.port, line: scan.keyLine, fingerprint: scan.fingerprint, at: new Date().toISOString() } });
      audit(user, project.id, 'publish-hostkey', { host: where.host, fingerprint: scan.fingerprint });
    }
    writeKnownHosts(project.id, where, state.hostKey.line);
  }

  const checks = [];
  let main = '';
  try {
    main = await remoteMain(project);
    checks.push({ name: 'read', ok: true, detail: main ? `remote main is ${main.slice(0, 9)}` : 'the remote has no main yet' });
  } catch (e) {
    checks.push({ name: 'read', ok: false, detail: e.message });
  }
  if (checks[0].ok) {
    // Deleting a branch that does not exist, as a dry run: nothing changes on
    // the remote, but a key without write access is refused here.
    const res = await git(project.id, ['push', '--dry-run', remote, ':refs/heads/ziggurat-write-check'], { remote: true, timeout: 45000 });
    const ok = res.code === 0 || /remote ref does not exist/.test(res.stderr);
    checks.push({ name: 'write', ok, detail: ok ? 'the key may push' : tail(res) });
  }
  const ok = checks.every((c) => c.ok);
  let note = null;
  if (ok) {
    writeState(project.id, { verified: { remote, at: new Date().toISOString() } });
    const status = await getStatus(project);
    if (status.reachable && kitAtLeast(status.kitVersion, PUBLISH_KIT)) {
      const res = await kit(project, 'agent-kit-publish', ['enable', remote]);
      if (res.code !== 0) note = `The VM did not take the setting: ${tail(res)}`;
    } else if (!status.reachable) note = 'The VM did not answer, so its lead has not been told yet. Verify again when it is reachable.';
    else note = `The VM runs a kit older than ${PUBLISH_KIT}. Upgrade it, then verify again: publishing needs it.`;
  }
  audit(user, project.id, 'publish-verify', { remote }, { ok, detail: checks.map((c) => `${c.name}: ${c.ok ? 'ok' : c.detail}`).join('; ') });
  return { ok, checks, note, fingerprint: readState(project.id).hostKey?.fingerprint || null };
}

// ---- the lead's request -----------------------------------------------------

/** Copy the lead's request note from the VM (agent-written: read as the agent, parsed as data). */
export async function syncRequest(project) {
  if (!project.publish?.remote) return;
  const dest = file(project.id, 'out');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  await pull(project, [`${project.kit.state}/publish-out/`], dest, { as: 'agent', maxSize: '64k', timeout: 60000, filters: ['--exclude=.*', '--include=request.md', '--exclude=*'] });
}

/** {publish: 'yes'|'no', date, summary} from the pulled note, or null. */
export function readRequest(project) {
  const f = file(project.id, path.join('out', 'request.md'));
  let text;
  try {
    if (!fs.lstatSync(f).isFile()) return null;
    text = fs.readFileSync(f, 'utf8').slice(0, 8000);
  } catch {
    return null;
  }
  const i = text.indexOf('\n---\n');
  if (i < 0) return null;
  const fields = {};
  for (const line of text.slice(0, i).split('\n')) {
    const j = line.indexOf(': ');
    if (j > 0) fields[line.slice(0, j).toLowerCase()] = line.slice(j + 2).trim();
  }
  if (!/^(yes|no)$/.test(fields.publish || '') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fields.date || '')) return null;
  return { publish: fields.publish, date: fields.date, summary: text.slice(i + 5).trim().slice(0, 4000) };
}

// ---- checks on what is new --------------------------------------------------

async function ciFiles(id, base, sha) {
  const res = base
    ? await git(id, ['diff', '--name-only', '--no-renames', '-z', base, sha], { maxBytes: 32 * 1024 * 1024 })
    : await git(id, ['ls-tree', '-r', '--name-only', '-z', sha], { maxBytes: 32 * 1024 * 1024 });
  if (res.code !== 0) throw new Error(`could not list the changed files: ${tail(res)}`);
  return res.stdout.split('\0').filter((f) => f && CI_PATHS.some((re) => re.test(f)));
}

/** Does the owner's Claude token appear anywhere in the new commits? The token is never put on a command line. */
async function tokenInCommits(id, range) {
  const token = readToken();
  if (!token) return false;
  const needle = Buffer.from(token);
  let carry = Buffer.alloc(0);
  let found = false;
  const res = await run('git', [...GIT_SAFE, '-C', mirror(id), 'log', '-p', '--no-color', '--no-textconv', '--format=%H', ...range], {
    env: gitEnv(id),
    timeout: 10 * 60_000,
    onData: (d) => {
      if (found) return;
      const buf = Buffer.concat([carry, d]);
      if (buf.includes(needle)) found = true;
      carry = buf.subarray(Math.max(0, buf.length - needle.length));
    }
  });
  if (res.code !== 0) throw new Error(`could not read the new commits: ${tail(res)}`);
  return found;
}

// Scanner rules that only guess: a name like "key" or "token" next to a string
// that looks random. They fire on test data (key: 'Shift+Ctrl+F24') and cannot
// be cleared, because the commit stays in what would be pushed. The agents hold
// no credential but the Claude token, which is looked for by its exact value,
// so a finding of these rules is shown to the owner and does not refuse a publish.
const WARN_RULES = new Set(['generic-api-key']);

/**
 * Findings of the secret scanner in the new commits, as plain sentences (never
 * the secret itself): {block: [...], warn: [...]}. `block` refuses the publish.
 */
async function secretFindings(id, range) {
  const report = file(id, `scan.${process.pid}.json`);
  fs.rmSync(report, { force: true });
  try {
    const res = await run(
      gitleaksBin(),
      // --ignore-gitleaks-allow: a "gitleaks:allow" comment in the code must not silence a finding.
      ['git', '--no-banner', '--redact', '--ignore-gitleaks-allow', '--exit-code', '9', '--report-format', 'json', '--report-path', report, `--log-opts=${range.join(' ')}`, mirror(id)],
      { env: gitEnv(id), timeout: 15 * 60_000 }
    );
    if (res.missing) throw new Error('the secret scanner (gitleaks) is not installed on the console');
    if (res.code === 0) return { block: [], warn: [] };
    if (res.code !== 9) throw new Error(`the secret scan did not finish: ${tail(res)}`);
    let found = [];
    try {
      found = JSON.parse(fs.readFileSync(report, 'utf8'));
    } catch {
      /* the exit code already says there are findings */
    }
    const plain = (v, n) => String(v ?? '').replace(/[^A-Za-z0-9 ._/@+=-]/g, ' ').slice(0, n);
    const line = (x) => `rule ${plain(x?.RuleID, 60)} in ${plain(x?.File, 120)}, commit ${plain(x?.Commit, 9)}`;
    const all = Array.isArray(found) ? found : [];
    // A report that cannot be read refuses: the exit code says there is a finding, not which.
    if (!all.length) return { block: ['the scanner reported a finding'], warn: [] };
    const guess = (x) => WARN_RULES.has(String(x?.RuleID ?? ''));
    const short = (rows, n) => [...new Set(rows.map(line))].slice(0, n);
    return { block: short(all.filter((x) => !guess(x)), 5), warn: short(all.filter(guess), 20) };
  } finally {
    fs.rmSync(report, { force: true });
  }
}

// ---- publish ----------------------------------------------------------------

const running = new Map(); // id -> promise

/**
 * Fetch main from the VM, check it, push it. One at a time per project.
 * Returns {ok, outcome: 'published'|'nothing'|'waiting'|'blocked', detail, sha}.
 */
export function publish(user, project, { manual = false } = {}) {
  if (running.has(project.id)) return running.get(project.id);
  const p = doPublish(user, project, manual)
    .catch((e) => {
      // Not set up, not verified: the caller's mistake, not a refused publish.
      if (e?.status) throw e;
      return { ok: false, outcome: 'blocked', detail: maskSecrets(String(e.message || e)).slice(0, 400), error: true };
    })
    .then(async (out) => {
      if (out.outcome === 'blocked') await recordBlocked(user, project, out, manual);
      return out;
    })
    .finally(() => running.delete(project.id));
  running.set(project.id, p);
  return p;
}

async function recordBlocked(user, project, out, manual) {
  const request = readRequest(project);
  writeState(project.id, { blocked: { at: new Date().toISOString(), sha: out.sha || null, reason: out.detail, requestDate: request?.date || null } });
  addHistory(project.id, { outcome: 'blocked', sha: out.sha || null, detail: out.detail, by: manual ? user?.name || 'owner' : 'request' });
  audit(user, project.id, 'publish', { manual }, { ok: false, detail: out.detail });
  // Tell the lead why, so the team can fix it. Best effort. Not for a failure on
  // the console's side (the VM did not answer, no scanner): the team cannot fix those.
  if (!out.error) await kit(project, 'agent-kit-publish', ['blocked'], { input: out.detail }).catch(() => {});
}

async function vmStatus(project) {
  const res = await kit(project, 'agent-kit-publish', ['status']);
  if (res.code !== 0) throw new Error(`the VM did not answer: ${tail(res)}`);
  try {
    return JSON.parse(res.stdout.trim().split('\n').at(-1));
  } catch {
    throw new Error('the VM gave no usable status');
  }
}

async function doPublish(user, project, manual) {
  const id = project.id;
  const remote = project.publish?.remote;
  const where = parseRemote(remote);
  if (!where) throw fail(400, 'No remote is set for this project');
  let state = readState(id);
  if (state.verified?.remote !== remote) throw fail(409, 'The remote has not been verified yet');
  if (!where.local) writeKnownHosts(id, where, state.hostKey.line);
  await ensureMirror(id);

  const vm = await vmStatus(project);
  if (!SHA_RE.test(vm.main || '')) throw new Error('the VM has no main to publish');
  if (vm.gateBusy) return { ok: true, outcome: 'waiting', detail: 'The gate is in the middle of a pass.' };
  if (!manual) {
    if (vm.cycle) return { ok: true, outcome: 'waiting', detail: 'A cycle is running.' };
    if (vm.unjudged > 0 && !vm.stopped && !vm.gatePaused) return { ok: true, outcome: 'waiting', detail: `The gate has ${vm.unjudged} branch(es) left to judge.` };
  }

  // What the remote has decides what is new. It must be something we know.
  const have = await remoteMain(project);
  if (have === vm.main) {
    finishPublished(user, project, vm.main, 0, manual, true);
    await kit(project, 'agent-kit-publish', ['record', vm.main]);
    return { ok: true, outcome: 'nothing', detail: 'The remote already has this main.', sha: vm.main };
  }

  // Fetch main from the VM as a bundle: only what the mirror does not have.
  const since = (await hasCommit(id, state.publishedSha)) ? state.publishedSha : null;
  const bundle = file(id, 'incoming.bundle');
  try {
    const got = await kitToFile(project, 'agent-kit-publish', ['bundle', ...(since && since !== vm.main ? [since] : [])], bundle, { maxBytes: MAX_BUNDLE, timeout: 20 * 60_000 });
    if (got.code !== 0) throw new Error(`could not fetch main from the VM: ${maskSecrets((got.stderr || `exit ${got.code}`).trim().slice(-300))}`);
    const res = await git(id, ['-c', 'transfer.fsckObjects=true', 'fetch', '-q', '--no-tags', bundle, '+refs/heads/main:refs/incoming/main'], { timeout: 20 * 60_000 });
    if (res.code !== 0) throw new Error(`the bundle from the VM was not accepted: ${tail(res)}`);
  } finally {
    fs.rmSync(bundle, { force: true });
  }
  const sha = (await git(id, ['rev-parse', '--verify', 'refs/incoming/main^{commit}'])).stdout.trim();
  if (!SHA_RE.test(sha)) throw new Error('the bundle from the VM holds no main');
  const blocked = (detail) => ({ ok: false, outcome: 'blocked', detail, sha });

  // Fast-forward only: what the remote has must be part of what we are about to push.
  if (have) {
    if (!(await hasCommit(id, have))) return blocked(`The remote's main (${have.slice(0, 9)}) is not a commit of this project. Someone else pushed there, or it is the wrong repository. Nothing was pushed.`);
    if ((await git(id, ['merge-base', '--is-ancestor', have, sha])).code !== 0) return blocked(`The remote's main (${have.slice(0, 9)}) is not an ancestor of the project's main (${sha.slice(0, 9)}). Publishing would rewrite history, so nothing was pushed.`);
  }
  const range = have ? [`${have}..${sha}`] : [sha];
  const count = Number((await git(id, ['rev-list', '--count', ...range])).stdout.trim()) || 0;

  const ci = await ciFiles(id, have || null, sha);
  if (ci.length) return blocked(`CI files changed, which the console does not publish: ${ci.slice(0, 5).join(', ')}${ci.length > 5 ? ` and ${ci.length - 5} more` : ''}.`);
  if (await tokenInCommits(id, range)) return blocked('The Claude sign-in token appears in the new commits. Nothing was pushed. Replace the token, and remove it from the history before publishing.');
  const leaks = await secretFindings(id, range);
  if (leaks.block.length) return blocked(`Possible secret in the new commits: ${leaks.block.join('; ')}.`);

  // No force, no tags, one ref.
  const push = await git(id, ['push', '--no-verify', remote, `${sha}:refs/heads/main`], { remote: true, timeout: 20 * 60_000 });
  if (push.code !== 0) return blocked(`The remote refused the push: ${tail(push)}`);
  await git(id, ['update-ref', 'refs/heads/main', sha]);
  await git(id, ['update-ref', '-d', 'refs/incoming/main']);
  finishPublished(user, project, sha, count, manual, false, leaks.warn);
  await kit(project, 'agent-kit-publish', ['record', sha]);
  const notes = leaks.warn.length ? ` The secret scan left ${leaks.warn.length} note(s), which did not hold it back.` : '';
  return { ok: true, outcome: 'published', detail: `Published ${count} commit(s); the remote's main is now ${sha.slice(0, 9)}.${notes}`, sha, commits: count, notes: leaks.warn };
}

function finishPublished(user, project, sha, commits, manual, already, notes = []) {
  const request = readRequest(project);
  const at = new Date().toISOString();
  // handledRequest: the request this publish answered, so the same note is not acted on twice.
  writeState(project.id, { publishedSha: sha, publishedAt: at, blocked: null, handledRequest: request?.date || null });
  if (already && readState(project.id).lastRecorded === sha) return;
  // What the scan's guessing rules pointed at in this publish, for the owner to look at.
  writeState(project.id, { lastRecorded: sha, notes: already ? readState(project.id).notes || [] : notes });
  addHistory(project.id, {
    outcome: already ? 'in-sync' : 'published',
    sha,
    commits,
    by: manual ? user?.name || 'owner' : 'request',
    summary: !manual && request?.publish === 'yes' ? request.summary : null,
    ...(notes.length ? { notes } : {})
  });
  audit(user, project.id, 'publish', { manual, sha: sha.slice(0, 9), commits, ...(notes.length ? { scanNotes: notes.length } : {}) }, { ok: true, detail: already ? 'already on the remote' : null });
}

// ---- the scheduler's hook ---------------------------------------------------

/**
 * Called on every scheduler tick. Does nothing, without touching the network,
 * unless the lead has asked for a publish that has not happened yet.
 */
export function maybePublish(project) {
  const remote = project.publish?.remote;
  if (!remote || running.has(project.id)) return null;
  const state = readState(project.id);
  if (state.verified?.remote !== remote) return null;
  const request = readRequest(project);
  if (!request || request.publish !== 'yes') return null;
  if (state.handledRequest === request.date) return null;
  const status = peekStatus(project.id);
  if (!status?.reachable || status.leadActive || !kitAtLeast(status.kitVersion, PUBLISH_KIT)) return null;
  // A refused publish is tried again only now and then: main may have changed.
  const wait = state.blocked && state.blocked.requestDate === request.date ? RETRY_BLOCKED : CHECK_EVERY;
  if (Date.now() - (state.attemptAt || 0) < wait) return null;
  writeState(project.id, { attemptAt: Date.now() });
  return publish({ name: 'console' }, project).catch(() => null);
}

/** What the pages show. Nothing here touches the network. */
export function publishView(project) {
  const remote = project.publish?.remote || null;
  if (!remote) return { remote: null };
  const state = readState(project.id);
  const request = readRequest(project);
  return {
    remote,
    publicKey: publicKey(project),
    fingerprint: state.hostKey?.fingerprint || null,
    verified: state.verified?.remote === remote ? state.verified.at : null,
    sha: state.publishedSha || null,
    at: state.publishedAt || null,
    blocked: state.blocked ? { at: state.blocked.at, reason: state.blocked.reason, sha: state.blocked.sha } : null,
    // Guess-rule findings of the secret scan in the last publish: shown, never a refusal.
    notes: Array.isArray(state.notes) ? state.notes.slice(0, 20) : [],
    request: request ? { publish: request.publish, date: request.date, summary: request.summary.slice(0, 600) } : null,
    busy: running.has(project.id)
  };
}

export const _test = {
  allowLocalRemotes: (on = true) => {
    localRemotes = on;
  },
  readState,
  CI_PATHS
};
