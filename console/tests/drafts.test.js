import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-dr-'));
process.env.CONSOLE_DATA_DIR = path.join(root, 'data');
process.env.CONSOLE_CONFIG_DIR = path.join(root, 'config');
process.env.CONSOLE_DEPLOY = '1';
const drafts = await import('../src/lib/server/drafts.js');
const config = await import('../src/lib/server/config.js');
const { readAudit } = await import('../src/lib/server/audit.js');

const user = { name: 'tester' };
const KEY = 'ssh-ed25519 ' + 'A'.repeat(68);
const target = {
  id: 'homelab', pveHost: '192.0.2.10', pveHostKey: KEY, bridge: 'vmbr1', subnetPrefix: '10.66.0', gatewayVmid: 110, gatewayLanIp: '192.0.2.20',
  lanGateway: '192.0.2.1', templateVmid: 9000, vmidMin: 300, vmidMax: 399, storage: 'local-lvm', adminUser: 'admin', criticalVmids: []
};
const DOCS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'docs');
const example = () => JSON.parse(fs.readFileSync(path.join(DOCS, 'new-project.example.json'), 'utf8'));

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  config.saveTarget(target);
});

describe('drafts', () => {
  it('stores the documented example, with the id made from the name and the first target', () => {
    const out = drafts.putDraft(user, example());
    expect(out.id).toMatch(/^[0-9]{8}T[0-9]{6}Z-d-[a-f0-9]{6}$/);
    expect(out.url).toBe(`/new?draft=${out.id}`);
    expect(out.warnings).toEqual([]);
    const d = drafts.getDraft(out.id);
    expect(d.request).toMatchObject({ id: 'example-tool', target: 'homelab', source: { kind: 'template', id: 'small' }, plan: { on: true, maxProposals: 5 } });
    expect(d.request.docs.map((x) => x.name)).toEqual(['PLAN.md', 'FORMATS.md']);
    expect(drafts.listDrafts().map((x) => x.id)).toContain(out.id);
    expect(readAudit('example-tool').map((r) => r.action)).toContain('draft-add');
  });

  it('refuses what the form refuses', () => {
    const bad = (over) => () => drafts.putDraft(user, { ...example(), ...over });
    expect(bad({ goal: undefined })).toThrow(/goal/);
    expect(bad({ docs: [{ name: '../x.md', text: '' }] })).toThrow(/docs/);
    expect(bad({ plan: { on: true, maxProposals: 12 } })).toThrow(/plan/);
    expect(bad({ source: { kind: 'shell', id: 'x' } })).toThrow(/source/);
    expect(bad({ target: 'elsewhere' })).toThrow(/target/);
    expect(bad({ surprise: 1 })).toThrow();
    expect(() => drafts.putDraft(user, [])).toThrow(/JSON object/);
  });

  it('warns about an id that is already a project', () => {
    config.saveProject({ id: 'example-tool', name: 'x', ssh: { host: '10.66.0.20', user: 'admin' } }, { replace: true });
    expect(drafts.putDraft(user, example()).warnings[0]).toMatch(/already exists/);
  });

  it('can be deleted, and odd ids are refused', () => {
    const { id } = drafts.putDraft(user, { ...example(), name: 'Another one' });
    expect(drafts.deleteDraft(user, id)).toEqual({ ok: true });
    expect(() => drafts.getDraft(id)).toThrow(/No such draft/);
    expect(() => drafts.getDraft('../../etc/passwd')).toThrow(/Bad draft id/);
  });

  it('the schema documents exactly the fields the form takes', async () => {
    const schema = JSON.parse(fs.readFileSync(path.join(DOCS, 'new-project.schema.json'), 'utf8'));
    const src = fs.readFileSync(path.resolve(DOCS, '..', 'src', 'lib', 'server', 'schema.js'), 'utf8');
    const keys = JSON.parse(/const DEPLOY_KEYS = (\[[^\]]+\])/.exec(src)[1].replace(/'/g, '"'));
    expect(Object.keys(schema.properties).sort()).toEqual([...keys].sort());
  });
});
