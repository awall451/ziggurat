import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Everything the modules read at load time comes first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-dep-'));
const here = path.dirname(new URL(import.meta.url).pathname);
process.env.CONSOLE_CONFIG_DIR = path.join(root, 'config');
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
process.env.CONSOLE_PROJECTS_DIR = path.join(root, 'projects');
process.env.CONSOLE_DEPLOY = '1';
process.env.CONSOLE_NO_PULL = '1';
process.env.CONSOLE_SSH_KEY_FILE = path.join(root, 'key');
process.env.ANSIBLE_PLAYBOOK_BIN = path.join(here, 'fixtures', 'fake-ansible.mjs');
process.env.FAKE_MODE = path.join(root, 'mode');
process.env.FAKE_LOG = path.join(root, 'fake.log');
process.env.FAKE_INSTALL_MODE = path.join(root, 'install-mode');
process.env.FAKE_GUESTS = path.join(root, 'guests.jsonl');
process.env.FLEET_DATA = path.join(root, 'fleet');
process.env.TRANSCRIPTS_DIR = path.join(root, 'transcripts');
const TOKEN = 'sk-ant-oat01-' + 'T0kenT0ken'.repeat(4);
const tokenFile = path.join(root, 'config', 'claude-token');

// What the Proxmox host "says". Tests change `host` to set up a situation.
const host = { guests: [], pct: 81.77, memFreeMb: 24000, error: null, allowed: ['.anthropic.com', 'registry.npmjs.org'] };
vi.mock('../src/lib/server/pve.js', () => ({
  inspect: async (t) => {
    if (host.error) return { ok: false, error: host.error, checks: [], guests: [] };
    const level = host.pct >= t.poolBlockPct ? 'block' : host.pct >= t.poolWarnPct ? 'warn' : 'ok';
    // VMs the stand-in Ansible "created" are on the host too.
    let made = [];
    try {
      made = fs.readFileSync(process.env.FAKE_GUESTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      made = [];
    }
    const guests = [...host.guests, ...made];
    const taken = new Set(guests.map((g) => g.vmid));
    let next = null;
    for (let i = t.vmidMin; i <= t.vmidMax && next == null; i++) if (!taken.has(i) && !t.criticalVmids.includes(i)) next = i;
    return {
      ok: level !== 'block',
      checks: [{ id: 'pool', label: 'Storage local-lvm has room', ok: level !== 'block', warn: level === 'warn', detail: `${host.pct}% used` }],
      guests,
      next: next == null ? null : { vmid: next, ip: `${t.subnetPrefix}.${next - t.vmidMin + 10}` },
      pool: { pct: host.pct, level },
      memFreeMb: host.memFreeMb,
      allowed: host.allowed
    };
  },
  domainAllowed: (allowed, d) => (allowed || []).some((a) => (a.startsWith('.') ? d === a.slice(1) || d.endsWith(a) : d === a)),
  forgetInspect: () => {}
}));

// What the new VM "answers" when the console asks it over ssh.
const PROOF_OK = { ok: true, at: '2026-01-01T00:00:00Z', good: { status: 'merged', detail: 'all checks passed; main -> abc1234 (2 tests)', sha: 'a'.repeat(40) }, drop: { status: 'failed', detail: 'unit tests passed dropped from 2 to 1 (tests may not be deleted or skipped)', sha: 'b'.repeat(40) }, deleted: 'tests/test_placeholder.py', note: null, main: 'abc1234', tests: 2 };
const vm = { auth: { loggedIn: false, authMethod: 'none', tokenStored: false, apiKeySet: false }, calls: [], proof: PROOF_OK, proofGate: null };
vi.mock('../src/lib/server/ssh.js', async (original) => ({
  ...(await original()),
  kit: async (project, script, argv, opts = {}) => {
    vm.calls.push({ project, script, argv, input: opts.input || null });
    if (script === 'agent-kit-gate-proof') {
      if (vm.proofGate) await vm.proofGate;
      return vm.proof == null ? { code: 255, stdout: '', stderr: 'ssh: connection lost' } : { code: vm.proof.ok ? 0 : 1, stdout: JSON.stringify(vm.proof) + '\n', stderr: '' };
    }
    if (script === 'agent-kit-auth' && argv[0] === 'set-token') {
      vm.auth = { loggedIn: true, authMethod: 'oauth_token', tokenStored: true, apiKeySet: false };
      return { code: 0, stdout: 'token stored (used from the next cycle)\n', stderr: '' };
    }
    return { code: vm.auth.loggedIn ? 0 : 1, stdout: JSON.stringify(vm.auth) + '\n', stderr: '' };
  }
}));

const deploy = await import('../src/lib/server/deploy.js');
const runner = await import('../src/lib/server/runner.js');
const config = await import('../src/lib/server/config.js');
const { readAudit } = await import('../src/lib/server/audit.js');

const user = { name: 'tester' };
const KEY = 'ssh-ed25519 ' + 'A'.repeat(68);
const target = {
  id: 'homelab', pveHost: '192.0.2.10', pveHostKey: KEY, bridge: 'vmbr1', subnetPrefix: '10.66.0', gatewayVmid: 110, gatewayLanIp: '192.0.2.20',
  lanGateway: '192.0.2.1', templateVmid: 9000, vmidMin: 300, vmidMax: 399, storage: 'local-lvm', adminUser: 'admin', criticalVmids: [304]
};
const form = (over = {}) => ({ id: 'demo', target: 'homelab', source: { kind: 'folder', id: 'plan' }, ...over });
const mode = (m) => fs.writeFileSync(process.env.FAKE_MODE, m);
const fakeCalls = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const record = (id = 'demo') => JSON.parse(fs.readFileSync(path.join(root, 'data', 'deploys', id, 'deploy.json'), 'utf8'));
const patch = (fn, id = 'demo') => {
  const d = record(id);
  fn(d);
  fs.writeFileSync(path.join(root, 'data', 'deploys', id, 'deploy.json'), JSON.stringify(d));
};
const status = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return [e.status, e.message];
  }
  return [0, ''];
};
/** Wait until the deploy stops moving: no run going, and not about to start its install. */
async function settled(id = 'demo') {
  for (let i = 0; i < 600; i++) {
    const d = record(id);
    const moving = ['dry-running', 'creating', 'installing'].includes(d.state) || (d.state === 'created' && !d.error);
    if (!moving && !runner.activeRun()) return d;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not end');
}
async function planned(over) {
  await deploy.putDeploy(user, form(over));
  mode('ok');
  await deploy.startDryRun(user, over?.id || 'demo');
  return settled(over?.id || 'demo');
}

beforeAll(() => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', process.env.CONSOLE_SSH_KEY_FILE]);
  config.saveTarget(target);
  // A small, valid team in a project folder.
  const team = path.join(root, 'projects', 'plan', 'team');
  fs.mkdirSync(path.join(team, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects', 'plan', 'seed'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'plan', 'seed', 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(team, 'CHARTER.md'), '# Charter\nThe {{lead}} builds a demo.\n');
  fs.writeFileSync(path.join(team, 'GATE-CONTRACT.md'), '# Gate\n');
  fs.writeFileSync(path.join(team, 'lead-cycle.md'), 'You are the {{lead}}.\n');
  fs.writeFileSync(path.join(team, 'gate-checks'), '#!/bin/bash\necho TESTS_PASSED=1\n');
  fs.writeFileSync(path.join(team, 'project.env'), 'PROJECT=ignored\nBASELINE_TESTS=1\n');
  fs.writeFileSync(path.join(team, 'requires-domains'), 'pypi.org\nregistry.npmjs.org\n');
  for (const a of ['area-lead-core', 'builder', 'scout']) fs.writeFileSync(path.join(team, 'agents', `${a}.md`), `---\nname: ${a}\ndescription: helps the {{lead}}\nmodel: sonnet\n---\nYou are a {{worker}}.\n`);
});

beforeEach(() => {
  Object.assign(host, { guests: [{ vmid: 300, name: 'first', status: 'stopped', kind: 'vm' }, { vmid: 110, name: 'agent-gw', status: 'running', kind: 'ct' }], pct: 81.77, memFreeMb: 24000, error: null });
  fs.rmSync(path.join(root, 'data', 'deploys'), { recursive: true, force: true });
  for (const f of [process.env.FAKE_LOG, process.env.FAKE_GUESTS, process.env.FAKE_INSTALL_MODE, tokenFile]) fs.rmSync(f, { force: true });
  delete process.env.CONSOLE_RUN_TIMEOUT_MS;
  config.deleteProject('demo');
  Object.assign(vm, { auth: { loggedIn: false, authMethod: 'none', tokenStored: false, apiKeySet: false }, calls: [], proof: PROOF_OK, proofGate: null });
  mode('ok');
});

describe('a draft', () => {
  it('stages the team, writes project.env itself and renders the theme', async () => {
    const d = await deploy.putDeploy(user, form({ theme: 'tolkien', cyclesPerDay: 3 }));
    expect(d.state).toBe('draft');
    expect(d.bundle.ok).toBe(true);
    expect(d.bundle.agents.map((a) => a.id)).toEqual(['area-lead-core', 'builder', 'scout']);
    expect(d.bundle.charter).not.toContain('{{');
    expect(JSON.stringify(d.bundle.agents)).not.toContain('{{');
    expect(d.bundle.env).toContain('PROJECT=demo\nWORKSPACE=/home/agent/demo\nBARE=/srv/demo.git');
    expect(d.bundle.env).toContain('MAX_CYCLES_PER_DAY=3');
    expect(d.bundle.env).toContain('AGENT_PROXY_URL=http://10.66.0.1:3128');
    expect(d.bundle.env).toContain('BASELINE_TESTS=1');
    expect(d.bundle.env).not.toContain('ignored');
    expect(fs.readFileSync(path.join(root, 'data', 'deploys', 'demo', 'bundle', 'project.env'), 'utf8')).toBe(d.bundle.env);
    expect(d.can).toMatchObject({ dryRun: true, create: false });
  });

  it('refuses bad input, an unknown target and a taken project id', async () => {
    expect((await status(() => deploy.putDeploy(user, form({ id: 'Bad Id' }))))[0]).toBe(400);
    expect((await status(() => deploy.putDeploy(user, form({ target: 'nowhere' }))))[0]).toBe(400);
    expect((await status(() => deploy.putDeploy(user, form({ vmid: 304 }))))[1]).toMatch(/protected/);
    expect((await status(() => deploy.putDeploy(user, form({ vmid: 250 }))))[1]).toMatch(/range/);
    config.saveProject({ id: 'taken', ssh: { alias: 'taken' } });
    expect((await status(() => deploy.putDeploy(user, form({ id: 'taken' }))))[0]).toBe(409);
    config.deleteProject('taken');
  });

  it('does not allow a dry run while the team has problems', async () => {
    const d = await deploy.putDeploy(user, form({ source: { kind: 'folder', id: 'missing' } }));
    expect(d.bundle.ok).toBe(false);
    expect((await status(() => deploy.startDryRun(user, 'demo')))[0]).toBe(409);
    expect(fs.existsSync(process.env.FAKE_LOG)).toBe(false);
  });
});

describe('dry run', () => {
  it('pins the VM id and address and warns about a domain the gateway does not allow', async () => {
    const d = await planned();
    expect(d.state).toBe('planned');
    expect(d.plan).toMatchObject({ vmid: 301, ip: '10.66.0.11', peers: ['10.66.0.11', '10.66.0.12'] });
    expect(d.preflight.warnings.join(' ')).toMatch(/pypi\.org/);
    expect(d.preflight.warnings.join(' ')).not.toMatch(/npmjs/);
    const [call] = fakeCalls();
    expect(call).toMatchObject({ check: true, vmid: 301, mustBeNew: true, name: 'demo' });
    expect(call.pubkey).toMatch(/^ssh-ed25519 /);
    expect(deploy.getDeploy('demo').can.create).toBe(true);
  });

  it('is refused before Ansible starts when the host cannot take the deploy', async () => {
    const cases = [
      [() => (host.pct = 93), /Storage/],
      [() => host.guests.push({ vmid: 320, name: 'demo', status: 'stopped', kind: 'vm' }), /named demo already exists/],
      [() => (host.error = 'Could not reach the Proxmox host'), /Could not reach/]
    ];
    for (const [setup, expected] of cases) {
      Object.assign(host, { guests: [], pct: 50, error: null });
      await deploy.putDeploy(user, form());
      setup();
      const [code, msg] = await status(() => deploy.startDryRun(user, 'demo'));
      expect(code).toBe(409);
      expect(msg).toMatch(expected);
      expect(record().state).toBe('dry-run-failed');
    }
    await deploy.putDeploy(user, form({ vmid: 300 }));
    Object.assign(host, { guests: [{ vmid: 300, name: 'first', status: 'stopped', kind: 'vm' }], pct: 50, error: null });
    expect((await status(() => deploy.startDryRun(user, 'demo')))[1]).toMatch(/already in use by first/);
    expect(fs.existsSync(process.env.FAKE_LOG)).toBe(false);
  });

  it('fails when the host cannot be reached by Ansible, or the plan is not usable', async () => {
    await deploy.putDeploy(user, form());
    mode('unreachable');
    await deploy.startDryRun(user, 'demo');
    let d = await settled();
    expect(d.state).toBe('dry-run-failed');
    expect(d.error).toMatch(/Failed to connect/);
    mode('plan-exists');
    await deploy.startDryRun(user, 'demo');
    d = await settled();
    expect(d.state).toBe('dry-run-failed');
    expect(d.plan).toBe(null);
  });
});

describe('create', () => {
  it('needs a matching, fresh dry run', async () => {
    await deploy.putDeploy(user, form());
    expect((await status(() => deploy.startCreate(user, 'demo')))[1]).toMatch(/dry run first/);
    await planned();
    patch((d) => (d.plan.at = new Date(Date.now() - 16 * 60_000).toISOString()));
    expect((await status(() => deploy.startCreate(user, 'demo')))[1]).toMatch(/15 minutes/);
    expect(deploy.getDeploy('demo').can.create).toBe(false);
    await planned();
    patch((d) => (d.request.memoryMb = 4096));
    expect((await status(() => deploy.startCreate(user, 'demo')))[1]).toMatch(/inputs changed/);
    // Editing the form drops the plan.
    await planned();
    expect((await deploy.putDeploy(user, form({ cores: 2 }))).state).toBe('draft');
    expect(fakeCalls().every((c) => c.check)).toBe(true);
  });

  it('asks the host again and refuses when the pinned id was taken meanwhile', async () => {
    await planned();
    host.guests.push({ vmid: 301, name: 'someone-else', status: 'running', kind: 'vm' });
    const [code, msg] = await status(() => deploy.startCreate(user, 'demo'));
    expect(code).toBe(409);
    expect(msg).toMatch(/already in use by someone-else/);
    expect(fakeCalls().some((c) => !c.check)).toBe(false);
  });

  it('refuses when the host has less free memory than the VM needs', async () => {
    await planned();
    host.memFreeMb = 4000;
    expect((await status(() => deploy.startCreate(user, 'demo')))[1]).toMatch(/memory/);
  });

  it('uses the pinned id, records the VM and trusts the host key read through Proxmox', async () => {
    await planned();
    await deploy.startCreate(user, 'demo');
    const d = await settled();
    // No token is saved, so after the install it waits for a sign-in.
    expect(d.state).toBe('awaiting-login');
    expect(d.vm).toMatchObject({ vmid: 301, ip: '10.66.0.11', stage: 'installed', snapshot: 'provisioned' });
    expect(fakeCalls().find((c) => c.check === false)).toMatchObject({ vmid: 301, mustBeNew: true });
    const known = fs.readFileSync(path.join(root, 'data', 'ssh', 'known_hosts'), 'utf8');
    expect(known).toContain(`10.66.0.11 ssh-ed25519 ${'C'.repeat(68)}`);
    expect(readAudit('demo').map((r) => r.action)).toEqual(expect.arrayContaining(['deploy-draft', 'deploy-dry-run', 'deploy-dry-run-end', 'deploy-create', 'deploy-create-end', 'deploy-install', 'deploy-install-end']));
    // A deploy with a VM cannot go back to a dry run or be replaced by a new draft.
    expect((await status(() => deploy.startDryRun(user, 'demo')))[0]).toBe(409);
    expect((await status(() => deploy.putDeploy(user, form())))[0]).toBe(409);
  });

  it('does not trust a result with a bad host key', async () => {
    await planned();
    mode('bad-key');
    await deploy.startCreate(user, 'demo');
    const d = await settled();
    expect(d.state).toBe('create-failed');
    expect(d.failure.canContinue).toBe(false);
  });
});

describe('a failed create', () => {
  it('can be continued when the clone finished and the VM is this deploy\'s own', async () => {
    await planned();
    mode('fail-cloud-init');
    await deploy.startCreate(user, 'demo');
    let d = await settled();
    expect(d.state).toBe('create-failed');
    expect(d.failure).toMatchObject({ stage: 'cloned', vmExists: true, canContinue: true, task: 'Wait for cloud-init to finish' });
    expect(d.failure.cleanup).toEqual(['qm stop 301', 'qm destroy 301 --purge', 'rm -f /var/lib/vz/snippets/cloudinit-agent-301.yaml']);
    mode('ok');
    await deploy.continueCreate(user, 'demo');
    d = await settled();
    expect(d.state).toBe('awaiting-login');
    expect(fakeCalls().filter((c) => c.check === false).at(-1)).toMatchObject({ vmid: 301, mustBeNew: false });
  });

  it('is not continued when the VM under that id is no longer this one', async () => {
    await planned();
    mode('fail-cloud-init');
    await deploy.startCreate(user, 'demo');
    await settled();
    fs.writeFileSync(process.env.FAKE_GUESTS, JSON.stringify({ vmid: 301, name: 'other', status: 'running', kind: 'vm' }) + '\n');
    expect((await status(() => deploy.continueCreate(user, 'demo')))[1]).toMatch(/not there under the name demo/);
  });

  it('stops for good when the wall check failed', async () => {
    await planned();
    mode('fail-wall');
    await deploy.startCreate(user, 'demo');
    const d = await settled();
    expect(d.failure).toMatchObject({ stage: 'provisioned', canContinue: false });
    expect(d.error).toMatch(/WALL CHECK FAILED/);
    expect((await status(() => deploy.continueCreate(user, 'demo')))[0]).toBe(409);
  });

  it('is not continued when the clone itself failed', async () => {
    await planned();
    mode('fail-clone');
    await deploy.startCreate(user, 'demo');
    const d = await settled();
    expect(d.failure).toMatchObject({ stage: null, canContinue: false, vmExists: false });
  });

  it('can be given up without touching the host', async () => {
    await planned();
    mode('fail-clone');
    await deploy.startCreate(user, 'demo');
    await settled();
    const calls = fakeCalls().length;
    expect(deploy.abandon(user, 'demo').state).toBe('abandoned');
    expect(fakeCalls().length).toBe(calls);
    // The id can be used for a new draft afterwards.
    expect((await deploy.putDeploy(user, form())).state).toBe('draft');
  });
});

describe('install, sign-in and registration', () => {
  const created = async () => {
    await planned();
    await deploy.startCreate(user, 'demo');
    return settled();
  };

  it('with a saved token goes from "Create project" to a registered, halted project by itself', async () => {
    fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
    const d = await created();
    expect(d.state).toBe('ready');
    expect(d.install).toMatchObject({ kitVersion: '0.3.0', loggedIn: true, authMethod: 'oauth_token', token: true, baselineTests: 2 });
    const call = fakeCalls().find((c) => c.install);
    expect(call).toMatchObject({ project: 'demo', payload: true, tokenFile, files: '' });
    // The project is in the list, reached through the gateway with the console's own host keys.
    const p = config.getProject('demo');
    expect(p).toMatchObject({ target: 'homelab', vmid: 301, ssh: { host: '10.66.0.11', user: 'admin', jump: 'admin@192.0.2.20' } });
    expect(p.paths).toEqual({ transcripts: path.join(root, 'transcripts', 'demo', 'projects'), fleet: path.join(root, 'fleet', 'demo') });
    // The token is nowhere in what the console wrote down.
    const dir = path.join(root, 'data', 'deploys', 'demo');
    const walk = (x) => (fs.statSync(x).isDirectory() ? fs.readdirSync(x).flatMap((n) => walk(path.join(x, n))) : [x]);
    for (const f of [...walk(dir).filter((x) => !x.endsWith('.tar.gz')), path.join(root, 'data', 'audit.jsonl'), process.env.FAKE_LOG]) {
      expect(fs.readFileSync(f, 'utf8').includes(TOKEN), f).toBe(false);
    }
    expect((await status(() => deploy.startInstall(user, 'demo')))[0]).toBe(409);
    expect(deploy.getDeploy('demo').can.abandon).toBe(false);
  });

  it('packs the kit, the rendered team and the seed, and nothing else', async () => {
    fs.writeFileSync(tokenFile, TOKEN + '\n');
    await created();
    const list = execFileSync('tar', ['-tzf', path.join(root, 'data', 'deploys', 'demo', 'payload.tar.gz')]).toString().split('\n');
    for (const f of ['kit/install.sh', 'kit/VERSION', 'kit/bin/agent-kit-auth', 'bundle/project.env', 'bundle/gate-checks', 'bundle/agents/builder.md', 'seed/README.md']) expect(list, f).toContain(f);
    expect(list.some((f) => f.startsWith('kit/tests') || f.includes('claude-token') || f.includes('requires-domains-x'))).toBe(false);
  });

  it('without a token waits for a sign-in, shows what to paste, and finishes once the VM says it is signed in', async () => {
    let d = await created();
    expect(d.state).toBe('awaiting-login');
    expect(d.login).toEqual({
      sshConfig: 'Host demo\n  HostName 10.66.0.11\n  User admin\n  ProxyJump admin@192.0.2.20\n',
      knownHosts: `10.66.0.11 ssh-ed25519 ${'C'.repeat(68)}`,
      command: 'ssh -t demo sudo -iu agent claude'
    });
    expect(config.getProject('demo')).toBe(null);
    expect((await deploy.checkLogin(user, 'demo')).state).toBe('awaiting-login');
    expect(vm.calls.at(-1)).toMatchObject({ script: 'agent-kit-auth', argv: ['status'], project: { target: 'homelab', ssh: { host: '10.66.0.11' } } });
    vm.auth = { loggedIn: true, authMethod: 'claude.ai', tokenStored: false, apiKeySet: false };
    d = await deploy.checkLogin(user, 'demo');
    expect(d.state).toBe('ready');
    expect(config.getProject('demo').vmid).toBe(301);
  });

  it('does not count a sign-in through an API key', async () => {
    await created();
    vm.auth = { loggedIn: true, authMethod: 'api_key', tokenStored: false, apiKeySet: true };
    expect((await deploy.checkLogin(user, 'demo')).state).toBe('awaiting-login');
  });

  it('can hand over a token that was saved later, without ever showing it', async () => {
    await created();
    expect((await status(() => deploy.applyToken(user, 'demo')))[1]).toMatch(/No usable token/);
    fs.writeFileSync(tokenFile, TOKEN + '\n');
    const d = await deploy.applyToken(user, 'demo');
    expect(d.state).toBe('ready');
    expect(vm.calls.find((c) => c.argv[0] === 'set-token').input).toBe(TOKEN + '\n');
    expect(fs.readFileSync(path.join(root, 'data', 'audit.jsonl'), 'utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it('ignores a token file that does not hold a token', async () => {
    fs.writeFileSync(tokenFile, 'two words\n');
    expect(deploy.tokenConfigured()).toBe(false);
    const d = await created();
    expect(d.state).toBe('awaiting-login');
    expect(fakeCalls().find((c) => c.install).tokenFile).toBe('');
  });

  it('after a failed install names the rollback, and a retry picks up a corrected team', async () => {
    fs.writeFileSync(tokenFile, TOKEN + '\n');
    fs.writeFileSync(process.env.FAKE_INSTALL_MODE, 'fail-provision');
    let d = await created();
    expect(d.state).toBe('install-failed');
    expect(d.error).toMatch(/provision\.sh failed/);
    expect(d.failure).toMatchObject({ stage: 'install-started', needsRollback: true, rollback: ['qm rollback 301 provisioned', 'qm start 301'] });
    expect(config.getProject('demo')).toBe(null);
    expect(deploy.getDeploy('demo').can).toMatchObject({ install: true, dryRun: false, create: false });
    // The owner fixes the team in the project folder, rolls back by hand, and retries.
    const charter = path.join(root, 'projects', 'plan', 'team', 'CHARTER.md');
    const before = fs.readFileSync(charter, 'utf8');
    fs.writeFileSync(charter, before + 'Corrected.\n');
    fs.writeFileSync(process.env.FAKE_INSTALL_MODE, 'ok');
    await deploy.startInstall(user, 'demo');
    d = await settled();
    fs.writeFileSync(charter, before);
    expect(d.state).toBe('ready');
    expect(d.bundle.charter).toContain('Corrected.');
    expect(fakeCalls().filter((c) => c.install)).toHaveLength(2);
    expect(fakeCalls().filter((c) => c.check === false)).toHaveLength(1);
  });

  it('does not install into a VM that is no longer there under the project name', async () => {
    fs.writeFileSync(process.env.FAKE_INSTALL_MODE, 'refused');
    const d = await created();
    expect(d.state).toBe('install-failed');
    // The playbook refused because something is already installed: the VM has to go back to its snapshot.
    expect(d.failure.needsRollback).toBe(true);
    fs.writeFileSync(process.env.FAKE_GUESTS, '');
    expect((await status(() => deploy.startInstall(user, 'demo')))[1]).toMatch(/not there under the name demo/);
  });

  it('refuses a charter that still has the placeholder goal', async () => {
    const d = await deploy.putDeploy(user, form({ charter: '# Charter\n\nREPLACE THIS: say what the team should build.\n' }));
    expect(d.bundle.ok).toBe(false);
    expect(d.bundle.problems.join(' ')).toMatch(/placeholder/);
  });
});

describe('the gate proof', () => {
  const ready = async () => {
    fs.writeFileSync(tokenFile, TOKEN + '\n');
    await planned();
    await deploy.startCreate(user, 'demo');
    await settled();
  };
  const proofDone = async () => {
    for (let i = 0; i < 200; i++) {
      const d = record();
      if (d.proof?.state === 'done') return d;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('proof did not end');
  };

  it('runs by itself once the project is registered and records both verdicts', async () => {
    await ready();
    const d = await proofDone();
    expect(d.state).toBe('ready');
    expect(d.proof).toMatchObject({ ok: true, good: { status: 'merged' }, drop: { status: 'failed' }, deleted: 'tests/test_placeholder.py', main: 'abc1234', tests: 2 });
    const call = vm.calls.find((c) => c.script === 'agent-kit-gate-proof');
    expect(call).toMatchObject({ argv: ['run'], project: { ssh: { host: '10.66.0.11' } } });
    expect(readAudit('demo').map((r) => r.action)).toEqual(expect.arrayContaining(['deploy-gate-proof', 'deploy-gate-proof-end']));
    // Nothing in the flow resumes the team.
    expect(vm.calls.some((c) => /resume|halt/.test(c.script))).toBe(false);
  });

  it('says so when the gate let a test deletion through', async () => {
    vm.proof = { ...PROOF_OK, ok: false, drop: { status: 'merged', detail: 'all checks passed', sha: 'c'.repeat(40) } };
    await ready();
    const d = await proofDone();
    expect(d.proof).toMatchObject({ ok: false, drop: { status: 'merged' } });
    expect(d.state).toBe('ready');
  });

  it('copes with a VM that gives no answer, and can be run again', async () => {
    vm.proof = null;
    await ready();
    let d = await proofDone();
    expect(d.proof.ok).toBe(false);
    expect(d.proof.error).toMatch(/gave no result/);
    vm.proof = PROOF_OK;
    expect(deploy.gateProof(user, 'demo').proof.state).toBe('running');
    d = await proofDone();
    expect(d.proof.ok).toBe(true);
  });

  it('runs one at a time, only for a finished project, and shows as running meanwhile', async () => {
    await deploy.putDeploy(user, form());
    expect((await status(() => Promise.resolve().then(() => deploy.gateProof(user, 'demo'))))[0]).toBe(409);
    let release;
    vm.proofGate = new Promise((r) => (release = r));
    await ready();
    const v = deploy.getDeploy('demo');
    expect(v.proof.state).toBe('running');
    expect(v.running).toBe(true);
    expect(v.can.proof).toBe(false);
    expect((await status(() => Promise.resolve().then(() => deploy.gateProof(user, 'demo'))))[0]).toBe(409);
    release();
    expect((await proofDone()).proof.ok).toBe(true);
    expect(deploy.getDeploy('demo').can.proof).toBe(true);
  });

  it('is marked unknown when a console restart cut it off', async () => {
    let release;
    vm.proofGate = new Promise((r) => (release = r));
    await ready();
    await deploy.recover();
    const d = record();
    expect(d.proof).toMatchObject({ state: 'done', ok: null });
    expect(d.proof.error).toMatch(/restarted/);
    release();
    await new Promise((r) => setTimeout(r, 60));
    // Here the process did not really restart, so the answer still arrives and is recorded.
    expect(record().proof.ok).toBe(true);
  });
});

describe('the runner', () => {
  it('runs one deploy at a time and stops a run that goes over its time limit', async () => {
    await deploy.putDeploy(user, form());
    await deploy.putDeploy(user, form({ id: 'second' }));
    process.env.CONSOLE_RUN_TIMEOUT_MS = '400';
    mode('hang');
    await deploy.startDryRun(user, 'demo');
    expect((await status(() => deploy.startDryRun(user, 'second')))[0]).toBe(409);
    expect(deploy.getDeploy('second').busyElsewhere).toBe('demo');
    expect((await status(() => Promise.resolve(deploy.abandon(user, 'demo'))))[0]).toBe(409);
    const d = await settled();
    expect(d.state).toBe('dry-run-failed');
    expect(d.error).toMatch(/time limit/);
    expect(runner.readRun('demo', d.lastRun).status).toBe('timeout');
    expect(fs.existsSync(path.join(root, 'data', 'deploys', '.lock'))).toBe(false);
  });

  it('records a run that a console restart cut off, as a failed create that may continue', async () => {
    await planned();
    // What a restart leaves behind: the lock, a run marked running, and the events written so far.
    const runId = '20260101T000000Z-create-abc123';
    const dir = runner.runDir('demo', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ id: runId, deployId: 'demo', kind: 'create', status: 'running' }));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), ['Clone template', 'Milestone - the VM exists'].map((task) => JSON.stringify({ type: 'task_ok', task })).join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'data', 'deploys', '.lock'), JSON.stringify({ deployId: 'demo', runId, pid: 1 }));
    patch((d) => Object.assign(d, { state: 'creating', lastRun: runId, vm: { vmid: 301, ip: '10.66.0.11' } }));
    host.guests.push({ vmid: 301, name: 'demo', status: 'running', kind: 'vm' });
    await deploy.recover();
    const d = record();
    expect(d.state).toBe('create-failed');
    expect(d.failure).toMatchObject({ status: 'interrupted', stage: 'cloned', canContinue: true });
    expect(runner.readRun('demo', runId).status).toBe('interrupted');
    expect(fs.existsSync(path.join(root, 'data', 'deploys', '.lock'))).toBe(false);
  });
});
