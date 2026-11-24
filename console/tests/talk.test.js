import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR is read when the modules load, so point it at a temp folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-talk-'));
process.env.CONSOLE_DATA_DIR = root;
const talk = await import('../src/lib/server/talk.js');
const { chatOf } = await import('../src/lib/server/live.js');

const fake = path.join(root, 'fakebin');
const project = { id: 'team', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'vm' }, paths: { fleet: path.join(root, 'fleet') } };
const base = path.join(root, 'talk', 'team');
const out = path.join(base, '.out');
const user = { name: 'owner' };
const vm = (code, stderr = '') => {
  fs.writeFileSync(path.join(fake, 'code'), String(code));
  fs.writeFileSync(path.join(fake, 'stderr'), stderr);
};
const calls = () => fs.readFileSync(path.join(fake, 'log'), 'utf8').trim().split('\n');
const lastInput = () => fs.readFileSync(path.join(fake, 'stdin'));

beforeAll(() => {
  fs.mkdirSync(fake, { recursive: true });
  fs.mkdirSync(project.paths.fleet, { recursive: true });
  fs.writeFileSync(
    path.join(fake, 'ssh'),
    `#!/bin/sh\nfor a; do last=$a; done\nif [ "$last" = "bash -s" ]; then cat > /dev/null; echo '{}'; exit 0; fi\n` +
      `cat > ${fake}/stdin\necho "$last" >> ${fake}/log\ncat ${fake}/stderr >&2\nexit $(cat ${fake}/code)\n`,
    { mode: 0o755 }
  );
  process.env.PATH = `${fake}:${process.env.PATH}`;
  vm(0);
});

const reply = (msg, status = 'ok', text = 'An answer.') => `Re: ${msg}\nStatus: ${status}\nDate: 2099-01-01T00:00:00Z\n---\n${text}\n`;

let CONV;
let M1;

describe('the Chat tab: conversations with the lead', () => {
  it('needs kit 0.33', () => {
    expect(talk.kitHasTalk('0.33.0')).toBe(true);
    expect(talk.kitHasTalk('0.32.0')).toBe(false);
  });

  it('a first message starts a conversation titled from it; the text goes on stdin', async () => {
    const res = await talk.say(user, project, { text: 'What is the team doing?\nAnd why $(id)', model: 'opus', effort: 'high' });
    expect(res.delivered).toBe(true);
    CONV = res.conv;
    M1 = res.id;
    expect(CONV).toMatch(talk.TALK_RE);
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-chat say ${CONV} ${M1} owner --model opus --effort high`);
    expect(lastInput().toString()).toBe('What is the team doing?\nAnd why $(id)');
    const [c] = talk.list(project);
    expect(c).toMatchObject({ id: CONV, title: 'What is the team doing?', count: 1, waiting: true, unread: 0 });
  });

  it('refuses a bad model, effort or conversation, and keeps nothing when the VM says no', async () => {
    await expect(talk.say(user, project, { text: 'x', model: 'gpt' })).rejects.toThrow('model');
    await expect(talk.say(user, project, { text: 'x', effort: 'tiny' })).rejects.toThrow('effort');
    await expect(talk.say(user, project, { conv: '20990101T000000Z-t-abcdef', text: 'x' })).rejects.toThrow('No such');
    await expect(talk.say(user, project, { text: '  ' })).rejects.toThrow('Write');
    vm(2, 'agent-kit-chat: the lead is still answering the last message');
    await expect(talk.say(user, project, { conv: CONV, text: 'again' })).rejects.toThrow('still answering');
    vm(0);
    expect(talk.get(project, CONV).messages).toHaveLength(1);
  });

  it('shows the lead\'s steps while it works, then its answer, cost and context', () => {
    fs.mkdirSync(path.join(out, CONV), { recursive: true });
    const stream = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'docs/agents/STATE.md' } }], usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, output_tokens: 50 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git log --oneline -5' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The team is on the save' }] } }
    ];
    fs.writeFileSync(path.join(out, CONV, `${M1}.jsonl`), stream.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
    const status = { chat: chatOf(`${CONV} ${M1} 2099-01-01T00:00:00+00:00`) };
    let g = talk.get(project, CONV, { status });
    expect(g.running).toBe(true);
    const m = g.messages[0];
    expect(m.steps).toEqual([
      { tool: 'Read', text: 'docs/agents/STATE.md', ok: true },
      { tool: 'Bash', text: 'git log --oneline -5', ok: false }
    ]);
    expect(m.said).toBe('The team is on the save');
    expect(g.context).toMatchObject({ tokens: 42010, window: 200000, files: ['docs/agents/STATE.md'] });

    // The turn ends: the answer, and the ledger line with its cost.
    fs.writeFileSync(path.join(out, CONV, `${M1}.md`), reply(M1, 'ok', 'The team is on the save system.'));
    const end = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(project.paths.fleet, 'cycles.jsonl'),
      [{ kind: 'chat', plan: 'x', chat: M1, cost_usd: 9 }, { kind: 'talk', talk: CONV, chat: M1, cost_usd: 0.25, model: 'opus', effort: 'high', end }].map((l) => JSON.stringify(l)).join('\n') + '\n'
    );
    g = talk.get(project, CONV);
    expect(g.messages[0]).toMatchObject({ reply: { status: 'ok', text: 'The team is on the save system.' }, said: '', cost: 0.25, ranModel: 'opus' });
    expect(g.context).toMatchObject({ cost: 0.25, turns: 1, model: 'opus', effort: 'high', warmMinutes: 50 });
  });

  it('the panel works from the answer before the ledger line has come', async () => {
    const res = await talk.say(user, project, { text: 'A new one', model: 'sonnet', effort: 'low' });
    const c = res.conv;
    fs.mkdirSync(path.join(out, c), { recursive: true });
    const stream = [{ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }], usage: { input_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 5 } } }];
    fs.writeFileSync(path.join(out, c, `${res.id}.jsonl`), stream.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(out, c, `${res.id}.md`), `Re: ${res.id}\nStatus: ok\nDate: ${new Date(Date.now() - 5 * 60_000).toISOString()}\n---\nDone.\n`);
    const g = talk.get(project, c);
    expect(g.messages[0]).toMatchObject({ ranModel: 'sonnet', ranEffort: 'low', cost: null });
    expect(g.context).toMatchObject({ turns: 1, costPending: 1, model: 'sonnet', effort: 'low', tokens: 9005, warmMinutes: 55, files: ['README.md'] });
    talk.archiveConv(project, c, true);
  });

  it('counts unread answers until the owner has seen them', () => {
    expect(talk.unread(project)).toBe(1);
    // Not while the lead is still answering in that conversation.
    expect(talk.unread(project, { chat: { talk: CONV } })).toBe(0);
    talk.seen(project, CONV);
    expect(talk.unread(project)).toBe(0);
  });

  it('a reply names its message: an answer to another message is not taken', async () => {
    const res = await talk.say(user, project, { conv: CONV, text: 'Thanks' });
    fs.writeFileSync(path.join(out, CONV, `${res.id}.md`), reply(M1));
    const g = talk.get(project, CONV);
    expect(g.messages[1].reply).toBeNull();
    expect(g.model).toBeNull(); // this message asked for no model: the team's own
  });

  it('renames and archives; archived ones leave the count', () => {
    talk.rename(project, CONV, '  Save   system  ');
    expect(talk.list(project)[0].title).toBe('Save system');
    expect(() => talk.rename(project, CONV, ' ')).toThrow();
    fs.writeFileSync(path.join(out, CONV, `${talk.get(project, CONV).messages[1].id}.md`), reply(talk.get(project, CONV).messages[1].id));
    expect(talk.unread(project)).toBe(1);
    talk.archiveConv(project, CONV, true);
    expect(talk.list(project)[0].archived).toBe(true);
    expect(talk.unread(project)).toBe(0);
  });

  it('sends files as a tar of body.md and att/', async () => {
    const tok = 'a'.repeat(24);
    const d = path.join(root, 'feedback', 'team', 'drafts', tok);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'trace.log'), 'line');
    const res = await talk.say(user, project, { conv: CONV, text: 'Is this bad?', attachments: [tok] });
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-chat say ${CONV} ${res.id} owner --files`);
    expect(lastInput().includes(Buffer.from('trace.log'))).toBe(true);
    expect(talk.get(project, CONV).messages.at(-1).files).toEqual([{ name: 'trace.log', size: 4 }]);
    expect(fs.existsSync(d)).toBe(false);
    // Sending to an archived conversation brings it back.
    expect(talk.list(project)[0].archived).toBe(false);
  });

  it('a chat marker names a plan or a conversation', () => {
    expect(chatOf('20261120T020000Z-p-plan 20261120T020500Z-c-abcdef 2026')).toMatchObject({ plan: '20261120T020000Z-p-plan', talk: null });
    expect(chatOf('20261120T020000Z-t-abcdef 20261120T020500Z-c-abcdef 2026')).toMatchObject({ plan: null, talk: '20261120T020000Z-t-abcdef' });
    expect(chatOf('x 20261120T020500Z-c-abcdef')).toBeNull();
  });

  it('titles are the first line, shortened', () => {
    expect(talk.titleFrom('  hello\nworld')).toBe('hello');
    expect(talk.titleFrom('x'.repeat(100))).toHaveLength(58);
  });
});

describe('Chat tab turns in the figures', () => {
  it('are read with their kind and left out of cycle figures like plan chat turns', async () => {
    const { readCycles, isChat, typicalCycle } = await import('../src/lib/server/aggregate.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-talk-fleet-'));
    const line = (o) => JSON.stringify({ date: '2026-01-01', start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:20:00Z', secs: 1200, rc: 0, cost_usd: 1, ...o });
    fs.writeFileSync(path.join(dir, 'cycles.jsonl'), [line({ kind: 'normal', counted: true }), line({ kind: 'talk', counted: false, chat: '20260101T100000Z-c-abcdef', talk: '20260101T100000Z-t-abcdef', secs: 5000 })].join('\n') + '\n');
    const cycles = readCycles(dir);
    expect(cycles.map((c) => c.kind)).toEqual(['normal', 'talk']);
    expect(isChat(cycles[1])).toBe(true);
    expect(typicalCycle(cycles)).toMatchObject({ n: 1, secs: 1200 });
  });
});
