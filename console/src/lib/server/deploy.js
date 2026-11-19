// Creating a project from the console, step by step. One record per deploy in
// DATA_DIR/deploys/<id>/deploy.json holds what was asked, what the checks
// found and how far it got; the rules that keep a deploy from touching the
// wrong thing live here:
//
//   - a real run needs a successful dry run of exactly the same inputs, less
//     than 15 minutes old, and the VM id the dry run settled on is the one used;
//   - before any run the target is asked again: the id must be in the target's
//     range, not protected, not in use, and the name must be free;
//   - the console never destroys, rolls back or resumes anything. After a
//     failure it shows what exists and the commands to clean up by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as config from './config.js';
import { audit } from './audit.js';
import { validateTarget, validateDeployRequest, targetNet } from './schema.js';
import { checkBundle, stageBundle, projectEnv } from './bundle.js';
import { inspect, domainAllowed } from './pve.js';
import * as runner from './runner.js';
import { SSH_KEY, ansibleSshArgs, publicKey, setHostKey } from './ssh.js';

const DIR = path.join(config.DATA_DIR, 'deploys');
const DRY_RUN_MAX_AGE_MS = 15 * 60_000;
const HOSTKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]{40,1100}={0,3}$/;
const RUNNING = ['dry-running', 'creating'];
// States in which the request may still be edited (no VM belongs to the deploy).
const EDITABLE = ['draft', 'planned', 'dry-run-failed', 'abandoned'];

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function needDeploy() {
  if (!config.DEPLOY_ENABLED) throw fail(404, 'Creating projects is turned off (set CONSOLE_DEPLOY=1)');
}

const file = (id) => path.join(DIR, id, 'deploy.json');

function load(id) {
  if (!config.ID_RE.test(id || '')) return null;
  return config.readJson(file(id), null);
}

function save(d) {
  d.updatedAt = new Date().toISOString();
  config.writeJson(file(d.id), d);
  return d;
}

function targetOf(d) {
  const raw = config.getTarget(d.request.target);
  if (!raw) throw fail(409, `Target ${d.request.target} no longer exists`);
  try {
    return validateTarget(raw);
  } catch (e) {
    throw fail(409, `Target ${d.request.target} has settings that are not valid: ${e.message}`);
  }
}

/** What a dry run must match: the request and the staged team. */
function fingerprint(d) {
  return crypto.createHash('sha256').update(JSON.stringify([d.request, d.bundle?.charter || '', d.bundle?.env || ''])).digest('hex');
}

/** The exact commands that remove what a failed create may have left. Shown, never run. */
export function cleanupCommands(t, vmid) {
  return [`qm stop ${vmid}`, `qm destroy ${vmid} --purge`, `rm -f ${t.snippetsDir}/cloudinit-agent-${vmid}.yaml`];
}

/** The record plus what the page needs to decide which buttons to show. */
export function view(d) {
  if (!d) return null;
  const active = runner.activeRun();
  const age = d.plan?.at ? Date.now() - Date.parse(d.plan.at) : null;
  const planFresh = d.state === 'planned' && d.plan?.hash === fingerprint(d) && age != null && age < DRY_RUN_MAX_AGE_MS;
  return {
    ...d,
    running: RUNNING.includes(d.state),
    busyElsewhere: active && active.deployId !== d.id ? active.deployId : null,
    can: {
      edit: EDITABLE.includes(d.state),
      dryRun: ['draft', 'planned', 'dry-run-failed'].includes(d.state) && !!d.bundle?.ok,
      create: planFresh,
      continue: d.state === 'create-failed' && !!d.failure?.canContinue,
      abandon: !RUNNING.includes(d.state) && d.state !== 'abandoned'
    },
    planExpiresAt: d.state === 'planned' && d.plan?.at ? new Date(Date.parse(d.plan.at) + DRY_RUN_MAX_AGE_MS).toISOString() : null
  };
}

export function getDeploy(id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  return view(d);
}

export function listDeploys() {
  needDeploy();
  let ids = [];
  try {
    ids = fs.readdirSync(DIR).filter((n) => config.ID_RE.test(n));
  } catch {
    ids = [];
  }
  return ids
    .map(load)
    .filter(Boolean)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((d) => ({ id: d.id, name: d.request.name, state: d.state, updatedAt: d.updatedAt, vmid: d.vm?.vmid ?? d.plan?.vmid ?? null }));
}

/** Create a deploy from the form, or replace one that has no VM yet. */
export async function putDeploy(user, input) {
  needDeploy();
  const rawTarget = config.getTarget(typeof input?.target === 'string' ? input.target : '');
  let target = null;
  try {
    if (rawTarget) target = validateTarget(rawTarget);
  } catch (e) {
    throw fail(409, `That target has settings that are not valid: ${e.message}`);
  }
  let request;
  try {
    request = validateDeployRequest(input, target);
  } catch (e) {
    throw fail(400, e.message);
  }
  if (!target) throw fail(400, 'target: no such target');
  if (config.rawProjects().some((p) => p.id === request.id)) throw fail(409, `id: a project called ${request.id} already exists`);
  const old = load(request.id);
  if (old && !EDITABLE.includes(old.state)) throw fail(409, `id: a deploy called ${request.id} is already under way`);

  const check = checkBundle(request.source);
  const d = {
    id: request.id,
    by: user?.name || 'unknown',
    createdAt: old?.createdAt || new Date().toISOString(),
    state: 'draft',
    request,
    bundle: {
      ok: check.ok,
      problems: check.problems,
      warnings: check.warnings,
      agents: check.agents,
      provision: check.provision,
      domains: check.domains,
      seed: check.seed,
      files: check.files,
      sizes: check.sizes,
      charter: '',
      env: ''
    },
    plan: null,
    vm: null,
    failure: null,
    error: null,
    runs: old?.runs || []
  };
  if (check.ok) {
    try {
      d.bundle.env = projectEnv({ ...request, proxyUrl: targetNet(target).proxyUrl, extras: check.extras });
      const staged = await stageBundle(path.join(DIR, d.id), request.source, { theme: request.theme, charter: request.charter, env: d.bundle.env });
      d.bundle.charter = staged.charter;
      // As rendered for the theme, so the page shows the names the team will see.
      d.bundle.agents = staged.agents;
    } catch (e) {
      d.bundle.ok = false;
      d.bundle.problems = [...d.bundle.problems, e.message];
    }
  }
  save(d);
  audit(user, d.id, 'deploy-draft', { target: request.target, source: `${request.source.kind}:${request.source.id}` }, { ok: d.bundle.ok, detail: d.bundle.ok ? null : d.bundle.problems.slice(0, 2).join('; ') });
  return view(d);
}

/**
 * Ask the target what is there right now and apply the refusals.
 * `vmid`: the id to use (pinned by a dry run), or null to pick one.
 */
async function preflight(d, t, { vmid = null, strictMemory = false, mustExist = false } = {}) {
  const problems = [];
  const warnings = [];
  const seen = await inspect(t, { fresh: true });
  if (seen.error) return { problems: [seen.error], warnings, vmid: null, seen };
  for (const c of seen.checks) {
    if (!c.ok) problems.push(`${c.label}: ${c.detail || 'failed'}`);
    else if (c.warn) warnings.push(`${c.label}: ${c.detail}`);
  }
  const id = vmid ?? d.request.vmid ?? seen.next?.vmid ?? null;
  if (id == null) problems.push('No free VM id in the target range');
  else {
    if (id < t.vmidMin || id > t.vmidMax) problems.push(`VM id ${id} is outside the target's range`);
    if (t.criticalVmids.includes(id)) problems.push(`VM id ${id} is protected`);
    const holder = seen.guests.find((g) => g.vmid === id);
    if (mustExist) {
      if (!holder || holder.kind !== 'vm' || holder.name !== d.id) problems.push(`VM ${id} is not there under the name ${d.id} any more`);
    } else {
      if (holder) problems.push(`VM id ${id} is already in use by ${holder.name}`);
      if (seen.guests.some((g) => g.name === d.id)) problems.push(`A guest named ${d.id} already exists on the host`);
    }
  }
  if (config.rawProjects().some((p) => p.id === d.id)) problems.push(`A project called ${d.id} already exists`);
  if (!mustExist && seen.memFreeMb != null && seen.memFreeMb < d.request.memoryMb) {
    (strictMemory ? problems : warnings).push(`The host has ${(seen.memFreeMb / 1024).toFixed(1)} GB of memory free; this VM is set to ${(d.request.memoryMb / 1024).toFixed(1)} GB`);
  }
  if (seen.allowed) {
    for (const dom of d.bundle.domains || []) {
      if (!domainAllowed(seen.allowed, dom)) warnings.push(`The team needs ${dom}, which the gateway's allow-list does not let through yet`);
    }
  }
  return { problems, warnings, vmid: id, seen };
}

function ansibleInput(d, t, vmid, mustBeNew) {
  const net = targetNet(t);
  const pubkey = path.join(DIR, d.id, 'pubkey.pub');
  return {
    inventory: {
      all: {
        hosts: {
          pve: {
            ansible_host: t.pveHost,
            ansible_user: t.pveUser,
            ansible_ssh_private_key_file: SSH_KEY,
            ansible_ssh_common_args: ansibleSshArgs({ jump: t.bastion || null })
          }
        }
      }
    },
    vars: {
      agent_vm_name: d.id,
      agent_vm_vmid: vmid,
      agent_vm_must_be_new: mustBeNew,
      agent_vm_cores: d.request.cores,
      agent_vm_memory_mb: d.request.memoryMb,
      agent_vm_disk_gb: d.request.diskGb,
      agent_vm_storage: t.storage,
      snippets_storage: t.snippetsStorage,
      snippets_dir: t.snippetsDir,
      cloud_user: t.adminUser,
      admin_user: t.adminUser,
      admin_ssh_pubkey: pubkey,
      ssh_pubkey_local_path: pubkey,
      agent_bridge: t.bridge,
      agent_subnet_prefix: t.subnetPrefix,
      agent_cidr: `${t.subnetPrefix}.0/24`,
      agent_gw_bridge_ip: net.gatewayBridgeIp,
      agent_proxy_port: 3128,
      agent_proxy_url: net.proxyUrl,
      agent_gw_vmid: t.gatewayVmid,
      agent_template_vmid: t.templateVmid,
      agent_vmid_min: t.vmidMin,
      agent_vmid_max: t.vmidMax,
      agent_critical_vmids: t.criticalVmids,
      lan_gateway: t.lanGateway,
      pve_host_ip: t.pveLanIp
    }
  };
}

async function launch(user, d, t, { kind, check, vmid, mustBeNew, state }) {
  if (!t.pveHostKey) throw fail(409, 'The target has no saved host key');
  const key = await publicKey().catch((e) => {
    throw fail(500, e.message);
  });
  fs.mkdirSync(path.join(DIR, d.id), { recursive: true });
  fs.writeFileSync(path.join(DIR, d.id, 'pubkey.pub'), key + '\n');
  setHostKey(t.pveHost, t.pveHostKey);
  const { inventory, vars } = ansibleInput(d, t, vmid, mustBeNew);
  let run;
  try {
    run = runner.start({ deployId: d.id, kind, playbook: 'create', check, vars, inventory, onDone: (r) => finished(d.id, r) });
  } catch (e) {
    if (e.status) throw e;
    throw fail(500, e.message);
  }
  d.state = state;
  d.error = null;
  d.lastRun = run.id;
  d.runs = [...(d.runs || []), { id: run.id, kind, startedAt: run.startedAt }].slice(-30);
  save(d);
  audit(user, d.id, `deploy-${kind}`, { target: t.id, vmid, run: run.id });
  return view(d);
}

export async function startDryRun(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (!['draft', 'planned', 'dry-run-failed'].includes(d.state)) throw fail(409, 'A dry run is not possible in this state');
  if (!d.bundle?.ok) throw fail(409, 'The team has problems that must be fixed first');
  if (runner.activeRun()) throw new runner.Busy(runner.activeRun());
  const t = targetOf(d);
  const pre = await preflight(d, t);
  d.preflight = { at: new Date().toISOString(), problems: pre.problems, warnings: pre.warnings, pool: pre.seen.pool || null, memFreeMb: pre.seen.memFreeMb ?? null };
  if (pre.problems.length) {
    d.state = 'dry-run-failed';
    d.error = pre.problems.join('; ');
    save(d);
    throw fail(409, d.error);
  }
  d.plan = null;
  return launch(user, d, t, { kind: 'dry-run', check: true, vmid: pre.vmid, mustBeNew: true, state: 'dry-running' });
}

export async function startCreate(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (d.state !== 'planned' || !d.plan) throw fail(409, 'Do a dry run first');
  if (d.plan.hash !== fingerprint(d)) throw fail(409, 'The inputs changed after the dry run. Do a dry run again');
  if (Date.now() - Date.parse(d.plan.at) > DRY_RUN_MAX_AGE_MS) throw fail(409, 'The dry run is more than 15 minutes old. Do a dry run again');
  if (runner.activeRun()) throw new runner.Busy(runner.activeRun());
  const t = targetOf(d);
  const pre = await preflight(d, t, { vmid: d.plan.vmid, strictMemory: true });
  d.preflight = { at: new Date().toISOString(), problems: pre.problems, warnings: pre.warnings, pool: pre.seen.pool || null, memFreeMb: pre.seen.memFreeMb ?? null };
  if (pre.problems.length) {
    save(d);
    throw fail(409, `Not started: ${pre.problems.join('; ')}. Do a dry run again`);
  }
  d.vm = { vmid: d.plan.vmid, ip: d.plan.ip, hostKey: null, stage: null };
  d.failure = null;
  return launch(user, d, t, { kind: 'create', check: false, vmid: d.plan.vmid, mustBeNew: true, state: 'creating' });
}

/** Pick a half-made VM up again: only this deploy's own VM, and only after the clone finished. */
export async function continueCreate(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (d.state !== 'create-failed' || !d.failure?.canContinue || !d.vm?.vmid) throw fail(409, 'This deploy cannot be continued. Clean up by hand and start again');
  if (runner.activeRun()) throw new runner.Busy(runner.activeRun());
  const t = targetOf(d);
  const pre = await preflight(d, t, { vmid: d.vm.vmid, mustExist: true });
  if (pre.problems.length) throw fail(409, `Not continued: ${pre.problems.join('; ')}`);
  return launch(user, d, t, { kind: 'create', check: false, vmid: d.vm.vmid, mustBeNew: false, state: 'creating' });
}

/** Give up on a deploy. Changes the record only: nothing on the host is touched. */
export function abandon(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (RUNNING.includes(d.state)) throw fail(409, 'A run is going. Wait for it to end');
  d.state = 'abandoned';
  save(d);
  audit(user, d.id, 'deploy-abandon', { vmid: d.vm?.vmid ?? null });
  return view(d);
}

const MILESTONES = [
  ['Milestone - the wall holds', 'walled'],
  ['Milestone - cloud-init finished', 'provisioned'],
  ['Milestone - the VM exists', 'cloned']
];

/** How far a create got, from the play's own result or, when it was cut off, from the tasks that finished. */
function stageOf(run) {
  if (run.result?.stage && run.result.stage !== 'planned') return run.result.stage;
  const ok = run.okTasks || [];
  for (const [task, stage] of MILESTONES) if (ok.includes(task)) return stage;
  return null;
}

/** Called when a run has ended, however it ended. */
async function finished(id, run) {
  const d = load(id);
  if (!d || d.lastRun !== run.id) return;
  const why = run.failedTask ? `${run.failedTask.task}: ${run.failedTask.msg}`.slice(0, 1500) : run.error || `The run ended as ${run.status}`;
  let t = null;
  try {
    t = targetOf(d);
  } catch {
    t = null;
  }

  if (run.kind === 'dry-run') {
    const r = run.result;
    const vmid = Number(r?.vmid);
    const sane = t && Number.isInteger(vmid) && vmid >= t.vmidMin && vmid <= t.vmidMax && !t.criticalVmids.includes(vmid) && r?.ip === targetNet(t).vmIp(vmid);
    if (run.status === 'succeeded' && r?.stage === 'planned' && sane && String(r.existed) !== 'true' && String(r.existed) !== 'True') {
      d.state = 'planned';
      d.plan = { vmid, ip: r.ip, peers: String(r.peers || '').split(/\s+/).filter(Boolean), at: new Date().toISOString(), hash: fingerprint(d), run: run.id };
      d.error = null;
    } else {
      d.state = 'dry-run-failed';
      d.plan = null;
      d.error = run.status === 'succeeded' ? 'The dry run ended without a usable plan' : why;
    }
    save(d);
    audit({ name: d.by }, d.id, 'deploy-dry-run-end', { run: run.id, vmid: d.plan?.vmid ?? null }, { ok: d.state === 'planned', detail: d.error });
    return;
  }

  // create
  const r = run.result;
  const key = typeof r?.host_key === 'string' ? r.host_key.trim() : '';
  if (run.status === 'succeeded' && r?.stage === 'done' && Number(r.vmid) === d.vm?.vmid && r.ip === d.vm?.ip && HOSTKEY_RE.test(key)) {
    setHostKey(d.vm.ip, key);
    d.vm = { ...d.vm, hostKey: key, stage: 'done', snapshot: r.snapshot || null };
    d.state = 'created';
    d.failure = null;
    d.error = null;
  } else {
    const stage = stageOf(run);
    let vmExists = null;
    if (t) {
      const seen = await inspect(t, { fresh: true }).catch(() => null);
      if (seen && !seen.error) vmExists = seen.guests.some((g) => g.vmid === d.vm?.vmid && g.kind === 'vm' && g.name === d.id);
    }
    d.state = 'create-failed';
    d.vm = { ...d.vm, stage };
    d.error = run.status === 'succeeded' ? 'The run ended without the expected result (VM id, address or host key)' : why;
    d.failure = {
      at: new Date().toISOString(),
      run: run.id,
      status: run.status,
      task: run.failedTask?.task || null,
      stage,
      vmExists,
      // Only a VM whose clone finished, and that did not fail its wall check, may be picked up again.
      canContinue: stage === 'cloned' && vmExists === true,
      cleanup: t && d.vm?.vmid ? cleanupCommands(t, d.vm.vmid) : []
    };
  }
  save(d);
  audit({ name: d.by }, d.id, 'deploy-create-end', { run: run.id, vmid: d.vm?.vmid ?? null, ip: d.vm?.ip ?? null }, { ok: d.state === 'created', detail: d.error });
}

/** At startup: a run cut off by a console restart is recorded as a failure of its step. */
export async function recover() {
  if (!config.DEPLOY_ENABLED) return;
  const run = runner.recover();
  if (run) await finished(run.deployId, run);
  // A record still marked as running with no run behind it cannot continue either.
  let ids = [];
  try {
    ids = fs.readdirSync(DIR).filter((n) => config.ID_RE.test(n));
  } catch {
    ids = [];
  }
  for (const id of ids) {
    const d = load(id);
    if (d && RUNNING.includes(d.state) && runner.activeRun()?.deployId !== id) {
      const last = d.lastRun ? runner.readRun(id, d.lastRun) : null;
      if (last && last.status !== 'running') await finished(id, last);
      else {
        d.state = d.state === 'dry-running' ? 'dry-run-failed' : 'create-failed';
        d.error = 'The console restarted while this step was running.';
        save(d);
      }
    }
  }
}

export function eventsFile(id, runId) {
  if (!config.ID_RE.test(id || '') || !/^[0-9TZ]{16}-[a-z-]{1,20}-[0-9a-f]{6}$/.test(runId || '')) throw fail(400, 'Bad run id');
  return path.join(runner.runDir(id, runId), 'events.jsonl');
}
