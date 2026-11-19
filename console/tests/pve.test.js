import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-pve-'));
process.env.CONSOLE_DATA_DIR = root;
const { parseInspect, inspect } = await import('../src/lib/server/pve.js');
const { hostArgs, setHostKey, sshArgs } = await import('../src/lib/server/ssh.js');
const { validateTarget } = await import('../src/lib/server/schema.js');

const t = validateTarget({
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
  criticalVmids: [202]
});

// What the fixed script prints on a host (made-up guests).
const OUT = `@@qm
      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       202 files                running    8192              20.00 1001
       300 first-game           stopped    12288             40.00 0
       301 second-game          running    16384             60.00 1002
      9000 ubuntu-tpl           stopped    2048               3.50 0
@@rc 0
@@pct
VMID       Status     Lock         Name
100        running                 tools
110        running                 agent-gw
@@rc 0
@@bridge
7: vmbr1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP
@@rc 0
@@gateway
status: running
@@rc 0
@@template
cores: 2
name: ubuntu-tpl
template: 1
@@rc 0
@@snippets
{"content":"iso,vztmpl,snippets","path":"/var/lib/vz","storage":"local","type":"dir"}
@@rc 0
@@storage
Name             Type     Status           Total            Used       Available        %
local-lvm     lvmthin     active       300000000       245310000        54690000   81.77%
@@rc 0
@@mem
               total        used        free      shared  buff/cache   available
Mem:           60000       34000       23000         100        1500       24500
Swap:           8000           0        8000
@@rc 0
@@version
pve-manager/7.3-3/abcdef12 (running kernel: 5.15.0-1-pve)
@@rc 0
`;

describe('parseInspect', () => {
  const r = parseInspect(OUT, t);

  it('passes a healthy target and flags the full pool as a warning', () => {
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([['bridge', true], ['gateway', true], ['template', true], ['snippets', true], ['pool', true], ['vmids', true]]);
    expect(r.pool).toMatchObject({ pct: 81.77, level: 'warn' });
    expect(r.checks.find((c) => c.id === 'pool').warn).toBe(true);
    expect(r.memFreeMb).toBe(24500);
  });

  it('lists the guests and picks the next free id and address', () => {
    expect(r.guests.map((g) => `${g.kind}${g.vmid}`)).toEqual(['ct100', 'ct110', 'vm202', 'vm300', 'vm301', 'vm9000']);
    expect(r.guests.find((g) => g.vmid === 202).critical).toBe(true);
    expect(r.guests.find((g) => g.vmid === 110).name).toBe('agent-gw');
    expect(r.next).toEqual({ vmid: 302, ip: '10.66.0.12' });
  });

  it('never offers a protected id', () => {
    const p = parseInspect(OUT, { ...t, criticalVmids: [302, 303] });
    expect(p.next.vmid).toBe(304);
  });

  it('blocks at the block line and fails each missing piece', () => {
    const full = parseInspect(OUT.replace('81.77%', '93.10%'), t);
    expect(full.ok).toBe(false);
    expect(full.pool.level).toBe('block');
    const broken = parseInspect(
      OUT.replace('status: running', 'status: stopped').replace('template: 1\n', '').replace('iso,vztmpl,snippets', 'iso,vztmpl').replace(/@@bridge\n.*\n@@rc 0/, '@@bridge\nDevice "vmbr1" does not exist.\n@@rc 1'),
      t
    );
    expect(broken.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['bridge', 'gateway', 'template', 'snippets']);
  });

  it('copes with empty output', () => {
    const none = parseInspect('', t);
    expect(none.ok).toBe(false);
    expect(none.guests).toEqual([]);
  });
});

describe('inspect', () => {
  it('does not connect without a saved host key', async () => {
    const r = await inspect(t, { fresh: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/host key/i);
  });

  it('reports bad settings instead of throwing', async () => {
    const r = await inspect({ ...t, bridge: 'eth0' }, { fresh: true });
    expect(r.error).toMatch(/bridge/);
  });
});

describe('ssh to hosts the console defines', () => {
  const KEY = 'ssh-ed25519 ' + 'A'.repeat(68);
  const file = path.join(root, 'ssh', 'known_hosts');

  it('stores one key per host and replaces it', () => {
    setHostKey('10.66.0.13', KEY);
    setHostKey('192.0.2.10', KEY);
    setHostKey('10.66.0.13', 'ssh-ed25519 ' + 'B'.repeat(68));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toEqual([`192.0.2.10 ${KEY}`, `10.66.0.13 ssh-ed25519 ${'B'.repeat(68)}`]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a key line that could add another host', () => {
    expect(() => setHostKey('10.66.0.13', `${KEY}\n* ${KEY}`)).toThrow();
    expect(() => setHostKey('*', KEY)).toThrow();
  });

  it('checks host keys strictly and never forwards the agent', () => {
    const { args, dest } = hostArgs({ host: '192.0.2.10', user: 'root' });
    expect(dest).toBe('root@192.0.2.10');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('ForwardAgent=no');
    expect(args.find((a) => a.startsWith('UserKnownHostsFile='))).toContain(file);
    expect(args.some((a) => a.startsWith('ProxyCommand'))).toBe(false);
    expect(args).not.toContain('-J');
  });

  it('gives the jump hop the same strict options', () => {
    const { args } = hostArgs({ host: '10.66.0.13', user: 'admin', jump: 'admin@192.0.2.20:2222' });
    const proxy = args.find((a) => a.startsWith('ProxyCommand='));
    expect(proxy).toContain('StrictHostKeyChecking=yes');
    expect(proxy).toContain(`'UserKnownHostsFile=${file} `);
    expect(proxy).toMatch(/-p 2222 -W %h:%p admin@192\.0\.2\.20$/);
  });

  it('refuses values ssh would read as options', () => {
    expect(() => hostArgs({ host: '-oProxyCommand=id', user: 'root' })).toThrow();
    expect(() => hostArgs({ host: '192.0.2.10', user: 'root', jump: '-oProxyCommand=id' })).toThrow();
    expect(() => hostArgs({ host: '192.0.2.10', user: 'root', jump: 'a@b; id' })).toThrow();
    expect(() => sshArgs({ id: 'x', ssh: { alias: '-oProxyCommand=id' } })).toThrow();
    expect(() => sshArgs({ id: 'x', ssh: { alias: 'ok', jump: '-oProxyCommand=id' } })).toThrow();
  });
});
