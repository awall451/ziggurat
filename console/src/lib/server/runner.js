// Runs one Ansible playbook at a time for the console and records the run.
//
// What may run is fixed here: a playbook is picked by name from PLAYBOOKS,
// never by path from a caller, and its variables come from a file the console
// generated from validated input. Each run gets a folder:
//   run.json       what was asked, when, and how it ended
//   inventory.json the generated inventory
//   vars.json      the generated variables (never a secret)
//   events.jsonl   one JSON line per event (see ansible/callback_plugins)
//   stdout.log, stderr.log
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, REPO_DIR, writeJson, readJson } from './config.js';
import { readAll } from './events.js';

const BIN = process.env.ANSIBLE_PLAYBOOK_BIN || 'ansible-playbook';
const ANSIBLE_DIR = path.resolve(process.env.CONSOLE_ANSIBLE_DIR || path.join(REPO_DIR, 'console', 'ansible'));
const DEPLOYS = path.join(DATA_DIR, 'deploys');
const LOCK = path.join(DEPLOYS, '.lock');

export const PLAYBOOKS = {
  create: { file: path.join(REPO_DIR, 'sandbox', 'proxmox', 'playbooks', 'create-agent-vm.yml'), timeoutMs: 60 * 60_000 }
};

let active = null; // {deployId, runId, child, dir}

export class Busy extends Error {
  constructor(a) {
    super('Another deploy is running. One at a time.');
    this.status = 409;
    this.active = a;
  }
}

export function activeRun() {
  return active ? { deployId: active.deployId, runId: active.runId } : null;
}

export function runDir(deployId, runId) {
  return path.join(DEPLOYS, deployId, 'runs', runId);
}

export function readRun(deployId, runId) {
  return readJson(path.join(runDir(deployId, runId), 'run.json'), null);
}

function append(file, row) {
  fs.appendFileSync(file, JSON.stringify({ ...row, ts: Date.now() }) + '\n');
}

/** How a run ended, from its events. Used by start() and by recovery after a restart. */
export function summarize(dir) {
  const events = readAll(path.join(dir, 'events.jsonl'));
  const failed = events.filter((e) => e.type === 'task_failed' && !e.ignored);
  const last = failed.at(-1) || null;
  const result = events.filter((e) => e.type === 'result').at(-1)?.data || null;
  const okTasks = events.filter((e) => e.type === 'task_ok').map((e) => e.task);
  return {
    result,
    okTasks,
    failedTask: last ? { task: last.task, msg: last.msg || '', stderr: last.stderr || '', stdout: last.stdout || '', unreachable: !!last.unreachable } : null
  };
}

/**
 * Start a run. Resolves as soon as the process is started, with the run
 * record; `onDone(run)` is called when it has ended (any way).
 *   kind      label for the record: 'dry-run', 'create', ...
 *   playbook  a key of PLAYBOOKS
 *   check     true = ansible --check
 *   vars      plain object, written to vars.json
 *   inventory plain object, written to inventory.json
 *   files     extra small files for the run folder: {name: text}
 */
export function start({ deployId, kind, playbook, check = false, vars, inventory, files = {}, onDone = () => {} }) {
  const pb = PLAYBOOKS[playbook];
  if (!pb) throw new Error(`unknown playbook: ${playbook}`);
  if (active) throw new Busy(activeRun());
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${kind}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = runDir(deployId, runId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    if (!/^[a-z0-9._-]{1,40}$/.test(name)) throw new Error('bad run file name');
    fs.writeFileSync(path.join(dir, name), text);
  }
  writeJson(path.join(dir, 'vars.json'), vars);
  writeJson(path.join(dir, 'inventory.json'), inventory);
  const events = path.join(dir, 'events.jsonl');
  const run = { id: runId, deployId, kind, playbook, check, startedAt: new Date().toISOString(), status: 'running' };
  const save = () => writeJson(path.join(dir, 'run.json'), run);
  save();

  const argv = [pb.file, '-i', path.join(dir, 'inventory.json'), '--extra-vars', `@${path.join(dir, 'vars.json')}`];
  if (check) argv.push('--check');
  const env = {
    ...process.env,
    ANSIBLE_CONFIG: path.join(ANSIBLE_DIR, 'ansible.cfg'),
    ANSIBLE_HOME: path.join(DATA_DIR, 'ansible'),
    ANSIBLE_FORCE_COLOR: 'false',
    ANSIBLE_NOCOLOR: '1',
    PYTHONUNBUFFERED: '1',
    ZIGGURAT_EVENTS_PATH: events
  };
  const out = fs.openSync(path.join(dir, 'stdout.log'), 'a');
  const err = fs.openSync(path.join(dir, 'stderr.log'), 'a');
  // Its own process group, so a time limit can stop ansible and its ssh children together.
  const child = spawn(BIN, argv, { cwd: path.dirname(pb.file), env, stdio: ['ignore', out, err], detached: true });
  fs.closeSync(out);
  fs.closeSync(err);
  active = { deployId, runId, child, dir };
  fs.mkdirSync(DEPLOYS, { recursive: true });
  writeJson(LOCK, { deployId, runId, pid: child.pid, startedAt: run.startedAt });
  append(events, { type: 'run_start', kind, check, run: runId });

  let ended = false;
  let timedOut = false;
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  const limit = setTimeout(() => {
    timedOut = true;
    append(events, { type: 'stderr', line: `Stopped: the run went over its time limit of ${Math.round(pb.timeoutMs / 60000)} minutes.` });
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
  }, Number(process.env.CONSOLE_RUN_TIMEOUT_MS) || pb.timeoutMs);

  const finish = (code, spawnError) => {
    if (ended) return;
    ended = true;
    clearTimeout(limit);
    const s = summarize(dir);
    run.endedAt = new Date().toISOString();
    run.exitCode = code;
    run.status = spawnError ? 'failed' : timedOut ? 'timeout' : code === 0 ? 'succeeded' : 'failed';
    run.result = s.result;
    run.okTasks = s.okTasks;
    run.failedTask = s.failedTask;
    if (spawnError) run.error = `Could not start ansible-playbook: ${spawnError.message}`;
    else if (run.status !== 'succeeded' && !s.failedTask) {
      const tail = (() => {
        try {
          return fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8').trim().split('\n').slice(-5).join('\n').slice(-1500);
        } catch {
          return '';
        }
      })();
      run.error = timedOut ? 'The run went over its time limit and was stopped.' : tail || `ansible-playbook ended with exit code ${code}`;
    }
    save();
    append(events, { type: 'done', status: run.status, exitCode: code });
    active = null;
    fs.rmSync(LOCK, { force: true });
    Promise.resolve()
      .then(() => onDone(run))
      .catch((e) => console.error('deploy: finishing a run failed', e));
  };
  child.on('error', (e) => finish(-1, e));
  child.on('close', (code, signal) => finish(code ?? (signal ? 128 : -1)));
  return run;
}

/**
 * After a console restart no run can still be going (Ansible is a child of the
 * console). Marks what the lock file names as interrupted and returns it.
 */
export function recover() {
  const lock = readJson(LOCK, null);
  if (!lock || active) return null;
  fs.rmSync(LOCK, { force: true });
  if (!lock.deployId || !lock.runId) return null;
  const dir = runDir(lock.deployId, lock.runId);
  const run = readJson(path.join(dir, 'run.json'), null);
  if (!run || run.status !== 'running') return null;
  const s = summarize(dir);
  Object.assign(run, { status: 'interrupted', endedAt: new Date().toISOString(), result: s.result, okTasks: s.okTasks, failedTask: s.failedTask, error: 'The console restarted while this run was going. The run was cut off.' });
  writeJson(path.join(dir, 'run.json'), run);
  append(path.join(dir, 'events.jsonl'), { type: 'done', status: 'interrupted', exitCode: null });
  return run;
}
