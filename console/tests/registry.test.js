import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The folders are read when the modules load, so set them first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-reg-'));
process.env.CONSOLE_CONFIG_DIR = path.join(root, 'config');
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
process.env.FLEET_DATA = path.join(root, 'fleet');
process.env.CONSOLE_DEPLOY = '1';
process.env.CONSOLE_NO_PULL = '1';
const registry = await import('../src/lib/server/registry.js');
const config = await import('../src/lib/server/config.js');
const { readAudit } = await import('../src/lib/server/audit.js');

const user = { name: 'tester' };
const target = {
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
  adminUser: 'admin'
};
const status = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.status;
  }
  return 0;
};

describe('targets', () => {
  it('adds, replaces and removes an entry', () => {
    expect(registry.storeTarget(user, target).pveUser).toBe('root');
    expect(status(() => registry.storeTarget(user, target))).toBe(409);
    registry.storeTarget(user, { ...target, name: 'Home lab', criticalVmids: [202] }, 'homelab');
    expect(registry.getTarget('homelab')).toMatchObject({ name: 'Home lab', criticalVmids: [202] });
    // A replace drops what is no longer given.
    registry.storeTarget(user, target, 'homelab');
    expect(registry.getTarget('homelab').criticalVmids).toEqual([]);
    registry.removeTarget(user, 'homelab');
    expect(status(() => registry.getTarget('homelab'))).toBe(404);
    expect(status(() => registry.removeTarget(user, 'homelab'))).toBe(404);
  });

  it('refuses a bad entry and a changed id', () => {
    expect(status(() => registry.storeTarget(user, { ...target, bridge: 'eth0' }))).toBe(400);
    registry.storeTarget(user, target);
    expect(status(() => registry.storeTarget(user, { ...target, id: 'other' }, 'homelab'))).toBe(400);
    expect(status(() => registry.storeTarget(user, { ...target, id: 'missing' }, 'missing'))).toBe(404);
  });

  it('writes each change to the audit log', () => {
    const actions = readAudit().map((r) => r.action);
    expect(actions).toContain('target-add');
    expect(actions).toContain('target-save');
    expect(actions).toContain('target-remove');
  });
});

describe('projects', () => {
  it('stores the entry as given and serves it with defaults', () => {
    registry.storeProject(user, { id: 'demo', name: 'Demo', ssh: { alias: 'demo' }, paths: { fleet: path.join(root, 'fleet', 'demo') } });
    expect(registry.getProject('demo')).toEqual({ id: 'demo', name: 'Demo', ssh: { alias: 'demo' }, paths: { fleet: path.join(root, 'fleet', 'demo') } });
    expect(config.getProject('demo').kit.workspace).toBe('/home/agent/demo');
  });

  it('keeps pulled data out of the config folder', () => {
    expect(status(() => registry.storeProject(user, { id: 'bad', ssh: { alias: 'bad' }, paths: { fleet: path.join(root, 'config') } }))).toBe(400);
    expect(status(() => registry.storeProject(user, { id: 'bad', ssh: { alias: 'bad' }, paths: { fleet: '/etc' } }))).toBe(400);
  });

  it('removes only the entry', () => {
    const before = fs.readFileSync(path.join(root, 'config', 'projects.json'), 'utf8');
    expect(before).toContain('"demo"');
    registry.removeProject(user, 'demo');
    expect(config.getProject('demo')).toBe(null);
    expect(status(() => registry.removeProject(user, 'demo'))).toBe(404);
    expect(readAudit('demo').map((r) => r.action)).toEqual(['project-remove', 'project-add']);
  });
});
