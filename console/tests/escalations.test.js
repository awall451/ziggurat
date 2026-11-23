import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR is read when the modules load, so point it at a temp folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-esc-'));
process.env.CONSOLE_DATA_DIR = root;
const esc = await import('../src/lib/server/escalations.js');
const { summary } = await import('../src/lib/server/aggregate.js');

const fleet = path.join(root, 'fleet');
const project = { id: 'demo', paths: { fleet } };
const file = path.join(fleet, 'notes', 'agents', 'ESCALATIONS.md');
const ASK = '20260101T110000Z-a-wider-scope';
const ASK2 = '20260101T120000Z-a-second';
const write = (text) => fs.writeFileSync(file, text);
const open = () => esc.escalationList(project).filter((e) => e.open).map((e) => e.title);

function ask(id) {
  const out = path.join(root, 'feedback', 'demo', 'outbox');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${id}.md`), `Ziggurat-Ask: 1\nId: ${id}\nAsked: 2026-01-01T11:00:00Z\nDefault: Keep it\n---\nWiden the scope?\n`);
}
function answer(askId, id = '20260101T113000Z-o-abc123') {
  const dir = path.join(root, 'feedback', 'demo', 'sent', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'body.md'), 'Yes.\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, tier: 'note', from: 'owner', sentAt: '2026-01-01T11:30:00Z', delivered: true, inReplyTo: askId }));
}

beforeEach(() => {
  for (const d of ['feedback', 'escalations', 'fleet']) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
});

describe('escalations', () => {
  it('reads one entry per heading, as data', () => {
    const list = esc.parseEscalations('# ESCALATIONS\n\nintro\n\n## One: a thing\n\nBody **one**.\n\n### detail\n\nmore\n\n## Two\n');
    expect(list.map((e) => [e.title, e.resolved])).toEqual([['One: a thing', false], ['Two', false]]);
    expect(list[0].body).toBe('Body **one**.\n\n### detail\n\nmore');
    expect(list[0].key).toMatch(/^[a-f0-9]{16}$/);
    expect(esc.parseEscalations('')).toEqual([]);
  });

  it('does not count an entry the team marked resolved', () => {
    write('# E\n\n## one\n\ntext\n\n## two\n\nResolved: 2026-01-02, the owner said yes.\n\n## three\n\n- **Status:** resolved\n\n## Resolved: four\n\n## five\n\nThis is not resolved: it only says the word.\n');
    expect(open()).toEqual(['one', 'five']);
    expect(esc.escalationList(project).find((e) => e.title === 'two').closed).toEqual({ how: 'resolved' });
    expect(summary(project).escalations).toBe(2);
  });

  it('stops counting an entry the owner dismissed, at once', () => {
    write('# E\n\n## one\n\n## two\n');
    const [one] = esc.escalationList(project);
    esc.closeEscalation(project, one.key, 'dismissed', { by: 'owner' });
    expect(open()).toEqual(['two']);
    expect(summary(project).escalations).toBe(1);
    expect(esc.escalationList(project)[0].closed).toMatchObject({ how: 'dismissed', by: 'owner' });
    // Taken back: it waits again.
    esc.reopenEscalation(project, one.key);
    expect(open()).toEqual(['one', 'two']);
  });

  it('counts an entry again when the team rewords it, and forgets marks of removed entries', () => {
    write('# E\n\n## one\n\n## two\n');
    const [one, two] = esc.escalationList(project);
    esc.closeEscalation(project, one.key, 'answered', { messageId: '20260101T113000Z-o-abc123' });
    write('# E\n\n## one, asked again\n\n## two\n');
    expect(open()).toEqual(['one, asked again', 'two']);
    esc.closeEscalation(project, two.key, 'dismissed');
    const kept = JSON.parse(fs.readFileSync(path.join(root, 'escalations', 'demo.json'), 'utf8'));
    expect(Object.keys(kept)).toEqual([two.key]);
  });

  it('closes an entry with the inbox question it names', () => {
    write(`# E\n\n## scope\n\nAlso asked in the inbox: ${ASK}.\n\n## other\n\nNames a question nobody asked: 20260101T000000Z-a-unknown\n`);
    ask(ASK);
    expect(open()).toEqual(['scope', 'other']);
    answer(ASK);
    expect(open()).toEqual(['other']);
    expect(esc.escalationList(project)[0].closed).toEqual({ how: 'question', ask: ASK });
  });

  it('keeps an entry open while one of the questions it names is open', () => {
    write(`# E\n\n## scope\n\n${ASK} and ${ASK2}\n`);
    ask(ASK);
    ask(ASK2);
    answer(ASK);
    expect(open()).toEqual(['scope']);
  });

  it('refuses a key that is not in the file', () => {
    write('# E\n\n## one\n');
    expect(() => esc.closeEscalation(project, '../../etc', 'dismissed')).toThrow('Bad escalation id');
    expect(() => esc.closeEscalation(project, 'a'.repeat(16), 'dismissed')).toThrow('no longer in the file');
    expect(() => esc.closeEscalation(project, esc.escalationList(project)[0].key, 'deleted')).toThrow('Unknown way');
  });

  it('has nothing for a team without the file', () => {
    expect(esc.escalationList(project)).toEqual([]);
    expect(summary(project).escalations).toBe(0);
  });
});
