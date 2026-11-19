import { describe, it, expect } from 'vitest';
import { validateTarget, validateProject, targetNet, isIPv4 } from '../src/lib/server/schema.js';

const KEY = 'ssh-ed25519 ' + 'A'.repeat(68);
const target = (over = {}) => ({
  id: 'homelab',
  pveHost: '192.0.2.10',
  bridge: 'vmbr1',
  subnetPrefix: '10.66.0',
  gatewayVmid: 110,
  gatewayLanIp: '192.0.2.20',
  lanGateway: '192.0.2.1',
  templateVmid: 9000,
  vmidMin: 300,
  vmidMax: 399,
  storage: 'local-lvm',
  adminUser: 'admin',
  ...over
});
const project = (over = {}) => ({ id: 'demo', ssh: { alias: 'demo' }, ...over });

describe('validateTarget', () => {
  it('fills the defaults', () => {
    const t = validateTarget(target());
    expect(t).toMatchObject({ pveUser: 'root', pveLanIp: '192.0.2.10', snippetsStorage: 'local', snippetsDir: '/var/lib/vz/snippets', poolWarnPct: 80, poolBlockPct: 90, criticalVmids: [], bastion: '', name: 'homelab' });
  });

  it('keeps and sorts the protected ids', () => {
    expect(validateTarget(target({ criticalVmids: [202, 100, 202] })).criticalVmids).toEqual([100, 202]);
  });

  it('derives the sandbox addresses', () => {
    const n = targetNet(validateTarget(target()));
    expect(n.gatewayBridgeIp).toBe('10.66.0.1');
    expect(n.proxyUrl).toBe('http://10.66.0.1:3128');
    expect(n.vmIp(303)).toBe('10.66.0.13');
  });

  it('accepts a host key and a jump host', () => {
    const t = validateTarget(target({ pveHostKey: KEY, bastion: 'admin@jump.example.net:2222' }));
    expect(t.pveHostKey).toBe(KEY);
  });

  const bad = [
    ['an option as the host', { pveHost: '-oProxyCommand=id' }],
    ['a host with a space', { pveHost: 'pve; id' }],
    ['an option as the jump host', { bastion: '-J evil' }],
    ['a login with shell text', { pveUser: 'root;id' }],
    ['a host key with a comment', { pveHostKey: `${KEY} root@pve` }],
    ['a host key with a host name in front', { pveHostKey: `192.0.2.10 ${KEY}` }],
    ['a bridge that is not vmbrN', { bridge: 'vmbr1; reboot' }],
    ['a subnet with four numbers', { subnetPrefix: '10.66.0.0' }],
    ['a subnet number over 255', { subnetPrefix: '10.660.0' }],
    ['a storage name with a slash', { storage: 'local/../x' }],
    ['a relative snippets folder', { snippetsDir: 'snippets' }],
    ['a snippets folder with shell text', { snippetsDir: '/var/lib/vz/$(id)' }],
    ['a range turned around', { vmidMin: 399, vmidMax: 300 }],
    ['a range with more ids than addresses', { vmidMin: 300, vmidMax: 600 }],
    ['a VM id as text with letters', { gatewayVmid: '110a' }],
    ['protected ids that are not numbers', { criticalVmids: ['202; id'] }],
    ['warn above block', { poolWarnPct: 95, poolBlockPct: 90 }],
    ['an unknown field', { extraVars: 'x=1' }],
    ['a missing admin login', { adminUser: '' }]
  ];
  for (const [what, over] of bad) it(`refuses ${what}`, () => expect(() => validateTarget(target(over))).toThrow());

  it('needs the LAN address when the host is a name', () => {
    expect(() => validateTarget(target({ pveHost: 'pve.example.net' }))).toThrow(/pveLanIp/);
    expect(validateTarget(target({ pveHost: 'pve.example.net', pveLanIp: '192.0.2.10' })).pveLanIp).toBe('192.0.2.10');
  });

  it('reports every problem at once', () => {
    expect(() => validateTarget(target({ bridge: 'eth0', storage: '' }))).toThrow(/bridge: .*; storage: /);
  });

  it('refuses anything that is not an object', () => {
    for (const v of [null, [], 'x', 3]) expect(() => validateTarget(v)).toThrow();
  });
});

describe('validateProject', () => {
  it('keeps only what was given', () => {
    expect(validateProject(project())).toEqual({ id: 'demo', ssh: { alias: 'demo' } });
  });

  it('accepts a full entry', () => {
    const p = validateProject(
      project({
        name: 'Demo',
        description: 'A demo team',
        theme: 'plain',
        accent: '#4fd8ff',
        hidden: true,
        pull: false,
        ssh: { host: '10.66.0.13', user: 'admin', jump: 'admin@192.0.2.20' },
        kit: { leadUnit: 'agent-kit-lead', workspace: '/home/agent/demo' },
        paths: { fleet: '/data/fleet/demo' },
        agentAliases: { 'old-builder': 'builder' },
        target: 'homelab',
        vmid: 303
      }),
      { allowed: ['/data'], forbidden: ['/config'] }
    );
    expect(p.ssh).toEqual({ host: '10.66.0.13', user: 'admin', jump: 'admin@192.0.2.20' });
    expect(p.vmid).toBe(303);
  });

  const bad = [
    ['no way to reach the VM', { ssh: {} }],
    ['an option as the alias', { ssh: { alias: '-oProxyCommand=id' } }],
    ['an option as the host', { ssh: { host: '-lroot' } }],
    ['an option as the jump host', { ssh: { alias: 'demo', jump: '-oProxyCommand=id' } }],
    ['a relative key path', { ssh: { alias: 'demo', key: 'id_ed25519' } }],
    ['an unknown ssh field', { ssh: { alias: 'demo', options: '-v' } }],
    ['a workspace with shell text', { kit: { workspace: '/home/agent/$(id)' } }],
    ['a unit name with a space', { kit: { leadUnit: 'a b' } }],
    ['a theme with a path', { theme: '../x' }],
    ['a colour name', { accent: 'red' }],
    ['hidden as text', { hidden: 'yes' }],
    ['aliases pointing at odd names', { agentAliases: { a: 'b c' } }],
    ['an unknown field', { command: 'id' }],
    ['a bad id', { id: 'Demo Project' }]
  ];
  for (const [what, over] of bad) it(`refuses ${what}`, () => expect(() => validateProject(project(over))).toThrow());

  it('keeps pulled data inside the data folders', () => {
    const roots = { allowed: ['/data', '/fleet'], forbidden: ['/config'] };
    expect(() => validateProject(project({ paths: { fleet: '/etc/cron.d' } }), roots)).toThrow(/paths.fleet/);
    expect(() => validateProject(project({ paths: { transcripts: '/data/../config/x' } }), roots)).toThrow(/paths.transcripts/);
    expect(() => validateProject(project({ paths: { fleet: '/config/fleet' } }), { forbidden: ['/config'] })).toThrow(/config folder/);
    expect(validateProject(project({ paths: { fleet: '/fleet/demo' } }), roots).paths.fleet).toBe('/fleet/demo');
  });
});

describe('isIPv4', () => {
  it('knows an address', () => {
    expect(isIPv4('10.66.0.13')).toBe(true);
    for (const v of ['10.66.0', '10.66.0.256', '10.66.0.1 ', 'a.b.c.d', null]) expect(isIPv4(v)).toBe(false);
  });
});
