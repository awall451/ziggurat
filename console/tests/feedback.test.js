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

  it('keeps a one-shot job out of the tiers a message can carry', async () => {
    const user = { name: 'owner' };
    expect(fb.TIERS).not.toContain(fb.ONESHOT);
    await expect(fb.send(project, user, { tier: 'oneshot', text: 'x' })).rejects.toThrow('Unknown tier');
    await expect(fb.sendOneshot(project, user, { text: '  ' })).rejects.toThrow('Write a message first');
    await expect(fb.sendOneshot(project, user, { text: 'x', attachments: ['../x'] })).rejects.toThrow('Bad attachment');
  });
});

describe('one-shot jobs', () => {
  // `ssh` is replaced by a stub: it answers with the exit code and stderr the
  // test chose, and records the remote command it was given.
  const jobs = { id: 'jobs', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'vm' } };
  const jbase = path.join(root, 'feedback', 'jobs');
  const fake = path.join(root, 'fakebin');
  const user = { name: 'owner' };
  const vm = (code, stderr = '') => {
    fs.writeFileSync(path.join(fake, 'code'), String(code));
    fs.writeFileSync(path.join(fake, 'stderr'), stderr);
  };
  const calls = () => fs.readFileSync(path.join(fake, 'log'), 'utf8').trim().split('\n');
  const jobList = () => fb.threads(jobs).messages.filter((m) => m.tier === 'oneshot');

  beforeAll(() => {
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(
      path.join(fake, 'ssh'),
      // A status read (`bash -s`) answers from its own file; everything else is a kit call.
      `#!/bin/sh\ncat > /dev/null\nfor a; do last=$a; done\necho "$last" >> ${fake}/log\n` +
        `if [ "$last" = "bash -s" ]; then cat ${fake}/status 2>/dev/null; exit 0; fi\n` +
        // With "claim" set, a start runs on the VM although the caller gets no answer.
        `case "$last" in *"agent-kit-oneshot start "*) [ -e ${fake}/claim ] && printf '{"kitver":"0.3.0","lead":"active","oneshot":"%s 2026-01-01T12:00:00+00:00"}\\n' "$(echo "$last" | cut -d" " -f5)" > ${fake}/status;; esac\n` +
        `cat ${fake}/stderr >&2\nexit $(cat ${fake}/code)\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${fake}:${process.env.PATH}`;
  });

  it('tells a refusal by the VM from no answer at all', () => {
    expect(fb.vmSaidNo(2)).toBe(true);
    expect(fb.vmSaidNo(1)).toBe(true);
    expect(fb.vmSaidNo(0)).toBe(false);
    expect(fb.vmSaidNo(127)).toBe(true);
    expect(fb.vmSaidNo(137)).toBe(false);
    expect(fb.vmSaidNo(255)).toBe(false);
    expect(fb.vmSaidNo(-1)).toBe(false);
  });

  it('keeps nothing when the VM refuses, so the same form can start it again', async () => {
    const att = fb.saveDraftAttachment(jobs, 'shot.png', Buffer.from('png'));
    vm(2, 'agent-kit-oneshot: a cycle is still running');
    await expect(fb.sendOneshot(jobs, user, { text: 'Fix the menu', attachments: [att.token] })).rejects.toThrow('a cycle is still running');
    expect(jobList()).toHaveLength(0);
    // The upload is still there: the second try with the same token works.
    vm(0);
    const out = await fb.sendOneshot(jobs, user, { text: 'Fix the menu', attachments: [att.token] });
    expect(out.started).toBe(true);
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-oneshot start ${out.meta.id} owner`);
    expect(jobList()).toMatchObject([{ id: out.meta.id, delivered: true, error: null, attachments: [{ name: 'shot.png' }] }]);
    expect(Date.parse(jobList()[0].startedAt)).toBeGreaterThan(Date.now() - 5000);
    expect(fs.existsSync(path.join(jbase, 'drafts', att.token))).toBe(false);
  });

  it('keeps the job as not started when the VM gives no answer', async () => {
    vm(255, 'ssh: connection lost');
    const out = await fb.sendOneshot(jobs, user, { text: 'Soften the title music' });
    expect(out).toMatchObject({ started: false, refused: false });
    const kept = jobList().find((m) => m.id === out.meta.id);
    expect(kept).toMatchObject({ delivered: false, error: 'ssh: connection lost', open: true });

    // A plain retry must never start a cycle.
    await expect(fb.deliver(jobs, out.meta.id)).rejects.toThrow('started, not sent');

    // Closing it also closes it on the VM, where it may have arrived.
    vm(2, 'agent-kit-inbox: something else went wrong');
    await expect(fb.close(jobs, out.meta.id)).rejects.toThrow('something else went wrong');
    vm(2, `agent-kit-inbox: no such message: ${out.meta.id}`);
    expect(await fb.close(jobs, out.meta.id)).toMatchObject({ closed: true });
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-inbox close ${out.meta.id}`);
    await expect(fb.startOneshot(jobs, out.meta.id)).rejects.toThrow('closed');
  });

  it('starts a stored job again, and keeps it delivered when that fails', async () => {
    vm(0);
    const first = await fb.sendOneshot(jobs, user, { text: 'Thinner dialogue border' });
    const id = first.meta.id;
    vm(2, 'agent-kit-oneshot: the team is not halted. Send an inbox message instead');
    const again = await fb.startOneshot(jobs, id);
    expect(again).toMatchObject({ started: false, refused: true });
    expect(jobList().find((m) => m.id === id)).toMatchObject({ delivered: true, error: null });
    vm(0);
    expect((await fb.startOneshot(jobs, id)).started).toBe(true);

    // Once the lead has answered done, there is nothing to start again.
    fs.mkdirSync(path.join(jbase, 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(jbase, 'outbox', `${id}.md`), `Status: done\nRe: ${id}\n---\nAll three landed.\n`);
    await expect(fb.startOneshot(jobs, id)).rejects.toThrow('already answered');
  });

  it('asks the VM when a start got no clear answer, and believes its status', async () => {
    const controls = await import('../src/lib/server/controls.js');
    const { readAudit } = await import('../src/lib/server/audit.js');

    // The line dropped and the VM shows no such job: kept as not started.
    vm(255, 'ssh: connection lost');
    fs.writeFileSync(path.join(fake, 'status'), JSON.stringify({ kitver: '0.3.0', lead: 'inactive', control: 'stop owner', oneshot: '' }) + '\n');
    const lost = await controls.oneshot(user, jobs, { text: 'Job one', attachments: [] });
    expect(lost).toMatchObject({ ok: true, started: false });
    expect(lost.detail).toContain('kept in the Inbox');
    expect(jobList().find((m) => m.id === lost.id)).toMatchObject({ delivered: false });
    expect(readAudit('jobs')[0]).toMatchObject({ action: 'oneshot-start', ok: false, args: { id: lost.id } });

    // The line dropped, but the VM is running exactly this job: it did start.
    vm(255, 'ssh: connection lost');
    fs.writeFileSync(path.join(fake, 'claim'), '');
    const ran = await controls.oneshot(user, jobs, { text: 'Job two', attachments: [] });
    fs.rmSync(path.join(fake, 'claim'));
    expect(ran).toMatchObject({ ok: true, started: true });
    expect(jobList().find((m) => m.id === ran.id)).toMatchObject({ delivered: true, error: null });
    expect(readAudit('jobs')[0]).toMatchObject({ action: 'oneshot-start', ok: true });

    // A refusal is an error for the caller, and leaves nothing behind.
    vm(2, 'agent-kit-oneshot: the team is not halted. Send an inbox message instead');
    const n = jobList().length;
    await expect(controls.oneshot(user, jobs, { text: 'Job three', attachments: [] })).rejects.toThrow('not halted');
    expect(jobList()).toHaveLength(n);
    await expect(controls.oneshotAgain(user, jobs, ran.id)).rejects.toThrow('not halted');
  });

  it('only starts one-shot jobs', async () => {
    await expect(fb.startOneshot(project, MSG)).rejects.toThrow('No such one-shot job');
    await expect(fb.startOneshot(jobs, '../../etc')).rejects.toThrow('Bad message id');
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
