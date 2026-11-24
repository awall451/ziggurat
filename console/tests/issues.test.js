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

  it('every update the lead kept (kit 0.32) becomes a comment, once, even with no status change', async () => {
    const p4 = { ...project, id: 'demo4' };
    const i = await iss.create(p4, owner, { title: 'd', kind: 'bug', origin: { type: 'gallery', date: '2026-11-17', file: 'vault.png' } }, { deliverNow: false });
    const out = path.join(root, 'issues', 'demo4', '.out');
    fs.mkdirSync(path.join(out, i.id), { recursive: true });
    const at = (s) => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = at(60), t2 = at(120), t3 = at(180);
    fs.writeFileSync(path.join(out, i.id, '20990101T000001Z-aaaaaa.md'), `Status: in_progress\nDate: ${t1}\n---\nGiven to the artist.\n`);
    fs.writeFileSync(path.join(out, i.id, '20990101T000002Z-bbbbbb.md'), `Status: in_progress\nDate: ${t2}\n---\nPlanned for the next cycle.\n`);
    fs.writeFileSync(path.join(out, i.id, '20990101T000003Z-cccccc.md'), `Status: done\nDate: ${t3}\nFixed-in: abc1234\n---\nFixed the flicker.\n`);
    fs.writeFileSync(path.join(out, i.id, 'junk.md'), `Status: done\nDate: ${t3}\n---\nnot one of ours`);
    // The latest is also the single file, as the kit writes it.
    fs.writeFileSync(path.join(out, `${i.id}.md`), `Status: done\nDate: ${t3}\nFixed-in: abc1234\n---\nFixed the flicker.\n`);
    expect(iss.applyUpdates(p4)).toBe(2); // new -> in_progress -> done
    const got = iss.get(p4, i.id);
    expect(got.status).toBe('done');
    expect(got.resolution).toMatchObject({ who: 'lead', fixedIn: 'abc1234', note: 'Fixed the flicker.' });
    expect(got.comments.map((c) => c.text)).toEqual(['Given to the artist.', 'Planned for the next cycle.', 'Fixed the flicker.']);
    expect(iss.applyUpdates(p4)).toBe(0);
    expect(iss.get(p4, i.id).comments).toHaveLength(3);

    // An owner comment later does not hide a later same-status comment from the lead.
    const t4 = at(240);
    fs.writeFileSync(path.join(out, i.id, '20990101T000004Z-dddddd.md'), `Status: done\nDate: ${t4}\n---\nAlso checked on the phone.\n`);
    iss.applyUpdates(p4);
    expect(iss.get(p4, i.id).comments.at(-1)).toMatchObject({ who: 'lead', status: 'done', text: 'Also checked on the phone.' });
  });

  it('an older kit\'s single update file still becomes a comment', async () => {
    const p5 = { ...project, id: 'demo5' };
    const i = await iss.create(p5, owner, { title: 'e', kind: 'bug', origin: { type: 'gallery', date: '2026-11-17', file: 'vault.png' } }, { deliverNow: false });
    const out = path.join(root, 'issues', 'demo5', '.out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${i.id}.md`), `Status: in_progress\nDate: ${new Date(Date.now() + 60_000).toISOString()}\n---\nSeen.\n`);
    iss.applyUpdates(p5);
    expect(iss.get(p5, i.id)).toMatchObject({ status: 'in_progress', comments: [{ who: 'lead', text: 'Seen.' }] });
  });
});

describe('tickets (kit 0.12)', () => {
  // A team on its own VM stub: ssh keeps the remote command and stdin, and a
  // status read says kit 0.12.
  const fake = path.join(root, 'fake-tickets');
  const team = { id: 'tix', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'vm' } };
  const calls = () => fs.readFileSync(path.join(fake, 'log'), 'utf8').trim().split('\n');
  const lastInput = () => fs.readFileSync(path.join(fake, 'stdin'));
  const vm = (code, stderr = '') => {
    fs.writeFileSync(path.join(fake, 'code'), String(code));
    fs.writeFileSync(path.join(fake, 'stderr'), stderr);
  };
  let A, B;

  it('numbers issues one after another, older ones by when they were raised', async () => {
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(
      path.join(fake, 'ssh'),
      `#!/bin/sh\nfor a; do last=$a; done\nif [ "$last" = "bash -s" ]; then cat > /dev/null; echo '{"kitver":"0.12.0","lead":"inactive","control":"stop owner","now":"1"}'; exit 0; fi\n` +
        `cat > ${fake}/stdin\necho "$last" >> ${fake}/log\ncat ${fake}/stderr >&2\nexit $(cat ${fake}/code)\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${fake}:${process.env.PATH}`;
    vm(0);
    const { getStatus } = await import('../src/lib/server/live.js');
    await getStatus(team, { fresh: true });
    // Two issues from before numbers existed, the newer one stored first.
    const dir = path.join(root, 'issues', 'tix');
    for (const [id, at] of [['20260101T120000Z-i-000002', '2026-01-01T12:00:00Z'], ['20260101T110000Z-i-000001', '2026-01-01T11:00:00Z']]) {
      fs.mkdirSync(path.join(dir, id), { recursive: true });
      fs.writeFileSync(path.join(dir, id, 'issue.json'), JSON.stringify({ id, title: id, body: '', kind: 'bug', status: 'new', createdAt: at, updatedAt: at, history: [], delivered: true }));
    }
    const list = iss.list(team);
    expect(list.find((i) => i.id.endsWith('000001')).number).toBe(1);
    expect(list.find((i) => i.id.endsWith('000002')).number).toBe(2);
    A = await iss.create(team, owner, { title: 'Save menu flickers', body: 'x', kind: 'bug', priority: 'high', doneWhen: 'No flicker on load', related: ['#1'] });
    expect(A).toMatchObject({ number: 3, priority: 'high', doneWhen: 'No flicker on load', related: [1], delivered: true });
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-issues put ${A.id} bug --number 3 --priority high`);
    B = await iss.create(team, owner, { title: 'Music too loud', body: '', kind: 'polish' });
    expect(B.number).toBe(4);
    expect(B.priority).toBe('normal');
  });

  it('refuses bad priorities and related issues that do not exist', async () => {
    await expect(iss.create(team, owner, { title: 't', kind: 'bug', priority: 'now' })).rejects.toThrow('Unknown priority');
    await expect(iss.create(team, owner, { title: 't', kind: 'bug', related: ['#99'] })).rejects.toThrow('No issue #99');
    await expect(iss.create(team, owner, { title: 't', kind: 'bug', related: ['1; id'] })).rejects.toThrow('No issue');
  });

  it('an edit goes into the history and to the VM as an amend', async () => {
    const out = await iss.edit(team, owner, A.id, { priority: 'urgent', title: 'Save menu flickers on load' });
    expect(out.pendingAmend).toBe(false);
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-issues amend ${A.id} --kind bug --priority urgent --number 3`);
    const h = iss.get(team, A.id).history.at(-1);
    expect(h.note).toContain('priority: high → urgent');
    expect(h.note).toContain('title:');
    await expect(iss.edit(team, owner, A.id, { kind: 'planned' })).rejects.toThrow('keeps its kind');
    await expect(iss.edit(team, owner, A.id, { related: ['#3'] })).resolves.toBeTruthy(); // itself is dropped
    expect(iss.get(team, A.id).related).toEqual([]);
  });

  it('a change the VM did not take is kept, and can be sent again', async () => {
    vm(255, 'ssh: connect to host vm: No route to host');
    const out = await iss.edit(team, owner, A.id, { body: 'New detail' });
    expect(out.pendingAmend).toBe(true);
    expect(out.error).toContain('No route');
    vm(0);
    const again = await iss.resendAmend(team, A.id);
    expect(again.pendingAmend).toBe(false);
  });

  it('files added later, within the limits', async () => {
    const out = await iss.addFiles(team, owner, A.id, [{ name: 'trace.log', data: Buffer.from('log') }]);
    expect(out.attachments.map((a) => a.name)).toEqual(['trace.log']);
    expect(calls().at(-1)).toMatch(new RegExp(`agent-kit-issues amend ${A.id} --number 3$`));
    expect(lastInput().includes(Buffer.from('att/trace.log'))).toBe(true);
    await expect(iss.addFiles(team, owner, A.id, [{ name: 'trace.log', data: Buffer.from('x') }])).rejects.toThrow('repeated');
    await expect(iss.addFiles(team, owner, A.id, [{ name: '../x', data: Buffer.from('x') }])).rejects.toThrow('Bad');
    const many = Array.from({ length: 8 }, (_, k) => ({ name: `f${k}.txt`, data: Buffer.from('x') }));
    await expect(iss.addFiles(team, owner, A.id, many)).rejects.toThrow('At most 8');
  });

  it('notes go to the VM on stdin', async () => {
    const out = await iss.addNote(team, owner, A.id, 'Still happens $(id)');
    expect(out.notes.at(-1)).toMatchObject({ who: 'owner', text: 'Still happens $(id)', delivered: true });
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-issues note ${A.id} owner`);
    expect(lastInput().toString()).toBe('Still happens $(id)');
    await expect(iss.addNote(team, owner, A.id, '  ')).rejects.toThrow('Write a comment');
  });

  it('the commit of a fix is read from the lead, forged values are dropped', () => {
    const out = path.join(root, 'issues', 'tix', '.out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${A.id}.md`), `Status: done\nRe: ${A.id}\nDate: 2099-01-01T00:00:00Z\nFixed-in: abc1234def\n---\nFixed.\n`);
    fs.writeFileSync(path.join(out, `${B.id}.md`), `Status: done\nRe: ${B.id}\nDate: 2099-01-01T00:00:00Z\nFixed-in: $(id)\n---\nFixed.\n`);
    iss.applyUpdates(team);
    expect(iss.get(team, A.id).resolution.fixedIn).toBe('abc1234def');
    expect(iss.get(team, B.id).resolution.fixedIn).toBeNull();
  });

  it('Fix now: a one-shot job whose text names the issue', async () => {
    const C = await iss.create(team, owner, { title: 'Cursor lost', body: 'The cursor jumps.', kind: 'bug', doneWhen: 'Cursor stays' });
    await iss.addNote(team, owner, C.id, 'Only after a save');
    let text = '';
    const out = await iss.fixNow(owner, team, C.id, async (_u, _p, job) => {
      text = job.text;
      return { id: '20260101T130000Z-o-abcdef', started: true };
    });
    expect(out.started).toBe(true);
    expect(text).toContain(`Fix owner issue #${C.number} (${C.id}): Cursor lost`);
    expect(text).toContain('Done when: Cursor stays');
    expect(text).toContain('Only after a save');
    expect(text).toContain('--commit');
    expect(iss.get(team, C.id).job.id).toBe('20260101T130000Z-o-abcdef');
    await expect(iss.fixNow(owner, team, A.id, async () => ({}))).rejects.toThrow('closed');
  });
});
