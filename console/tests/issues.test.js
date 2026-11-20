import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR is read when the modules load, so point it at a temp folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-iss-'));
process.env.CONSOLE_DATA_DIR = root;
const iss = await import('../src/lib/server/issues.js');

const project = { id: 'demo', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'nowhere.invalid' } };
const owner = { name: 'owner' };
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('rest')]);
const shot = path.join(root, 'src-shot.png');
fs.writeFileSync(shot, PNG);

const raise = (extra = {}) =>
  iss.create(
    project,
    owner,
    { title: 'Names box overlaps victory box', body: 'See circle', kind: 'bug', origin: { type: 'gallery', date: '2026-11-17', file: '07-level-up.png' }, markup: [{ type: 'ellipse', x: 0.1, y: 0.2, w: 0.5, h: 0.4 }], shot, markupPng: PNG, ...extra },
    { deliverNow: false }
  );

describe('screenKey', () => {
  it('ties a note to the screen, not the file', () => {
    expect(iss.screenKey('07-level-up.png')).toBe('level-up');
    expect(iss.screenKey('12-Level_Up.png')).toBe('level-up');
    expect(iss.screenKey('crag-road.png')).toBe('crag-road');
  });
});

describe('issues raised on the Issues page', () => {
  const upload = (extra = {}) =>
    iss.create(project, owner, { title: 'Save menu forgets the cursor', body: 'Steps in the log', kind: 'bug', origin: { type: 'upload', name: 'My shot (2).PNG' }, shotPng: PNG, ...extra }, { deliverNow: false });

  it('keeps the picture, its markup and the other files', async () => {
    const i = await upload({ markup: [{ type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5 }], markupPng: PNG, attachments: [{ name: 'crash.log', data: Buffer.from('trace') }] });
    expect(i.origin).toEqual({ type: 'upload', name: 'My-shot-2-.PNG' });
    expect(iss.image(project, i.id, 'shot.png')).toBeTruthy();
    expect(iss.image(project, i.id, 'markup.png')).toBeTruthy();
    expect(fs.readFileSync(iss.attachment(project, i.id, 'crash.log'), 'utf8')).toBe('trace');
    expect(iss.attachment(project, i.id, '../issue.json')).toBeNull();
    expect(i.attachments).toEqual([{ name: 'crash.log', size: 5 }]);
    const text = iss.issueText(i);
    expect(text).toMatch(/Picture: shot.png \(attached by the owner as My-shot-2-.PNG\)/);
    expect(text).toMatch(/Attachments \(in att\/\): crash.log/);
    expect(iss.list(project).find((x) => x.id === i.id)).toMatchObject({ hasShot: true, hasMarkup: true });
  });

  it('works with no picture at all', async () => {
    const i = await iss.create(project, owner, { title: 'More save slots', body: '', kind: 'idea', origin: null }, { deliverNow: false });
    expect(i).toMatchObject({ origin: null, attachments: [] });
    expect(iss.image(project, i.id, 'shot.png')).toBeNull();
  });

  it('refuses files the VM would refuse', async () => {
    await expect(upload({ shotPng: Buffer.from('jpeg bytes') })).rejects.toThrow(/PNG/);
    await expect(upload({ attachments: [{ name: '.hidden', data: Buffer.from('x') }] })).rejects.toThrow(/name/);
    await expect(upload({ attachments: [{ name: 'a.txt', data: Buffer.from('x') }, { name: 'a.txt', data: Buffer.from('y') }] })).rejects.toThrow(/name/);
    await expect(upload({ attachments: Array.from({ length: 9 }, (_, n) => ({ name: `f${n}.txt`, data: Buffer.from('x') })) })).rejects.toThrow(/At most 8/);
    await expect(upload({ attachments: [{ name: 'big.bin', data: Buffer.alloc(16 * 1024 * 1024) }] })).rejects.toThrow(/15 MB/);
    await expect(upload({ attachments: [{ name: 'empty.txt', data: Buffer.alloc(0) }] })).rejects.toThrow(/empty/);
  });

  it('makes names the VM accepts', () => {
    expect(iss.safeName('C:\\Users\\me\\shot 1.png')).toBe('shot-1.png');
    expect(iss.safeName('../../etc/passwd')).toBe('passwd');
    expect(iss.safeName('...')).toBe('');
    expect(iss.safeName('Ünïcode name.txt')).toBe('n-code-name.txt');
  });
});

describe('create and list', () => {
  it('stores the issue, the shot and the markup', async () => {
    const i = await raise();
    expect(i).toMatchObject({ status: 'new', kind: 'bug', origin: { screen: 'level-up' }, delivered: false });
    expect(iss.image(project, i.id, 'shot.png')).toBeTruthy();
    expect(iss.image(project, i.id, 'markup.png')).toBeTruthy();
    expect(iss.image(project, i.id, '../issue.json')).toBeNull();
    expect(iss.list(project, { screen: 'level-up' }).map((x) => x.id)).toContain(i.id);
    expect(iss.list(project, { screen: 'vault' })).toEqual([]);
  });

  it('refuses bad input', async () => {
    await expect(raise({ title: ' ' })).rejects.toThrow(/title/);
    await expect(raise({ kind: 'feature' })).rejects.toThrow(/kind/);
    await expect(raise({ origin: { type: 'gallery', date: '2026-11-17', file: '../x.png' } })).rejects.toThrow(/screenshot/);
    await expect(raise({ markupPng: Buffer.from('not a png') })).rejects.toThrow(/PNG/);
  });

  it('cleans markup shapes', () => {
    const m = iss.cleanMarkup([{ type: 'rect', x: -1, y: 2, w: 0.5, h: 'x', color: 'red' }, { type: 'path', points: [[0, 0], [1, 1]] }, { type: 'script' }]);
    expect(m).toEqual([
      { type: 'rect', color: '#ff3b3b', x: 0, y: 1, w: 0.5, h: 0 },
      { type: 'path', color: '#ff3b3b', points: [[0, 0], [1, 1]] }
    ]);
  });

  it('writes a plain-text ticket for the lead', async () => {
    const i = await raise();
    const t = iss.issueText(i);
    expect(t).toMatch(/^# Names box overlaps victory box/);
    expect(t).toMatch(/Screen: level-up/);
    expect(t).toMatch(/markup.png/);
  });
});

describe('status', () => {
  it('owner moves update the screen index', async () => {
    const p2 = { ...project, id: 'demo2' };
    const a = await iss.create(p2, owner, { title: 'a', kind: 'bug', origin: { type: 'gallery', date: '2026-11-17', file: 'vault.png' } }, { deliverNow: false });
    await iss.create(p2, owner, { title: 'b', kind: 'idea', origin: { type: 'gallery', date: '2026-11-18', file: '02-vault.png' } }, { deliverNow: false });
    expect(iss.screenIndex(p2)).toEqual({ vault: { open: 2, resolved: 0 } });
    const moved = await iss.setStatus(p2, owner, a.id, 'done', 'looks fine now');
    expect(moved.resolution).toMatchObject({ who: 'owner', note: 'looks fine now' });
    expect(iss.screenIndex(p2)).toEqual({ vault: { open: 1, resolved: 1 } });
    expect(iss.openCount(p2)).toBe(1);
    await expect(iss.setStatus(p2, owner, a.id, 'closed')).rejects.toThrow(/status/);
  });

  it('applies the lead\'s updates once, and an owner change made later wins', async () => {
    const p3 = { ...project, id: 'demo3' };
    const i = await iss.create(p3, owner, { title: 'c', kind: 'bug', origin: { type: 'gallery', date: '2026-11-17', file: 'vault.png' } }, { deliverNow: false });
    const out = path.join(root, 'issues', 'demo3', '.out');
    fs.mkdirSync(out, { recursive: true });
    const later = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(path.join(out, `${i.id}.md`), `Status: done\nDate: ${later}\nFixed-shot: shots/2026-11-19/vault.png\n---\nFixed by the artist.\n`);
    fs.writeFileSync(path.join(out, '20260101T000000Z-i-ffffff.md'), 'Status: done\nDate: 2026-01-01T00:00:00Z\n---\nno such issue');
    fs.writeFileSync(path.join(out, 'junk.md'), 'Status: done\n---\n');
    expect(iss.applyUpdates(p3)).toBe(1);
    const done = iss.get(p3, i.id);
    expect(done).toMatchObject({ status: 'done', resolution: { who: 'lead', fixedShot: 'shots/2026-11-19/vault.png', note: 'Fixed by the artist.' } });
    expect(iss.applyUpdates(p3)).toBe(0);

    // Owner reopens after the lead's update; the old update is not re-applied.
    await new Promise((r) => setTimeout(r, 5));
    const reopened = await iss.setStatus(p3, owner, i.id, 'new', 'still broken');
    expect(reopened.status).toBe('new');
    iss.applyUpdates(p3);
    expect(iss.get(p3, i.id).status).toBe('new');
  });
});
