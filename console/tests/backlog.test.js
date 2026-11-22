import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR is read when the modules load, so point it at a temp folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-bl-'));
process.env.CONSOLE_DATA_DIR = root;
const bl = await import('../src/lib/server/backlog.js');

const fake = path.join(root, 'fakebin');
const project = { id: 'team', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'vm' }, paths: { fleet: path.join(root, 'fleet') } };
const base = path.join(root, 'backlog', 'team');
const out = path.join(base, 'out');
const user = { name: 'owner' };
const vm = (code, stderr = '') => {
  fs.writeFileSync(path.join(fake, 'code'), String(code));
  fs.writeFileSync(path.join(fake, 'stderr'), stderr);
};
const calls = () => fs.readFileSync(path.join(fake, 'log'), 'utf8').trim().split('\n');
const lastInput = () => fs.readFileSync(path.join(fake, 'stdin'), 'utf8');

const prop = (fields, body = 'Why: it helps.\nSteps:\n1. do it') =>
  Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n') + `\n---\n${body}\n`;

let PLAN;

beforeAll(() => {
  fs.mkdirSync(fake, { recursive: true });
  fs.mkdirSync(project.paths.fleet, { recursive: true });
  // `ssh` is a stub: it keeps stdin and the remote command, answers a status
  // read with nothing, and exits with the code and stderr the test chose.
  fs.writeFileSync(
    path.join(fake, 'ssh'),
    `#!/bin/sh\nfor a; do last=$a; done\nif [ "$last" = "bash -s" ]; then cat > /dev/null; cat ${fake}/status 2>/dev/null || echo '{}'; exit 0; fi\n` +
      `cat > ${fake}/stdin\necho "$last" >> ${fake}/log\ncat ${fake}/stderr >&2\nexit $(cat ${fake}/code)\n`,
    { mode: 0o755 }
  );
  // rsync (the pull) is not used here.
  process.env.PATH = `${fake}:${process.env.PATH}`;
  vm(0);
});

describe('kit version', () => {
  it('needs 0.10.0', () => {
    expect(bl.kitHasBacklog('0.10.0')).toBe(true);
    expect(bl.kitHasBacklog('0.11.2')).toBe(true);
    expect(bl.kitHasBacklog('1.0.0')).toBe(true);
    expect(bl.kitHasBacklog('0.9.0')).toBe(false);
    expect(bl.kitHasBacklog('0.9.10')).toBe(false);
    expect(bl.kitHasBacklog(null)).toBe(false);
    expect(bl.kitHasBacklog('0.10')).toBe(false);
  });
});

describe('planning cycles', () => {
  it('starts one with the focus text on stdin', async () => {
    vm(0);
    const res = await bl.startPlan(user, project, { focus: 'The save system; `rm -rf /` $(id)' });
    expect(res.started).toBe(true);
    PLAN = res.id;
    expect(PLAN).toMatch(bl.PLAN_RE);
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-oneshot start ${PLAN} owner --plan`);
    // Free text only ever travels on stdin, never as an argument.
    expect(lastInput()).toContain('$(id)');
    expect(fs.existsSync(path.join(base, 'plans', `${PLAN}.json`))).toBe(true);
  });

  it('keeps nothing when the VM refuses', async () => {
    vm(2, 'agent-kit-oneshot: a cycle is running. Send an inbox message instead');
    const before = fs.readdirSync(path.join(base, 'plans')).length;
    await expect(bl.startPlan(user, project, { focus: '' })).rejects.toThrow('a cycle is running');
    expect(fs.readdirSync(path.join(base, 'plans')).length).toBe(before);
    vm(0);
  });

  it('sets one for a time inside the window only', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(bl.startPlan(user, project, { at: now + 10 })).rejects.toThrow('between one minute and 30 days');
    await expect(bl.startPlan(user, project, { at: now + 40 * 86400 })).rejects.toThrow('between one minute and 30 days');
    await expect(bl.startPlan(user, project, { at: 'x; id' })).rejects.toThrow('between one minute and 30 days');
    const res = await bl.startPlan(user, project, { at: now + 3600 });
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-oneshot at ${now + 3600} ${res.id} owner --plan`);
    // The newer plan is only set for later; drop it so PLAN stays the newest.
    fs.rmSync(path.join(base, 'plans', `${res.id}.json`));
  });

  it('refuses an overlong focus', async () => {
    await expect(bl.startPlan(user, project, { focus: 'a'.repeat(9000) })).rejects.toThrow('too long');
  });
});

describe('proposals from the lead', () => {
  const good = '20260102T100000Z-b-aaaaaa';
  const second = '20260102T100100Z-b-bbbbbb';
  const fields = (extra = {}) => ({ Plan: PLAN, Rev: 1, Date: '2026-01-02T10:00:00Z', Title: 'Save slots', Minutes: 45, 'Cost-usd': '1.20', Confidence: 'medium', Areas: 'save system', ...extra });

  beforeAll(() => {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${good}.md`), prop(fields({ Order: 1 })));
    fs.writeFileSync(path.join(out, `${second}.md`), prop(fields({ Title: 'Second', Order: 2, Depends: `${good},not-an-id` })));
    // Forged or broken files: none of them may show.
    fs.writeFileSync(path.join(out, '20260102T100200Z-b-cccccc.md'), prop(fields({ Plan: '20260101T000000Z-p-never' })));
    fs.writeFileSync(path.join(out, '20260102T100300Z-b-dddddd.md'), prop(fields({ Minutes: 500 })));
    fs.writeFileSync(path.join(out, '20260102T100400Z-b-eeeeee.md'), prop(fields({ Confidence: 'certain' })));
    fs.writeFileSync(path.join(out, '20260102T100500Z-b-ffffff.md'), prop(fields({ 'Cost-usd': '1;id' })));
    fs.writeFileSync(path.join(out, '20260102T100600Z-b-111111.md'), prop(fields({ Date: 'yesterday' })));
    fs.writeFileSync(path.join(out, 'not-an-id.md'), prop(fields()));
    fs.symlinkSync('/etc/passwd', path.join(out, '20260102T100700Z-b-222222.md'));
  });

  it('shows only checked proposals of known plans, in the lead\'s order', () => {
    const plan = bl.list(project).plans.find((x) => x.id === PLAN);
    expect(plan.newest).toBe(true);
    expect(plan.proposals.map((x) => x.pid)).toEqual([good, second]);
    const p = plan.proposals[0];
    expect(p).toMatchObject({ minutes: 45, cost: 1.2, confidence: 'medium', areas: 'save system', state: 'new', rev: 1 });
    expect(plan.proposals[1].depends).toEqual([good]);
  });

  it('cuts a huge body', () => {
    const big = '20260102T100800Z-b-333333';
    fs.writeFileSync(path.join(out, `${big}.md`), prop(fields(), 'x'.repeat(30000)));
    const p = bl.list(project).plans.find((x) => x.id === PLAN).proposals.find((x) => x.pid === big);
    expect(p.text.length).toBe(8000);
    fs.rmSync(path.join(out, `${big}.md`));
  });

  it('records a decision for the revision shown, and asks again after a revision', async () => {
    vm(0);
    await bl.decide(user, project, good, 'approved');
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-backlog set ${good} approved 1`);
    expect(bl.list(project).plans[0].proposals[0].state).toBe('approved');
    fs.writeFileSync(path.join(out, `${good}.md`), prop(fields({ Order: 1, Rev: 2, Minutes: 30 })));
    expect(bl.list(project).plans[0].proposals[0].state).toBe('revised');
    await expect(bl.runNow(user, project, good, async () => ({ id: 'x' }))).rejects.toThrow('Approve this revision first');
    await bl.decide(user, project, good, 'approved');
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-backlog set ${good} approved 2`);
  });

  it('refuses bad decisions and ids', async () => {
    await expect(bl.decide(user, project, good, 'maybe')).rejects.toThrow('Bad decision');
    await expect(bl.decide(user, project, 'x; id', 'approved')).rejects.toThrow('Bad proposal id');
    await expect(bl.decide(user, project, '20260102T100200Z-b-cccccc', 'approved')).rejects.toThrow('No such proposal');
  });

  it('runs an approved item as a one-shot job with the proposal as its text', async () => {
    let sent = null;
    const res = await bl.runNow(user, project, good, async (_u, _p, job) => {
      sent = job.text;
      return { id: '20260102T120000Z-o-abcdef', started: true };
    });
    expect(res.started).toBe(true);
    expect(sent).toContain('Save slots');
    expect(sent).toContain('30 minutes, $1.20, confidence medium');
    expect(bl.list(project).plans[0].proposals[0].run.jobId).toBe('20260102T120000Z-o-abcdef');
  });

  it('checks the time of a scheduled item', async () => {
    await expect(bl.runAt(user, project, good, Math.floor(Date.now() / 1000) - 5)).rejects.toThrow('between one minute and 30 days');
    await expect(bl.runAt(user, project, second, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow('Approve this revision first');
  });

  it('flags a planning session that touched code, from the ledger', () => {
    fs.writeFileSync(
      path.join(project.paths.fleet, 'cycles.jsonl'),
      [JSON.stringify({ kind: 'plan', plan: PLAN, secs: 600, cost_usd: 1.5, touched_code: true }), 'not json', JSON.stringify({ kind: 'chat', plan: PLAN, chat: 'x', cost_usd: 0.2 })].join('\n') + '\n'
    );
    const plan = bl.list(project).plans[0];
    expect(plan).toMatchObject({ done: true, touchedCode: true, cost: 1.5, minutes: 10 });
    expect(plan.chatCost).toBeCloseTo(0.2);
  });
});

describe('chat with the lead', () => {
  it('sends a message on stdin and shows only answers to messages sent here', async () => {
    vm(0);
    const res = await bl.chatSay(user, project, PLAN, 'Make the first one smaller $(id)');
    expect(res.delivered).toBe(true);
    expect(res.id).toMatch(bl.MSG_RE);
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-chat say ${PLAN} ${res.id} owner`);
    expect(lastInput()).toBe('Make the first one smaller $(id)');
    let plan = bl.list(project).plans[0];
    expect(plan.waiting).toBe(true);
    const dir = path.join(out, 'chat', PLAN);
    fs.mkdirSync(dir, { recursive: true });
    // An answer that names another message, and one for a message never sent.
    fs.writeFileSync(path.join(dir, `${res.id}.md`), 'Re: 20260101T000000Z-c-000000\nStatus: ok\nDate: 2026-01-02T12:00:00Z\n---\nforged\n');
    fs.writeFileSync(path.join(dir, '20260101T000000Z-c-999999.md'), 'Re: 20260101T000000Z-c-999999\nStatus: ok\n---\nnobody asked\n');
    plan = bl.list(project).plans[0];
    expect(plan.chat).toHaveLength(1);
    expect(plan.chat[0].reply).toBeNull();
    fs.writeFileSync(path.join(dir, `${res.id}.md`), `Re: ${res.id}\nStatus: ok\nDate: 2026-01-02T12:00:00Z\n---\nDone: 30 minutes now.\n`);
    plan = bl.list(project).plans[0];
    expect(plan.chat[0].reply.text).toBe('Done: 30 minutes now.');
    expect(plan.waiting).toBe(false);
  });

  it('counts an answer the owner has not opened, until the chat is opened or the next message is sent', async () => {
    // The answer of the test above is there and nobody has looked.
    expect(bl.chatUnread(project)).toBe(1);
    // Not while a chat turn is running on the VM.
    expect(bl.chatUnread(project, { chat: { plan: PLAN } })).toBe(0);
    bl.chatSeen(project, PLAN);
    expect(bl.chatUnread(project)).toBe(0);
    expect(() => bl.chatSeen(project, '../x')).toThrow('Bad plan id');
    // The next message: nothing to read while its answer is on the way, then one again.
    vm(0);
    const next = await bl.chatSay(user, project, PLAN, 'And the second one?');
    expect(bl.chatUnread(project)).toBe(0);
    fs.writeFileSync(path.join(out, 'chat', PLAN, `${next.id}.md`), `Re: ${next.id}\nStatus: ok\nDate: 2026-01-02T13:00:00Z\n---\nIt stays.\n`);
    expect(bl.chatUnread(project)).toBe(1);
    // The seen mark is not a message of the chat.
    expect(bl.list(project).plans[0].chat).toHaveLength(2);
    bl.chatSeen(project, PLAN);
    expect(bl.chatUnread(project)).toBe(0);
  });

  it('passes a refusal on and keeps nothing', async () => {
    vm(2, 'agent-kit-chat: a cycle is running. Try again when it has ended');
    await expect(bl.chatSay(user, project, PLAN, 'hello')).rejects.toThrow('a cycle is running');
    expect(bl.list(project).plans[0].chat).toHaveLength(2);
    vm(0);
  });

  it('refuses bad input before anything reaches the VM', async () => {
    const n = calls().length;
    await expect(bl.chatSay(user, project, 'x; id', 'hi')).rejects.toThrow('Bad plan id');
    await expect(bl.chatSay(user, project, '20260101T000000Z-p-never', 'hi')).rejects.toThrow('No such planning session');
    await expect(bl.chatSay(user, project, PLAN, '   ')).rejects.toThrow('Write a message first');
    await expect(bl.chatSay(user, project, PLAN, 'a'.repeat(20001))).rejects.toThrow('too long');
    expect(calls().length).toBe(n);
  });

  it('ends the chat', async () => {
    await bl.chatEnd(user, project, PLAN);
    expect(calls().at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-chat end ${PLAN}`);
    await expect(bl.chatSay(user, project, PLAN, 'more')).rejects.toThrow('ended');
    expect(bl.list(project).plans[0].ended).toBe(true);
  });
});

describe('planned issues and jobs on the timeline (kit 0.11)', () => {
  const live = () => import('../src/lib/server/live.js');
  const issues = () => import('../src/lib/server/issues.js');
  const NEXT = '20260102T110000Z-b-eeeeee';
  let PLAN2;

  beforeAll(async () => {
    vm(0);
    fs.writeFileSync(path.join(fake, 'status'), JSON.stringify({ kitver: '0.11.0', lead: 'inactive', control: 'stop owner', now: '1' }) + '\n');
    await (await live()).getStatus(project, { fresh: true });
    PLAN2 = (await bl.startPlan(user, project, { focus: '' })).id;
    fs.writeFileSync(
      path.join(out, `${NEXT}.md`),
      prop({ Plan: PLAN2, Rev: 1, Date: '2026-01-02T11:00:00Z', Title: 'Autosave', Minutes: 40, 'Cost-usd': '2.00', Confidence: 'high', Order: 1 })
    );
  });

  it('approving makes a planned issue, delivered with its kind', async () => {
    const res = await bl.decide(user, project, NEXT, 'approved');
    expect(res.issueId).toMatch(/^[0-9]{8}T[0-9]{6}Z-i-[a-f0-9]{6}$/);
    const issue = (await issues()).get(project, res.issueId);
    expect(issue).toMatchObject({ kind: 'planned', status: 'new', title: '1. Autosave', proposal: { pid: NEXT, rev: 1, plan: PLAN2 } });
    expect(calls()).toContain(`sudo -n /opt/agent-kit/bin/agent-kit-issues put ${res.issueId} planned`);
    expect((await issues()).openCount(project)).toBe(0);
  });

  it('a later revision replaces the issue; rejecting closes it', async () => {
    const d1 = JSON.parse(fs.readFileSync(path.join(base, 'decisions', `${NEXT}.json`), 'utf8'));
    fs.writeFileSync(
      path.join(out, `${NEXT}.md`),
      prop({ Plan: PLAN2, Rev: 2, Date: '2026-01-02T11:05:00Z', Title: 'Autosave', Minutes: 30, 'Cost-usd': '2.00', Confidence: 'high', Order: 1 })
    );
    await bl.decide(user, project, NEXT, 'approved');
    const d2 = JSON.parse(fs.readFileSync(path.join(base, 'decisions', `${NEXT}.json`), 'utf8'));
    expect(d2.issueId).not.toBe(d1.issueId);
    expect((await issues()).get(project, d1.issueId).status).toBe('wontfix');
    expect((await issues()).get(project, d2.issueId).proposal.rev).toBe(2);
    await bl.decide(user, project, NEXT, 'rejected');
    expect((await issues()).get(project, d2.issueId).status).toBe('wontfix');
    await bl.decide(user, project, NEXT, 'approved');
  });

  it('the job names its issue, and Run now draws a running bar at once', async () => {
    const d = JSON.parse(fs.readFileSync(path.join(base, 'decisions', `${NEXT}.json`), 'utf8'));
    let text = '';
    await bl.runNow(user, project, NEXT, async (_u, _p, job) => {
      text = job.text;
      return { id: '20260102T120500Z-o-a1b2c3', started: true };
    });
    expect(text).toContain(`Owner issue ${d.issueId}`);
    expect((await issues()).get(project, d.issueId).job.id).toBe('20260102T120500Z-o-a1b2c3');
    const jobs = bl.jobsFor(project, {});
    const j = jobs.find((x) => x.id === '20260102T120500Z-o-a1b2c3');
    expect(j).toMatchObject({ kind: 'job', state: 'running', title: 'Autosave', minutes: 30, pid: NEXT });
    expect(j.estEnd - j.start).toBe(30 * 60000);
  });

  it('a job set for a time, a finished job, and forged run files', () => {
    const runs = path.join(base, 'runs');
    const at = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(path.join(runs, '20260102T100100Z-b-bbbbbb.json'), JSON.stringify({ jobId: '20260102T130000Z-o-setjob', rev: 1, at: '2026-01-02T12:00:00Z', scheduledFor: at }));
    fs.writeFileSync(path.join(runs, '20260102T100400Z-b-eeeeee.json'), JSON.stringify({ jobId: '; rm -rf /', rev: 1, at: new Date().toISOString() }));
    fs.writeFileSync(path.join(runs, 'not-a-pid.json'), JSON.stringify({ jobId: '20260102T130000Z-o-forged', at: new Date().toISOString() }));
    fs.appendFileSync(
      path.join(project.paths.fleet, 'cycles.jsonl'),
      JSON.stringify({ kind: 'oneshot', oneshot: '20260102T120000Z-o-abcdef', start: '2026-01-02T12:00:00Z', end: '2026-01-02T12:50:00Z', secs: 3000 }) + '\n'
    );
    const jobs = bl.jobsFor(project, { atJobs: [{ id: '20260102T130000Z-o-setjob', at, from: 'owner', plan: false }] });
    const ids = jobs.map((x) => x.id);
    expect(ids).not.toContain('20260102T130000Z-o-forged');
    expect(ids.every((x) => /^[0-9]{8}T[0-9]{6}Z-[op]-[a-z0-9-]+$/.test(x))).toBe(true);
    expect(jobs.find((x) => x.id === '20260102T130000Z-o-setjob')).toMatchObject({ state: 'set', start: at * 1000 });
    const done = jobs.find((x) => x.id === '20260102T120000Z-o-abcdef');
    expect(done).toMatchObject({ state: 'done', start: Date.parse('2026-01-02T12:00:00Z'), end: Date.parse('2026-01-02T12:50:00Z') });
  });

  it('moving a job set for a time sends it again for the new time', async () => {
    const at = Math.floor(Date.now() / 1000) + 7200;
    const res = await bl.runAt(user, project, NEXT, at);
    expect(res.scheduled).toBe(true);
    const to = at + 1800;
    await bl.moveAt(user, project, res.id, to);
    const c = calls();
    expect(c.at(-2)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-oneshot unat ${res.id}`);
    expect(c.at(-1)).toBe(`sudo -n /opt/agent-kit/bin/agent-kit-oneshot at ${to} ${res.id} owner`);
    await expect(bl.moveAt(user, project, res.id, 5)).rejects.toThrow('between one minute and 30 days');
    await expect(bl.moveAt(user, project, 'x; id', to)).rejects.toThrow();
  });
});
