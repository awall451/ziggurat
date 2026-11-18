import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR is read when the modules load, so point it at a temp folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-fb-'));
process.env.CONSOLE_DATA_DIR = root;
const fb = await import('../src/lib/server/feedback.js');
const { kit } = await import('../src/lib/server/ssh.js');

const project = { id: 'demo', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'nowhere.invalid' } };
const base = path.join(root, 'feedback', 'demo');
const MSG = '20260101T100000Z-o-abc123';
const MSG2 = '20260101T100500Z-o-def456';
const ASK = '20260101T110000Z-a-menu-style';

beforeAll(() => {
  // Two messages as this console would have stored them.
  for (const [id, tier, extra] of [
    [MSG, 'urgent', {}],
    [MSG2, 'note', { inReplyTo: ASK }]
  ]) {
    const dir = path.join(base, 'sent', id);
    fs.mkdirSync(path.join(dir, 'att'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'body.md'), `text of ${id}\n`);
    fs.writeFileSync(path.join(dir, 'att', 'shot.png'), 'png');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, tier, from: 'owner', sentAt: '2026-01-01T10:00:00Z', delivered: true, ...extra }));
  }
  // What a pull of the VM's outbox would bring back (agent-written).
  const out = path.join(base, 'outbox');
  fs.mkdirSync(path.join(out, '.seen', `${MSG}@agent1`), { recursive: true });
  fs.writeFileSync(path.join(out, '.seen', MSG), '');
  fs.mkdirSync(path.join(out, `${MSG}.d`), { recursive: true });
  fs.writeFileSync(path.join(out, `${MSG}.d`, 'fixed.png'), 'png');
  fs.writeFileSync(path.join(out, `${MSG}.d`, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(out, `${MSG}.md`), `Status: planned\nRe: ${MSG}\nDate: 2026-01-01T10:30:00Z\n---\nPlanned for cycle 12.\n`);
  fs.writeFileSync(path.join(out, `${ASK}.md`), `Ziggurat-Ask: 1\nId: ${ASK}\nAsked: 2026-01-01T11:00:00Z\nDefault: Go with a list\n---\nGrid or list?\n`);
  fs.writeFileSync(path.join(out, '20260101T120000Z-a-open-one.md'), 'Ziggurat-Ask: 1\nDefault: Keep it\n---\nKeep the old save format?\n');
  fs.writeFileSync(path.join(out, 'not-an-id.md'), 'Status: done\n---\nignored');
  fs.writeFileSync(path.join(out, '20260101T130000Z-o-forged.md'), 'Status: done\n---\nreply to a message that was never sent');
});

describe('threads', () => {
  it('joins sent messages with the pulled replies and markers', () => {
    const t = fb.threads(project);
    const m = t.messages.find((x) => x.id === MSG);
    expect(m).toMatchObject({ tier: 'urgent', delivered: true, seen: true, nudged: 1, open: true });
    expect(m.reply).toMatchObject({ status: 'planned', text: 'Planned for cycle 12.' });
    expect(m.reply.attachments.map((a) => a.name).sort()).toEqual(['fixed.png', 'page.html']);
    expect(m.attachments).toEqual([{ name: 'shot.png', size: 3 }]);
  });

  it('lists the lead\'s questions and links the owner\'s answer', () => {
    const t = fb.threads(project);
    const answered = t.asks.find((a) => a.id === ASK);
    expect(answered).toMatchObject({ slug: 'menu-style', default: 'Go with a list', text: 'Grid or list?', open: false, answers: [MSG2] });
    expect(t.openAsks).toBe(1);
    expect(fb.openAskCount(project)).toBe(1);
  });

  it('ignores outbox files that are not replies to sent messages or valid questions', () => {
    const t = fb.threads(project);
    expect(t.messages.map((m) => m.id).sort()).toEqual([MSG, MSG2]);
    expect(t.asks).toHaveLength(2);
  });
});

describe('attachments', () => {
  it('serves images inline and everything else as a download', () => {
    expect(fb.attachment(project, 'reply', MSG, 'fixed.png')).toMatchObject({ type: 'image/png', inline: true });
    expect(fb.attachment(project, 'reply', MSG, 'page.html')).toMatchObject({ type: 'application/octet-stream', inline: false });
    expect(fb.attachment(project, 'sent', MSG, 'shot.png')).toMatchObject({ inline: true });
  });

  it('refuses bad ids, names and kinds', () => {
    expect(fb.attachment(project, 'reply', MSG, '../meta.json')).toBeNull();
    expect(fb.attachment(project, 'reply', '../../etc', 'passwd')).toBeNull();
    expect(fb.attachment(project, 'other', MSG, 'fixed.png')).toBeNull();
    expect(fb.attachment(project, 'reply', MSG, 'missing.png')).toBeNull();
  });

  it('refuses a symlink that leaves the folder', () => {
    fs.symlinkSync('/etc/hostname', path.join(base, 'outbox', `${MSG}.d`, 'link.png'));
    expect(fb.attachment(project, 'reply', MSG, 'link.png')).toBeNull();
  });

  it('makes upload names safe', () => {
    expect(fb.safeName('../../etc/passwd')).toBe('passwd');
    expect(fb.safeName('my shot (1).png')).toBe('my_shot__1_.png');
    expect(fb.safeName('..hidden')).toBe('hidden');
    expect(fb.safeName('')).toBe('file');
  });

  it('rejects empty and oversized uploads', () => {
    expect(() => fb.saveDraftAttachment(project, 'a.png', Buffer.alloc(0))).toThrow();
    expect(() => fb.saveDraftAttachment(project, 'a.png', Buffer.alloc(20 * 1024 * 1024 + 1))).toThrow();
    const saved = fb.saveDraftAttachment(project, 'a b.png', Buffer.from('x'));
    expect(saved).toMatchObject({ name: 'a_b.png', size: 1 });
  });
});

describe('sending', () => {
  it('checks tier, text and question id before anything is stored', async () => {
    const user = { name: 'owner' };
    await expect(fb.send(project, user, { tier: 'now', text: 'x' })).rejects.toThrow('Unknown tier');
    await expect(fb.send(project, user, { tier: 'note', text: '   ' })).rejects.toThrow();
    await expect(fb.send(project, user, { tier: 'note', text: 'x', inReplyTo: 'x; id' })).rejects.toThrow('Bad question id');
    await expect(fb.send(project, user, { tier: 'note', text: 'x', attachments: ['../x'] })).rejects.toThrow('Bad attachment');
  });
});

describe('kit calls', () => {
  it('refuses script names and arguments that could carry shell text', () => {
    expect(() => kit(project, 'agent-kit-halt; id', [])).toThrow();
    expect(() => kit(project, '../bin/sh', [])).toThrow();
    expect(() => kit(project, 'agent-kit-halt', ['a b'])).toThrow();
    expect(() => kit(project, 'agent-kit-halt', ['$(id)'])).toThrow();
    expect(() => kit(project, 'agent-kit-halt', ['x;y'])).toThrow();
    expect(() => kit(project, 'agent-kit-caps', ['set', 'LEAD_MODEL', '`id`'])).toThrow();
  });
});
