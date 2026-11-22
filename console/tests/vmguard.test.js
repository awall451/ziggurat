import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A VM id and address can be handed out again after a VM is deleted. Two
// project entries on one VM, or a VM that names another project, must neither
// show nor act on that team as their own.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-vmg-'));
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
process.env.CONSOLE_CONFIG_DIR = path.join(root, 'config');
fs.mkdirSync(process.env.CONSOLE_CONFIG_DIR, { recursive: true });
const config = await import('../src/lib/server/config.js');
const ssh = await import('../src/lib/server/ssh.js');
const live = await import('../src/lib/server/live.js');

const gw = 'admin@192.0.2.1';
const entry = (id, extra = {}) => ({ id, name: id, target: 'pve', vmid: 303, ssh: { host: '192.0.2.13', user: 'admin', jump: gw }, ...extra });

describe('two entries on one VM', () => {
  it('same VM id on the same target, the same address, or the same alias', () => {
    expect(config.sameVm(entry('a'), entry('b'))).toBe(true);
    expect(config.sameVm(entry('a'), entry('b', { vmid: 304, ssh: { host: '192.0.2.13', user: 'admin', jump: gw } }))).toBe(true);
    expect(config.sameVm(entry('a'), entry('b', { vmid: 304, ssh: { host: '192.0.2.14', user: 'admin', jump: gw } }))).toBe(false);
    expect(config.sameVm(entry('a'), entry('b', { target: 'other', ssh: { host: '192.0.2.14', user: 'admin', jump: gw } }))).toBe(false);
    expect(config.sameVm({ id: 'a', ssh: { alias: 'nocturne' } }, { id: 'b', ssh: { alias: 'nocturne' } })).toBe(true);
    expect(config.sameVm({ id: 'a', ssh: { alias: 'nocturne' } }, { id: 'b', ssh: { alias: 'bitseer' } })).toBe(false);
  });

  it('both are marked, and every kit call and pull for them is refused', async () => {
    fs.writeFileSync(path.join(process.env.CONSOLE_CONFIG_DIR, 'projects.json'), JSON.stringify({ projects: [entry('old-proof'), entry('revview'), { id: 'nocturne', ssh: { alias: 'nocturne' } }] }));
    const list = config.listProjects();
    expect(list.find((p) => p.id === 'old-proof').vmShared).toEqual(['revview']);
    expect(list.find((p) => p.id === 'revview').vmShared).toEqual(['old-proof']);
    expect(list.find((p) => p.id === 'nocturne').vmShared).toBeUndefined();
    const stale = config.getProject('old-proof');
    expect(() => ssh.kit(stale, 'agent-kit-halt', [])).toThrow(/shares its VM with revview/);
    const r = await ssh.pull(stale, ['/var/lib/agent-kit/control'], path.join(root, 'out'));
    expect(r.code).toBe(1);
    const st = await live.getStatus(stale, { fresh: true });
    expect(st).toMatchObject({ reachable: false, vmShared: ['revview'] });
  });

  it('a new entry for a VM that another project has is refused', () => {
    expect(() => config.saveProject(entry('third'))).toThrow(/already belongs to the project old-proof/);
  });
});

describe('a VM that names another project', () => {
  const fake = path.join(root, 'fakebin');
  const team = { id: 'proof', name: 'Publish proof', ssh: { alias: 'vm' }, kit: { state: '/var/lib/agent-kit' } };
  const status = (vmproject) => fs.writeFileSync(path.join(fake, 'status'), JSON.stringify({ kitver: '0.14.1', lead: 'inactive', control: 'run', vmproject, now: '1' }) + '\n');

  beforeAll(() => {
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'ssh'), `#!/bin/sh\ncat > /dev/null\ncat ${fake}/status\n`, { mode: 0o755 });
    process.env.PATH = `${fake}:${process.env.PATH}`;
  });

  it('shows nothing of it, and refuses to act on it', async () => {
    status('revview');
    const st = await live.getStatus(team, { fresh: true });
    expect(st).toMatchObject({ reachable: false, vmMismatch: { expected: 'proof', found: 'revview' } });
    expect(st.error).toMatch(/belongs to the project "revview"/);
    expect(() => ssh.kit(team, 'agent-kit-oneshot', ['show'])).toThrow(/now belongs to the project "revview"/);
  });

  it('works again once the VM names this project', async () => {
    status('proof');
    const st = await live.getStatus(team, { fresh: true });
    expect(st.reachable).toBe(true);
    expect(st.vmProject).toBe('proof');
    expect(ssh.vmRefusal(team)).toBeNull();
  });

  it('a VM that names no project (an old kit) is not blocked', async () => {
    status('');
    const st = await live.getStatus(team, { fresh: true });
    expect(st.reachable).toBe(true);
    expect(ssh.vmRefusal(team)).toBeNull();
  });
});
