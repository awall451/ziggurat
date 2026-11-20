// Copies data from the sandbox VMs to the workstation. Pull only: a VM never
// gets credentials for this machine and never starts a transfer.
//
//   slow pass  every 15 min, every project: ledger, gate history, control,
//              notes, screenshots of the newest passing build, all transcripts
//   fast pass  every ~15 s while someone is looking at a running project:
//              just the files of the cycle in progress
//   end pass   a slow pass as soon as a cycle is seen to have ended, so its
//              ledger line (cost, outcome) arrives with its last transcript
//   publish    after a slow pass brought the lead's request: publish.js pushes
//              the gate's main to the project's remote (the other direction,
//              and never to a VM)
//
// Never deletes, never copies symlinks, and reads agent-owned trees as the
// agent user, so a misbehaving VM cannot remove, redirect or over-read files.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pull, sshArgs, q } from './ssh.js';
import { getStatus, peekStatus, UUID_RE } from './live.js';
import { listProjects } from './config.js';
import { syncOutbox } from './feedback.js';
import { syncRequest, maybePublish } from './publish.js';

const SLOW_EVERY = 15 * 60_000;
const FAST_EVERY = 15_000;
const VIEW_WINDOW = 45_000; // a project counts as "being looked at" this long after a request

// ledgerAt: when the last slow pass that copied the ledger began. A cycle that
// ended after that has no line here yet (transcripts.js shows it as ending).
// liveSession: the cycle last seen running, to notice when it ends.
// again: a slow pass was asked for while one ran that began too early.
const state = new Map(); // id -> {slowAt, fastAt, slow, fast, error, viewedAt, ledgerAt, liveSession, again}

function st(id) {
  let s = state.get(id);
  if (!s) state.set(id, (s = { slowAt: 0, fastAt: 0, slow: null, fast: null, error: null, viewedAt: 0, ledgerAt: null, liveSession: null, again: false }));
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
  // The status is fresh: whatever cycle ended before it is in the ledger now.
  s.liveSession = status.leadActive ? status.session || true : null;
  const k = project.kit;
  const fleet = project.paths.fleet;
  fs.mkdirSync(project.paths.transcripts, { recursive: true });
  fs.mkdirSync(path.join(fleet, 'notes'), { recursive: true });
  const errors = [];

  const t = await pull(project, [`${k.agentHome}/.claude/projects/`], project.paths.transcripts, { as: 'agent' });
  if (errText(t)) errors.push(`transcripts: ${errText(t)}`);

  // World-readable state files; `current` only exists on newer kits.
  const ledgerStart = Date.now();
  const f = await pull(project, [`${k.state}/ledger/cycles.jsonl`, `${k.state}/gate/history.log`, `${k.state}/control`], fleet, {
    maxSize: '32m'
  });
  if (errText(f)) errors.push(`state: ${errText(f)}`);
  else s.ledgerAt = ledgerStart;

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
  // Replies and questions from the lead (kits that have the owner inbox).
  if (status.kitVersion) await syncOutbox(project, { force: true });
  // The lead's request to publish main (projects with a remote).
  if (project.publish?.remote) await syncRequest(project).catch(() => {});
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

/** @param {{again?: boolean}} opts again: if a pass is running, run another after it */
function runSlow(project, { again = false } = {}) {
  const s = st(project.id);
  if (s.slow) {
    if (again) s.again = true;
    return s.slow;
  }
  s.again = false;
  s.slow = slowPass(project)
    .catch((e) => (s.error = String(e.message || e)))
    .finally(() => {
      s.slowAt = Date.now();
      s.slow = null;
      if (s.again) runSlow(project);
    });
  return s.slow;
}

/**
 * Notice a cycle ending: the lead was running at the last look and is not now.
 * Its ledger line is written before the service stops, so a pass started now
 * has it. A pass already running may have copied the ledger too early: run
 * another after it. Returns true when a pass was asked for.
 */
function watchEnd(project, status) {
  if (!status?.reachable) return false;
  const s = st(project.id);
  if (status.leadActive) {
    s.liveSession = status.session || true;
    return false;
  }
  if (!s.liveSession) return false;
  s.liveSession = null;
  runSlow(project, { again: true });
  return true;
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
  if (watchEnd(project, status)) return;
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

/** When the last ledger copy began (ms), or null if none has been made yet. */
export function ledgerPulledAt(id) {
  return st(id).ledgerAt;
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
      // Publishing waits for the gate after a cycle, so it is looked at on every
      // tick; it does nothing unless the lead's request is still open.
      if (!s.slow) maybePublish(p);
      if (watchEnd(p, peekStatus(p.id))) continue;
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
