import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-pk-'));
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
process.env.CONSOLE_CONFIG_DIR = path.join(root, 'config');
process.env.CONSOLE_DEPLOY = '1';

// The VM, the Proxmox host and the gateway are stand-ins.
const vm = { status: '', calls: [], host: [], allowed: ['.anthropic.com', 'registry.npmjs.org'], hostCode: 0 };
vi.mock('../src/lib/server/ssh.js', async (original) => ({
  ...(await original()),
  kit: async (project, script, argv) => {
    vm.calls.push([script, ...argv]);
    if (argv[0] === 'status') return { code: 0, stdout: vm.status, stderr: '' };
    return { code: 0, stdout: `${argv[0]}d ${argv[1]}\n`, stderr: '' };
  },
  pull: async () => ({ code: 0 }),
  hostScript: async (spec, script) => {
    vm.host.push(script);
    return { code: vm.hostCode, stdout: '', stderr: vm.hostCode ? 'agent-allow: squid refused the list' : '' };
  }
}));
vi.mock('../src/lib/server/pve.js', async (original) => ({
  ...(await original()),
  inspect: async () => ({ allowed: vm.allowed }),
  forgetInspect: () => {}
}));

const pk = await import('../src/lib/server/packages.js');
const gw = await import('../src/lib/server/gateway.js');
const config = await import('../src/lib/server/config.js');

const KEY = 'ssh-ed25519 ' + 'A'.repeat(68);
const target = {
  id: 'homelab', pveHost: '192.0.2.10', pveHostKey: KEY, bridge: 'vmbr1', subnetPrefix: '10.66.0', gatewayVmid: 110, gatewayLanIp: '192.0.2.20',
  lanGateway: '192.0.2.1', templateVmid: 9000, vmidMin: 300, vmidMax: 399, storage: 'local-lvm', adminUser: 'admin', criticalVmids: []
};
const project = { id: 'revview', target: 'homelab', kit: { state: '/var/lib/agent-kit' }, ssh: { host: '10.66.0.12', user: 'admin' } };
const user = { name: 'owner' };
const R1 = '20261121T100000Z-k-aaaaaa';
const R2 = '20261121T100100Z-k-bbbbbb';
const R3 = '20261121T100200Z-k-cccccc';
const line = (o) => JSON.stringify({ decision: null, decidedAt: null, result: null, resultAt: null, ...o });

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  config.saveTarget(target);
  const out = path.join(root, 'data', 'packages', 'revview', 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${R1}.md`), 'Request: recipe:playwright-browsers@1.49.1\nDate: x\n---\nScreenshots from the emulator.\n');
  fs.writeFileSync(path.join(out, `${R2}.md`), 'Request: apt:something-else\n---\nThe file was changed after the status was read.\n');
});

describe('the gateway helper', () => {
  it('builds its script only from domain names', () => {
    expect(gw.allowScript(target, ['PyPI.org', '.pythonhosted.org'])).toBe(
      'set -e\npct exec 110 -- /usr/local/sbin/agent-allow add pypi.org\npct exec 110 -- /usr/local/sbin/agent-allow add .pythonhosted.org'
    );
    for (const bad of [['pypi.org; reboot'], ['-x'], ['localhost'], [], Array.from({ length: 11 }, (_, i) => `d${i}.org`)]) expect(() => gw.allowScript(target, bad)).toThrow();
    expect(() => gw.allowScript({}, ['pypi.org'])).toThrow(/gateway/);
  });
});

describe('requests', () => {
  it('reads what a request is and which domains it needs', () => {
    expect(pk.describe('apt:libsdl2-dev')).toMatchObject({ kind: 'apt', name: 'libsdl2-dev', domains: [] });
    expect(pk.describe('recipe:playwright-browsers@1.49.1')).toMatchObject({ kind: 'recipe', name: 'playwright-browsers', version: '1.49.1', domains: ['registry.npmjs.org', 'cdn.playwright.dev', 'playwright.download.prss.microsoft.com'] });
    expect(pk.describe('recipe:go@1.23.4').domains).toContain('dl.google.com');
    expect(pk.describe('domain:pypi.org')).toMatchObject({ kind: 'domain', domains: ['pypi.org'] });
    for (const bad of ['recipe:nope', 'apt:Bad;id', 'domain:-x', 'pip:requests']) expect(pk.describe(bad)).toBeNull();
  });

  it('merges the VM\'s status with the lead\'s reasons and the gateway\'s list', async () => {
    vm.status = [
      line({ rid: R1, request: 'recipe:playwright-browsers@1.49.1' }),
      line({ rid: R2, request: 'apt:libsdl2-dev', decision: 'approved', decidedAt: 'x', result: 'ok', resultAt: 'y' }),
      line({ rid: R3, request: 'pip:requests' }),
      'garbage'
    ].join('\n');
    const out = await pk.requests(project);
    expect(out.gateway).toBe('checked');
    expect(out.requests.map((r) => [r.rid, r.state])).toEqual([[R2, 'installed'], [R1, 'waiting']]);
    const r1 = out.requests.find((r) => r.rid === R1);
    expect(r1.reason).toBe('Screenshots from the emulator.');
    expect(r1.missing).toEqual(['cdn.playwright.dev', 'playwright.download.prss.microsoft.com']);
    // A reason for another request than the one the VM reports is not shown.
    expect(out.requests.find((r) => r.rid === R2).reason).toBeNull();
  });
});

describe('deciding', () => {
  it('approving adds the missing domains on the gateway first, then tells the VM', async () => {
    vm.calls = [];
    vm.host = [];
    const out = await pk.decideRequest(user, project, R1, 'approve');
    expect(out.added).toEqual(['cdn.playwright.dev', 'playwright.download.prss.microsoft.com']);
    expect(vm.host[0]).toContain('agent-allow add cdn.playwright.dev');
    expect(vm.calls.at(-1)).toEqual(['agent-kit-packages', 'approve', R1]);
  });

  it('does not approve when the gateway refuses the domains', async () => {
    vm.calls = [];
    vm.hostCode = 1;
    await expect(pk.decideRequest(user, project, R1, 'approve')).rejects.toThrow(/did not add/);
    expect(vm.calls.some((c) => c[1] === 'approve')).toBe(false);
    vm.hostCode = 0;
  });

  it('a project without a target cannot get domains added, but can decline', async () => {
    await expect(pk.decideRequest(user, { ...project, target: undefined }, R1, 'approve')).rejects.toThrow(/no deploy target/);
    vm.calls = [];
    await pk.decideRequest(user, { ...project, target: undefined }, R1, 'deny');
    expect(vm.calls.at(-1)).toEqual(['agent-kit-packages', 'deny', R1]);
  });

  it('refuses odd ids and decisions', async () => {
    await expect(pk.decideRequest(user, project, '../x', 'approve')).rejects.toThrow(/Bad request id/);
    await expect(pk.decideRequest(user, project, R1, 'install')).rejects.toThrow(/Bad decision/);
  });
});
