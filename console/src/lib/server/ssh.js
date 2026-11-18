// The console reaches a sandbox VM the same way the workstation tools do: ssh
// from outside, through the gateway. Nothing runs in the other direction.
//
// Two kinds of call:
//   readScript()  a read-only script built by the console (status, listings)
//   kit()         a fixed, root-owned kit script with validated arguments;
//                 every change on a VM goes through one of these
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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
  return { args, dest };
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

function collect(cmd, argv, { input, timeout = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
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
    child.stdin.end(input ?? '');
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
 * shell text chosen by a caller can reach the VM. `input` goes to stdin.
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
