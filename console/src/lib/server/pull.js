// Copies data from the sandbox VMs to the workstation. Pull only: a VM never
// gets credentials for this machine and never starts a transfer.
//
//   slow pass  every 15 min, every project: ledger, gate history, control,
//              notes, screenshots of the newest passing build, all transcripts
//   fast pass  every ~15 s while someone is looking at a running project:
//              just the files of the cycle in progress
//
// Never deletes, never copies symlinks, and reads agent-owned trees as the
// agent user, so a misbehaving VM cannot remove, redirect or over-read files.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pull, sshArgs, q } from './ssh.js';
import { getStatus, peekStatus, UUID_RE } from './live.js';
import { listProjects } from './config.js';

const SLOW_EVERY = 15 * 60_000;
const FAST_EVERY = 15_000;
const VIEW_WINDOW = 45_000; // a project counts as "being looked at" this long after a request

const state = new Map(); // id -> {slowAt, fastAt, slow, fast, error, viewedAt}

function st(id) {
  let s = state.get(id);
  if (!s) state.set(id, (s = { slowAt: 0, fastAt: 0, slow: null, fast: null, error: null, viewedAt: 0 }));
  return s;
}

const errText = (res) => (res.code === 0 || res.code === 23 || res.code === 24 ? null : (res.stderr || `exit ${res.code}`).trim().slice(-300));

/** Notes are the `docs/` folder of gate main, streamed as a tar and unpacked here. */
function pullNotes(project, dest) {
  return new Promise((resolve) => {
    const { args, dest: host } = sshArgs(project);
    const bare = project.kit.bare;
    const remote = `git -c safe.directory=${q(bare)} -C ${q(bare)} archive main docs`;
    fs.mkdirSync(dest, { recursive: true });
    const ssh = spawn('ssh', [...args, host, remote], { stdio: ['ignore', 'pipe', 'ignore'] });
    // --no-same-owner/permissions: nothing from the archive decides modes here.
    const tar = spawn('tar', ['-x', '-C', dest, '--strip-components=1', '--no-same-owner', '--no-same-permissions'], {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    ssh.stdout.pipe(tar.stdin);
    tar.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      ssh.kill('SIGKILL');
      tar.kill('SIGKILL');
    }, 60000);
    tar.on('close', () => {
      clearTimeout(timer);
      // The repo is agent-written: drop any symlink it contained.
      spawn('find', [dest, '-type', 'l', '-delete'], { stdio: 'ignore' }).on('close', () => resolve());
    });
    ssh.on('error', () => resolve());
    tar.on('error', () => resolve());
  });
}

async function slowPass(project) {
  const s = st(project.id);
  const status = await getStatus(project, { fresh: true });
  if (!status.reachable) {
    s.error = status.error || 'unreachable';
    return;
  }
  const k = project.kit;
  const fleet = project.paths.fleet;
  fs.mkdirSync(project.paths.transcripts, { recursive: true });
  fs.mkdirSync(path.join(fleet, 'notes'), { recursive: true });
  const errors = [];

  const t = await pull(project, [`${k.agentHome}/.claude/projects/`], project.paths.transcripts, { as: 'agent' });
  if (errText(t)) errors.push(`transcripts: ${errText(t)}`);

  // World-readable state files; `current` only exists on newer kits.
  const f = await pull(project, [`${k.state}/ledger/cycles.jsonl`, `${k.state}/gate/history.log`, `${k.state}/control`], fleet, {
    maxSize: '32m'
  });
  if (errText(f)) errors.push(`state: ${errText(f)}`);

  if (status.shotsDir) {
    const day = new Date().toISOString().slice(0, 10);
    const shots = path.join(fleet, 'shots', day);
    fs.mkdirSync(shots, { recursive: true });
    const r = await pull(project, [`${status.shotsDir}/`], shots, {
      filters: ['--include=*.png', '--exclude=*'],
      maxSize: '10m'
    });
    if (errText(r)) errors.push(`shots: ${errText(r)}`);
  }

  await pullNotes(project, path.join(fleet, 'notes'));
  s.error = errors.length ? errors.join('; ') : null;
}

async function fastPass(project, session) {
  if (!UUID_RE.test(session)) return;
  const slug = project.slug;
  const res = await pull(project, [`${project.kit.agentHome}/.claude/projects/`], project.paths.transcripts, {
    as: 'agent',
    timeout: 60000,
    filters: [`--include=/${slug}/`, `--include=/${slug}/${session}.jsonl`, `--include=/${slug}/${session}/***`, '--exclude=*']
  });
  const s = st(project.id);
  if (errText(res)) s.error = `live: ${errText(res)}`;
}

function runSlow(project) {
  const s = st(project.id);
  if (s.slow) return s.slow;
  s.slow = slowPass(project)
    .catch((e) => (s.error = String(e.message || e)))
    .finally(() => {
      s.slowAt = Date.now();
      s.slow = null;
    });
  return s.slow;
}

function runFast(project, session) {
  const s = st(project.id);
  if (s.fast || s.slow) return;
  s.fast = fastPass(project, session)
    .catch((e) => (s.error = String(e.message || e)))
    .finally(() => {
      s.fastAt = Date.now();
      s.fast = null;
    });
}

/**
 * Called by every request that shows a project. Starts a pull in the
 * background if the data is stale and returns at once.
 */
export function touch(project, status = peekStatus(project.id)) {
  const s = st(project.id);
  s.viewedAt = Date.now();
  if (project.pull === false && !status?.reachable) return;
  if (Date.now() - s.slowAt > SLOW_EVERY) runSlow(project);
  else if (status?.leadActive && status.session && Date.now() - s.fastAt > FAST_EVERY) runFast(project, status.session);
}

export function pullInfo(id) {
  const s = st(id);
  return {
    pulledAt: Math.max(s.slowAt, s.fastAt) || null,
    fullAt: s.slowAt || null,
    pulling: !!(s.slow || s.fast),
    error: s.error
  };
}

/** Force a full pull now (the Refresh button). */
export function refresh(project) {
  return runSlow(project);
}

let timer = null;

/** Background loop: keeps every project's data fresh even with no browser open. */
export function startScheduler() {
  if (timer || process.env.CONSOLE_NO_PULL === '1') return;
  const tick = () => {
    for (const p of listProjects()) {
      if (p.pull === false) continue;
      const s = st(p.id);
      if (Date.now() - s.slowAt > SLOW_EVERY) runSlow(p);
      else if (Date.now() - s.viewedAt < VIEW_WINDOW) {
        const status = peekStatus(p.id);
        if (status?.leadActive && status.session && Date.now() - s.fastAt > FAST_EVERY) runFast(p, status.session);
      }
    }
  };
  timer = setInterval(tick, 5000);
  timer.unref?.();
  setTimeout(tick, 2000).unref?.();
}
