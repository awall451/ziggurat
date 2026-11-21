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
import { validateTarget, validateDeployRequest, validateProject, targetNet } from './schema.js';
import { checkBundle, stageBundle, buildPayload, projectEnv } from './bundle.js';
import { inspect, domainAllowed } from './pve.js';
import * as runner from './runner.js';
import { SSH_KEY, ansibleSshArgs, publicKey, setHostKey, kit } from './ssh.js';
import { invalidateStatus } from './live.js';
import { TOKEN_FILE, readToken, tokenConfigured } from './token.js';

const DIR = path.join(config.DATA_DIR, 'deploys');
const DRY_RUN_MAX_AGE_MS = 15 * 60_000;
const HOSTKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]{40,1100}={0,3}$/;
const RUNNING = ['dry-running', 'creating', 'installing'];

// States in which the request may still be edited (no VM belongs to the deploy).
const EDITABLE = ['draft', 'planned', 'dry-run-failed', 'abandoned'];

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function needDeploy() {
  if (!config.DEPLOY_ENABLED) throw fail(404, 'Creating projects is turned off (set CONSOLE_DEPLOY=1)');
}

const file = (id) => path.join(DIR, id, 'deploy.json');

export { tokenConfigured };

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
    running: RUNNING.includes(d.state) || d.proof?.state === 'running',
    busyElsewhere: active && active.deployId !== d.id ? active.deployId : null,
    can: {
      edit: EDITABLE.includes(d.state),
      dryRun: ['draft', 'planned', 'dry-run-failed'].includes(d.state) && !!d.bundle?.ok,
      create: planFresh,
      continue: d.state === 'create-failed' && !!d.failure?.canContinue,
      install: d.state === 'created' || d.state === 'install-failed',
      checkLogin: d.state === 'awaiting-login',
      proof: d.state === 'ready' && d.proof?.state !== 'running',
      abandon: !RUNNING.includes(d.state) && !['abandoned', 'ready'].includes(d.state)
    },
    tokenConfigured: tokenConfigured(),
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
      if (check.needsGoal && !request.goal) throw new Error('goal: say what the team should build');
      const staged = await stageBundle(path.join(DIR, d.id), request.source, { theme: request.theme, charter: request.charter, env: d.bundle.env, goal: request.goal });
      d.bundle.charter = staged.charter;
      // As rendered for the theme, so the page shows the names the team will see.
      d.bundle.agents = staged.agents;
      if (/REPLACE THIS/.test(staged.charter)) {
        d.bundle.ok = false;
        d.bundle.problems = [...d.bundle.problems, 'charter: the goal still has the placeholder text. Say what the team should build.'];
      }
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

async function launch(user, d, t, { kind, check = false, vmid, mustBeNew, state, install = null }) {
  if (!t.pveHostKey) throw fail(409, 'The target has no saved host key');
  setHostKey(t.pveHost, t.pveHostKey);
  if (t.gatewayHostKey) setHostKey(t.gatewayLanIp, t.gatewayHostKey);
  let inventory, vars;
  if (install) ({ inventory, vars } = install);
  else {
    const key = await publicKey().catch((e) => {
      throw fail(500, e.message);
    });
    fs.mkdirSync(path.join(DIR, d.id), { recursive: true });
    fs.writeFileSync(path.join(DIR, d.id, 'pubkey.pub'), key + '\n');
    ({ inventory, vars } = ansibleInput(d, t, vmid, mustBeNew));
  }
  let run;
  try {
    run = runner.start({ deployId: d.id, kind, playbook: install ? 'install' : 'create', check, vars, inventory, onDone: (r) => finished(d.id, r) });
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

/** How the console reaches the deploy's VM: through the target's gateway. */
function vmSsh(d, t) {
  return { host: d.vm.ip, user: t.adminUser, jump: `${t.adminUser}@${t.gatewayLanIp}` };
}

/** What the manual sign-in step shows: three things to paste on the workstation. */
function loginHelp(d, t) {
  return {
    sshConfig: `Host ${d.id}\n  HostName ${d.vm.ip}\n  User ${t.adminUser}\n  ProxyJump ${t.adminUser}@${t.gatewayLanIp}\n`,
    knownHosts: `${d.vm.ip} ${d.vm.hostKey}`,
    command: `ssh -t ${d.id} sudo -iu agent claude`
  };
}

/**
 * Install the kit and the team in the deploy's VM. Runs by itself after a
 * successful create; can be started again after a failed install, once the VM
 * was rolled back by hand. The team is read and staged again each time, so a
 * corrected bundle is picked up.
 */
export async function startInstall(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (!['created', 'install-failed'].includes(d.state) || !d.vm?.vmid || !d.vm?.hostKey) throw fail(409, 'There is no finished VM to install into');
  if (runner.activeRun()) throw new runner.Busy(runner.activeRun());
  const t = targetOf(d);
  const pre = await preflight(d, t, { vmid: d.vm.vmid, mustExist: true });
  if (pre.problems.length) throw fail(409, `Not started: ${pre.problems.join('; ')}`);

  const check = checkBundle(d.request.source);
  if (!check.ok) throw fail(409, `The team has problems: ${check.problems.join('; ')}`);
  const dir = path.join(DIR, d.id);
  let payload;
  try {
    d.bundle.env = projectEnv({ ...d.request, proxyUrl: targetNet(t).proxyUrl, extras: check.extras });
    const staged = await stageBundle(dir, d.request.source, { theme: d.request.theme, charter: d.request.charter, env: d.bundle.env, goal: d.request.goal });
    Object.assign(d.bundle, { charter: staged.charter, agents: staged.agents, provision: check.provision, files: check.files, seed: check.seed });
    payload = await buildPayload(dir, d.request.source, { name: d.request.name, description: d.request.description, goal: d.request.goal, docs: d.request.docs || [] });
  } catch (e) {
    throw fail(500, e.message);
  }
  const spec = vmSsh(d, t);
  const sshOpts = ansibleSshArgs({ jump: spec.jump });
  const useToken = tokenConfigured();
  const install = {
    inventory: {
      all: { hosts: { agent_vm: { ansible_host: spec.host, ansible_user: spec.user, ansible_ssh_private_key_file: SSH_KEY, ansible_ssh_common_args: sshOpts } } }
    },
    vars: {
      project_id: d.id,
      payload_archive: payload.archive,
      agent_proxy_url: targetNet(t).proxyUrl,
      // A path, never the token itself: the playbook reads the file inside a no_log task.
      claude_token_file: useToken ? TOKEN_FILE : '',
      provision_files_dir: payload.files || '',
      rsync_rsh: payload.files ? `ssh ${sshOpts}` : '',
      rsync_dest: payload.files ? `${spec.user}@${spec.host}` : ''
    }
  };
  d.failure = null;
  d.install = { startedAt: new Date().toISOString(), token: useToken };
  return launch(user, d, t, { kind: 'install', vmid: d.vm.vmid, state: 'installing', install });
}

/** Add the finished project to projects.json, so it shows up like any other. */
function register(d, t) {
  const entry = validateProject(
    {
      id: d.id,
      name: d.request.name,
      ...(d.request.description ? { description: d.request.description } : {}),
      theme: d.request.theme,
      accent: d.request.accent,
      target: t.id,
      vmid: d.vm.vmid,
      ssh: vmSsh(d, t),
      // Publishing still has to be verified on the Controls tab: the key goes to the remote first.
      ...(d.request.remote ? { publish: { remote: d.request.remote } } : {}),
      // Beside the other projects' data when those folders are configured.
      ...(config.FLEET_ROOT || config.TRANSCRIPTS_ROOT
        ? {
            paths: {
              ...(config.TRANSCRIPTS_ROOT ? { transcripts: path.join(config.TRANSCRIPTS_ROOT, d.id, 'projects') } : {}),
              ...(config.FLEET_ROOT ? { fleet: path.join(config.FLEET_ROOT, d.id) } : {})
            }
          }
        : {})
    },
    config.pathRoots()
  );
  config.saveProject(entry, { replace: true });
  invalidateStatus(d.id);
  d.registeredAt = new Date().toISOString();
  d.state = 'ready';
  d.error = null;
  audit({ name: d.by }, d.id, 'project-add', { ssh: entry.ssh.host, vmid: d.vm.vmid, by: 'deploy' });
}

const short = (v) => (v && typeof v === 'object' ? { status: String(v.status || ''), detail: String(v.detail || '').slice(0, 500), sha: String(v.sha || '').slice(0, 40) } : null);

/**
 * Prove the new project's gate on the VM: a harmless change must be merged, a
 * change that deletes a test must be refused (kit script agent-kit-gate-proof).
 * The team stays halted. Runs in the background; the record holds the result.
 */
function startProof(user, d, t) {
  const startedAt = new Date().toISOString();
  d.proof = { state: 'running', startedAt };
  save(d);
  audit(user, d.id, 'deploy-gate-proof', { vmid: d.vm.vmid });
  const done = (proof) => {
    const now = load(d.id);
    if (!now || now.proof?.startedAt !== startedAt) return;
    now.proof = { state: 'done', startedAt, ...proof };
    save(now);
    audit({ name: now.by }, now.id, 'deploy-gate-proof-end', { good: proof.good?.status || null, drop: proof.drop?.status || null }, { ok: proof.ok === true, detail: proof.error || proof.note || null });
    if (proof.ok === true) return planWhenReady(now);
  };
  // The gate's checks can take a while (two full runs).
  kit({ id: d.id, target: t.id, ssh: vmSsh(d, t) }, 'agent-kit-gate-proof', ['run'], { timeout: 75 * 60_000 })
    .then((res) => {
      let r = null;
      try {
        r = JSON.parse(res.stdout.trim().split('\n').at(-1));
      } catch {
        r = null;
      }
      if (!r || typeof r.ok !== 'boolean') return done({ ok: false, error: `The VM gave no result: ${(res.stderr || `exit ${res.code}`).trim().slice(-200)}` });
      done({ ok: r.ok, at: r.at || null, good: short(r.good), drop: short(r.drop), deleted: r.deleted ? String(r.deleted).slice(0, 200) : null, note: r.note ? String(r.note).slice(0, 300) : null, error: r.error ? String(r.error).slice(0, 300) : null, main: r.main ? String(r.main).slice(0, 12) : null, tests: Number.isInteger(r.tests) ? r.tests : null });
    })
    .catch((e) => done({ ok: false, error: e.message }));
}

/**
 * "Start a planning cycle when it is ready": once the gate is proven, the
 * owner's choice on the form starts one planning cycle with the focus and the
 * cap on proposals. Only once per deploy. The lead writes no code in it and the
 * team halts again when it ends; the console still never resumes a team.
 */
export async function planWhenReady(d) {
  if (!d.request?.plan?.on || d.planStartedAt || d.planError) return;
  const project = config.getProject(d.id);
  if (!project) return;
  // Loaded here: backlog.js pulls in the audit log, issues and feedback.
  const { startPlan } = await import('./backlog.js');
  const focus = d.request.plan.focus || 'Read the owner\'s plan and design in docs/ and the charter, and propose the first jobs. Choosing the stack and writing the real tools/check comes first.';
  try {
    const out = await startPlan({ name: d.by }, project, { focus, maxProposals: d.request.plan.maxProposals || 5, kitVersion: d.install?.kitVersion || null });
    const now = load(d.id);
    if (!now) return;
    now.planStartedAt = new Date().toISOString();
    now.planId = out.id;
    if (!out.started) now.planError = out.detail;
    save(now);
  } catch (e) {
    const now = load(d.id);
    if (!now) return;
    now.planError = e.message;
    save(now);
  }
}

/** Run the gate proof (again) for a finished project. */
export function gateProof(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (d.state !== 'ready') throw fail(409, 'The project is not finished yet');
  if (d.proof?.state === 'running') throw fail(409, 'A gate proof is already running');
  startProof(user, d, targetOf(d));
  return view(load(id));
}

/** Ask the VM whether Claude is signed in for the agent user. Spends no tokens. */
async function signIn(d, t) {
  const res = await kit({ id: d.id, target: t.id, ssh: vmSsh(d, t) }, 'agent-kit-auth', ['status'], { timeout: 45000 });
  try {
    const s = JSON.parse(res.stdout.trim().split('\n').at(-1));
    return { loggedIn: s.loggedIn === true && s.apiKeySet !== true, authMethod: s.authMethod || 'none', tokenStored: !!s.tokenStored, apiKeySet: !!s.apiKeySet, expiresAt: s.loginExpiresAt || null };
  } catch {
    throw fail(502, `Could not ask the VM: ${(res.stderr || `exit ${res.code}`).trim().slice(-200)}`);
  }
}

/** The manual sign-in step: look again, and finish the deploy once Claude is signed in. */
export async function checkLogin(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (d.state !== 'awaiting-login') throw fail(409, 'This deploy is not waiting for a sign-in');
  const t = targetOf(d);
  const s = await signIn(d, t);
  d.install = { ...d.install, ...s, checkedAt: new Date().toISOString() };
  if (s.loggedIn) register(d, t);
  save(d);
  audit(user, d.id, 'deploy-login-check', { method: s.authMethod }, { ok: s.loggedIn, detail: s.loggedIn ? null : s.apiKeySet ? 'an API key is set' : 'not signed in' });
  if (d.state === 'ready' && !d.proof) startProof(user, d, t);
  return view(load(id));
}

/** Hand the saved token to a VM that is waiting for a sign-in (the token file was added later). */
export async function applyToken(user, id) {
  needDeploy();
  const d = load(id);
  if (!d) throw fail(404, 'No such deploy');
  if (d.state !== 'awaiting-login') throw fail(409, 'This deploy is not waiting for a sign-in');
  const token = readToken();
  if (!token) throw fail(409, 'No usable token is saved (claude-token in the console config folder)');
  const t = targetOf(d);
  const res = await kit({ id: d.id, target: t.id, ssh: vmSsh(d, t) }, 'agent-kit-auth', ['set-token'], { input: token + '\n', timeout: 45000 });
  // The script prints nothing from its input; keep only a fixed word either way.
  audit(user, d.id, 'deploy-apply-token', {}, { ok: res.code === 0, detail: res.code === 0 ? 'token stored' : `refused (exit ${res.code})` });
  if (res.code !== 0) throw fail(502, 'The VM refused the token');
  return checkLogin(user, id);
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
  ['Milestone - kit installed', 'kit-installed'],
  ['Milestone - provisioning done', 'provisioned-tools'],
  ['Milestone - install started', 'install-started'],
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

  if (run.kind === 'install') {
    const r = run.result;
    const yes = (v) => v === true || String(v).toLowerCase() === 'true';
    if (run.status === 'succeeded' && r?.stage === 'installed' && t) {
      const loggedIn = yes(r.logged_in) && !yes(r.api_key_set);
      d.install = { ...d.install, at: new Date().toISOString(), kitVersion: String(r.kit_version || ''), baselineTests: Number(r.baseline_tests) || 0, main: String(r.main || ''), loggedIn, authMethod: String(r.auth_method || 'none'), tokenStored: yes(r.token_stored), apiKeySet: yes(r.api_key_set) };
      d.failure = null;
      d.error = null;
      d.vm = { ...d.vm, stage: 'installed' };
      if (loggedIn) {
        try {
          register(d, t);
        } catch (e) {
          d.state = 'awaiting-login';
          d.error = `Installed, but the project could not be added to the list: ${e.message}`;
        }
      } else {
        d.state = 'awaiting-login';
        d.login = loginHelp(d, t);
      }
    } else {
      const stage = stageOf(run);
      d.state = 'install-failed';
      d.error = run.status === 'succeeded' ? 'The install ended without the expected result' : why;
      d.failure = {
        at: new Date().toISOString(),
        run: run.id,
        status: run.status,
        task: run.failedTask?.task || null,
        stage,
        // Once the first step ran, the VM is no longer clean: back to the snapshot first.
        // The same holds when the playbook refused because an earlier attempt left its mark.
        needsRollback: stage != null || run.status !== 'failed' || /^Nothing may be installed yet/.test(run.failedTask?.task || ''),
        rollback: d.vm?.vmid ? [`qm rollback ${d.vm.vmid} provisioned`, `qm start ${d.vm.vmid}`] : [],
        cleanup: t && d.vm?.vmid ? cleanupCommands(t, d.vm.vmid) : []
      };
    }
    save(d);
    audit({ name: d.by }, d.id, 'deploy-install-end', { run: run.id, vmid: d.vm?.vmid ?? null, kit: d.install?.kitVersion || null, token: !!d.install?.token }, { ok: ['ready', 'awaiting-login'].includes(d.state), detail: d.error });
    // Finished and registered: prove the gate before anyone starts the team.
    if (d.state === 'ready' && t) startProof({ name: d.by }, d, t);
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
  // The VM is ready: go straight on to the kit and the team.
  if (d.state === 'created' && run.status === 'succeeded') {
    try {
      await startInstall({ name: d.by }, d.id);
    } catch (e) {
      const now = load(id);
      if (now && now.state === 'created') {
        now.error = `The VM is ready, but the install did not start: ${e.message}`;
        save(now);
      }
    }
  }
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
    if (d?.proof?.state === 'running') {
      d.proof = { state: 'done', startedAt: d.proof.startedAt, ok: null, error: 'The console restarted while the proof was running. Run it again.' };
      save(d);
    }
    if (d && RUNNING.includes(d.state) && runner.activeRun()?.deployId !== id) {
      const last = d.lastRun ? runner.readRun(id, d.lastRun) : null;
      if (last && last.status !== 'running') await finished(id, last);
      else {
        d.state = d.state === 'dry-running' ? 'dry-run-failed' : d.state === 'installing' ? 'install-failed' : 'create-failed';
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
