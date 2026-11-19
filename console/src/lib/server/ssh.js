// The console reaches a sandbox VM the same way the workstation tools do: ssh
// from outside, through the gateway. Nothing runs in the other direction.
//
// Two kinds of call:
//   readScript()  a read-only script built by the console (status, listings)
//   kit()         a fixed, root-owned kit script with validated arguments;
//                 every change on a VM goes through one of these
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const CONTROL = path.join(os.tmpdir(), 'zc-%C');
const MAX_PARALLEL = 4; // sessions per ssh master
const ARG_RE = /^[A-Za-z0-9@%+=:,._/-]{1,200}$/;
const SCRIPT_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** ssh options + destination for a project ({alias} or {host,user,jump,key}). */
export function sshArgs(project) {
  const s = project.ssh || {};
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${CONTROL}`,
    '-o', 'ControlPersist=120'
  ];
  if (s.key) args.push('-i', s.key, '-o', 'IdentitiesOnly=yes');
  if (s.jump) args.push('-J', s.jump);
  const dest = s.alias || (s.user ? `${s.user}@${s.host}` : s.host);
  if (!dest) throw new Error(`project ${project.id}: no ssh destination configured`);
  // A value that starts with "-" would be read by ssh as an option.
  if (/^-/.test(dest) || /^-/.test(s.jump || '') || /^-/.test(s.key || '')) throw new Error(`project ${project.id}: bad ssh settings`);
  return { args, dest };
}

// ---- hosts the console defines itself (a Proxmox host, a VM it created) ----
//
// These do not rely on the mounted ssh config. The console keeps its own
// known_hosts file, filled only with keys it was given (a target's host key)
// or read through Proxmox (a new VM's key): never trust-on-first-contact.

export const SSH_KEY = process.env.CONSOLE_SSH_KEY_FILE || '/run/console/ssh_key';
const OWN_KNOWN_HOSTS = path.join(DATA_DIR, 'ssh', 'known_hosts');
const HOME_KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');
const KEYLINE_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]{40,1100}={0,3}$/;
const KH_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Trust `keyLine` ("<type> <key>") for `host`, replacing anything stored for that host. */
export function setHostKey(host, keyLine) {
  if (!KH_HOST_RE.test(host || '')) throw new Error('bad host name for a host key');
  if (!KEYLINE_RE.test(keyLine || '')) throw new Error('bad host key');
  let lines = [];
  try {
    lines = fs.readFileSync(OWN_KNOWN_HOSTS, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const wanted = `${host} ${keyLine}`;
  if (lines.length === 1 + lines.filter((l) => l.split(' ')[0] !== host).length && lines.includes(wanted)) return;
  const next = [...lines.filter((l) => l.split(' ')[0] !== host), wanted];
  fs.mkdirSync(path.dirname(OWN_KNOWN_HOSTS), { recursive: true, mode: 0o700 });
  const tmp = `${OWN_KNOWN_HOSTS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, OWN_KNOWN_HOSTS);
}

function strictOpts() {
  for (const f of [OWN_KNOWN_HOSTS, HOME_KNOWN_HOSTS, SSH_KEY]) {
    if (/\s/.test(f)) throw new Error(`path with a space cannot be used for ssh: ${f}`);
  }
  return [
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=12',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${OWN_KNOWN_HOSTS} ${HOME_KNOWN_HOSTS}`,
    '-o', 'ForwardAgent=no',
    '-i', SSH_KEY
  ];
}

/**
 * ssh options + destination for {host, user, jump}. `jump` is [user@]host[:port].
 * The jump hop gets the same key and host key files through an explicit
 * ProxyCommand: `ssh -J` would not pass these options on to it.
 */
export function hostArgs({ host, user, jump }) {
  if (!KH_HOST_RE.test(host || '') || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user || '')) throw new Error('bad ssh host or user');
  const args = [
    ...strictOpts(),
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${CONTROL}`,
    '-o', 'ControlPersist=120'
  ];
  if (jump) {
    const m = /^(?:([a-z_][a-z0-9_-]{0,31})@)?([A-Za-z0-9][A-Za-z0-9.-]{0,252}?)(?::([0-9]{1,5}))?$/.exec(jump);
    if (!m) throw new Error('bad ssh jump host');
    const hop = ['ssh', ...strictOpts(), ...(m[3] ? ['-p', m[3]] : []), '-W', '%h:%p', m[1] ? `${m[1]}@${m[2]}` : m[2]];
    args.push('-o', `ProxyCommand=${hop.map((a) => (/^[A-Za-z0-9@%+=:,._/-]+$/.test(a) ? a : q(a))).join(' ')}`);
  }
  return { args, dest: `${user}@${host}` };
}

/**
 * The same strict options as one shell-quoted string, for an Ansible inventory
 * (`ansible_ssh_common_args`). Ansible adds the key and the destination itself.
 */
export function ansibleSshArgs({ jump } = {}) {
  const { args } = hostArgs({ host: 'placeholder', user: 'root', jump });
  const keep = [];
  for (let i = 0; i < args.length; i += 2) {
    // Connection sharing is left to Ansible's own settings.
    if (args[i] === '-o' && /^Control(Master|Path|Persist)=/.test(args[i + 1])) continue;
    keep.push(args[i], args[i + 1]);
  }
  return keep.map((a) => (/^[A-Za-z0-9@%+=:,._/-]+$/.test(a) ? a : q(a))).join(' ');
}

/** The public half of the console's key ("<type> <key>"), derived from the private key. */
export async function publicKey() {
  const res = await collect('ssh-keygen', ['-y', '-f', SSH_KEY], { timeout: 10000 });
  const line = res.stdout.trim().split('\n')[0] || '';
  if (res.code !== 0 || !KEYLINE_RE.test(line.split(' ').slice(0, 2).join(' '))) throw new Error('could not read the console ssh key');
  return line.split(' ').slice(0, 2).join(' ');
}

/** Run a bash script built by the console on such a host. The script travels on stdin. */
export function hostScript(spec, script, opts = {}) {
  const { args, dest } = hostArgs(spec);
  return withSlot(`host:${dest}`, () => collect('ssh', [...args, dest, 'bash -s'], { ...opts, input: script }));
}

// Small per-project queue so a burst of requests cannot exhaust the master.
const slots = new Map(); // id -> {active, waiting[]}
async function withSlot(id, fn) {
  let s = slots.get(id);
  if (!s) slots.set(id, (s = { active: 0, waiting: [] }));
  if (s.active >= MAX_PARALLEL) await new Promise((r) => s.waiting.push(r));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.waiting.shift()?.();
  }
}

function collect(cmd, argv, { input, inputStream, timeout = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => {
      if (stdout.length < maxBytes) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 65536) stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\nkilled: ${signal}` : stderr });
    });
    child.stdin.on('error', () => {});
    if (inputStream) inputStream.pipe(child.stdin);
    else child.stdin.end(input ?? '');
  });
}

/** Run a read-only bash script on the VM. The script travels on stdin, never in argv. */
export function readScript(project, script, opts = {}) {
  const { args, dest } = sshArgs(project);
  return withSlot(project.id, () => collect('ssh', [...args, dest, 'bash -s'], { ...opts, input: script }));
}

/**
 * Run one fixed kit script as root: `sudo /opt/agent-kit/bin/<script> <args>`.
 * Script name and every argument are checked against strict patterns, so no
 * shell text chosen by a caller can reach the VM. `input` (or a readable
 * `inputStream`) goes to stdin.
 */
export function kit(project, script, argv = [], opts = {}) {
  if (!SCRIPT_RE.test(script)) throw new Error(`bad kit script name: ${script}`);
  for (const a of argv) {
    if (typeof a !== 'string' || !ARG_RE.test(a)) throw new Error(`bad argument for ${script}: ${JSON.stringify(a)}`);
  }
  const { args, dest } = sshArgs(project);
  const remote = ['sudo', '-n', `/opt/agent-kit/bin/${script}`, ...argv].join(' ');
  return withSlot(project.id, () => collect('ssh', [...args, dest, remote], opts));
}

/**
 * Pull-only rsync. Never deletes, never copies or follows symlinks.
 * `as`: 'agent' for agent-owned trees (so root never follows a path the agent
 * could have swapped), 'self' for world-readable root-owned files.
 */
export function pull(project, remotePaths, localDir, { as = 'self', filters = [], maxSize = '64m', timeout = 180000 } = {}) {
  const { args, dest } = sshArgs(project);
  const rsh = ['ssh', ...args].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ');
  const argv = ['-rt', '--no-links', '--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r', `--max-size=${maxSize}`, '-e', rsh];
  if (as === 'agent') argv.push('--rsync-path=sudo -n -u agent rsync');
  argv.push(...filters, ...remotePaths.map((p) => `${dest}:${p}`), localDir.endsWith('/') ? localDir : `${localDir}/`);
  return withSlot(project.id, () => collect('rsync', argv, { timeout }));
}

/** Single-quote a value for a remote bash script. */
export function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export { ARG_RE };
