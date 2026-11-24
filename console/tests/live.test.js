import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { _test, kitAtLeast, stallOf } from '../src/lib/server/live.js';
import { idleText, waitingParts, stallText, pillState } from '../src/lib/format.js';

// Raw status as the VM script prints it (all strings), for an idle team.
const raw = (o = {}) => ({ control: 'run 2026-11-20T00:00:33+00:00', lead: 'inactive', timer: 'enabled', cap: '1', today: '1', next: '1795139944', dayend: '1795219200', now: '1795139000', ...o });

describe('what waits for the owner', () => {
  it('counts held check changes and package requests from the status, 0 on an older kit', () => {
    expect(_test.shape(raw({ held: '1', pkgwait: '2' }))).toMatchObject({ heldChanges: 1, packageRequests: 2 });
    expect(_test.shape(raw())).toMatchObject({ heldChanges: 0, packageRequests: 0 });
    expect(_test.shape(raw({ held: 'x', pkgwait: '' }))).toMatchObject({ heldChanges: 0, packageRequests: 0 });
  });

  it('the status script counts them without sudo', () => {
    const script = _test.statusScript({ slug: 's', kit: { state: '/var/lib/agent-kit', leadUnit: 'agent-kit-lead', bare: '/b', workspace: '/w', agentHome: '/home/agent' } });
    expect(script).toMatch(/held=\$\(grep -l '"status": \*"held"'/);
    expect(script).toMatch(/packages\/\.owner\/\$r/);
    expect(script).toMatch(/held:\$held, pkgwait:\$pkgwait/);
    // It is still a script bash can read.
    execFileSync('bash', ['-n'], { input: script });
  });

  it('is said in words, and the Inbox tab counts what it holds', () => {
    expect(waitingParts({ asks: 1, escalations: 0, packages: 2, held: 1 })).toEqual({ total: 4, inbox: 4, backlog: 0, chat: 0, text: '1 question · 2 package requests · 1 check change' });
    expect(waitingParts({ asks: 0, escalations: 2, packages: 0, held: 0 })).toEqual({ total: 2, inbox: 0, backlog: 0, chat: 0, text: '2 escalations' });
    expect(waitingParts({ chat: 1 })).toEqual({ total: 1, inbox: 0, backlog: 1, chat: 0, text: '1 planning chat answer' });
    expect(waitingParts({ talk: 2 })).toEqual({ total: 2, inbox: 0, backlog: 0, chat: 2, text: '2 chat answers' });
    expect(waitingParts({ asks: 1, publishing: 1 })).toEqual({ total: 2, inbox: 2, backlog: 0, chat: 0, text: '1 question · publishing is not working' });
    expect(waitingParts(undefined)).toEqual({ total: 0, inbox: 0, backlog: 0, chat: 0, text: 'Nothing' });
  });
});

describe('jobs set for a time', () => {
  it('reads why a job whose time has come waits (kit 0.18), and ignores what it does not know', () => {
    const A = '20261122T100000Z-o-first';
    const B = '20261122T100100Z-o-second';
    const st = _test.shape(raw({ atjobs: `${A} 1795140000 owner - -\n${B} 1795143600 owner merge ${A}\n20261122T100200Z-p-plan 1795147200 owner held -\n20261122T100300Z-o-odd 1795150800 owner rm-rf ;id\n20261122T100400Z-o-old 1795154400 owner` }));
    expect(st.atJobs.map((j) => [j.id.slice(-5), j.wait])).toEqual([
      ['first', null],
      ['econd', { reason: 'merge', job: A }],
      ['-plan', { reason: 'held', job: null }],
      ['o-odd', null],
      ['o-old', null]
    ]);
  });
});

describe('status of an idle team', () => {
  it('says the daily cap is used up, and when the VM day ends', () => {
    const st = _test.shape(raw());
    expect(st.state).toBe('idle');
    expect(st.idle).toEqual({ reason: 'cap', today: 1, cap: 1, nextAt: 1795139944, dayEndsAt: 1795219200 });
    expect(idleText(st.idle)).toMatch(/daily cycle cap is used up \(1 of 1 today\).*one-shot job/);
  });

  it('between cycles when the cap allows another', () => {
    const st = _test.shape(raw({ cap: '4' }));
    expect(st.idle.reason).toBe('between');
    expect(idleText(st.idle)).toMatch(/^Idle between cycles\. The next one starts at .+ \(1 of 4 today\)\.$/);
  });

  it('timer off, and a pending halt, come before the cap', () => {
    expect(_test.shape(raw({ cap: '4', timer: 'disabled' })).idle.reason).toBe('timer-off');
    expect(_test.shape(raw({ haltafter: '1795139000 plain owner' })).idle.reason).toBe('halt-after');
  });

  it('no idle reason for a running or halted team', () => {
    expect(_test.shape(raw({ lead: 'active' })).idle).toBeNull();
    expect(_test.shape(raw({ control: 'stop owner 2026-11-20T00:00:00+00:00' })).idle).toBeNull();
  });

  it('an older kit without the numbers: no cap reason, no crash', () => {
    const st = _test.shape(raw({ cap: undefined, today: undefined, next: undefined, dayend: undefined }));
    expect(st.idle).toMatchObject({ reason: 'between', today: null, cap: null });
    expect(idleText(st.idle)).toBe('Idle between cycles. The next one starts soon.');
  });

  it('reads whether a one-shot job ends in a halt or runs on', () => {
    expect(_test.shape(raw({ oneshot: '20261120T020000Z-o-abc 2026-11-20T02:00:00+00:00 run' })).oneshot).toMatchObject({ id: '20261120T020000Z-o-abc', runsOn: true });
    expect(_test.shape(raw({ oneshot: '20261120T020000Z-o-abc 2026-11-20T02:00:00+00:00' })).oneshot.runsOn).toBe(false);
  });
});

describe('a stalled session (kit 0.24)', () => {
  const limit = '{"stalled":true,"session":"x","kind":"cycle","reason":"usage-limit","since":1795418000,"resetsAt":1795422000,"limit":"five_hour"}';

  it('reads what agent-kit-stall says, only while a cycle or chat turn runs', () => {
    expect(_test.shape(raw({ lead: 'active', stall: limit })).stalled).toEqual({
      reason: 'usage-limit', since: 1795418000, resetsAt: 1795422000, limit: 'five_hour', status: null, attempt: null, minutes: null, chat: false
    });
    expect(_test.shape(raw({ stall: limit })).stalled).toBeNull();
    expect(_test.shape(raw({ lead: 'active', stall: '{"stalled":false}' })).stalled).toBeNull();
    // An older kit prints nothing.
    expect(_test.shape(raw({ lead: 'active' })).stalled).toBeNull();
    expect(_test.shape(raw({ chat: '20261120T020000Z-p-plan 20261120T020500Z-c-abcdef 2026-11-20T02:05:00+00:00', stall: limit.replace('"cycle"', '"chat"') })).stalled.chat).toBe(true);
  });

  it('keeps only what it knows', () => {
    expect(stallOf('{"stalled":true,"reason":"rm -rf"}')).toBeNull();
    expect(stallOf('not json')).toBeNull();
    expect(stallOf('{"stalled":true,"reason":"api-error","since":1795418000,"status":529,"attempt":4,"resetsAt":1795422000}')).toMatchObject({ reason: 'api-error', status: 529, attempt: 4, resetsAt: null });
    expect(stallOf('{"stalled":true,"reason":"usage-limit","since":"soon","resetsAt":-1,"limit":"<b>"}')).toMatchObject({ since: null, resetsAt: null, limit: null });
  });

  it('the status script asks the kit for it with sudo, and only when the kit has it', () => {
    const script = _test.statusScript({ slug: 's', kit: { state: '/var/lib/agent-kit', leadUnit: 'agent-kit-lead', bare: '/b', workspace: '/w', agentHome: '/home/agent' } });
    expect(script).toMatch(/stall=\$\(\[ -x \/opt\/agent-kit\/bin\/agent-kit-stall \] && sudo -n \/opt\/agent-kit\/bin\/agent-kit-stall/);
    execFileSync('bash', ['-n'], { input: script });
  });

  it('is said in one line, and shows as Stalled', () => {
    const now = 1795418000 * 1000;
    expect(stallText(stallOf(limit), now)).toMatch(/^Stalled: usage limit \(5-hour window\), resets at \S+/);
    expect(stallText({ reason: 'usage-limit', limit: null, resetsAt: null }, now)).toBe('Stalled: usage limit');
    expect(stallText({ reason: 'api-error', attempt: 5 }, now)).toBe('Stalled: API errors, retrying (attempt 5)');
    expect(stallText({ reason: 'no-progress', minutes: 42 }, now)).toBe('Stalled: no progress for 42 min');
    expect(stallText({ reason: 'no-progress', minutes: 95 }, now)).toBe('Stalled: no progress for 1 h 35 min');
    expect(stallText(null)).toBeNull();
    expect(pillState({ state: 'running', stalled: { reason: 'api-error' } })).toBe('stalled');
    expect(pillState({ state: 'running', stalled: null })).toBe('running');
    expect(pillState({ state: 'checking' })).toBe('idle');
  });
});

describe('kitAtLeast', () => {
  it('compares versions', () => {
    expect(kitAtLeast('0.6.0', '0.6.0')).toBe(true);
    expect(kitAtLeast('0.10.1', '0.6.0')).toBe(true);
    expect(kitAtLeast('1.0', '0.6.0')).toBe(true);
    expect(kitAtLeast('0.5.0', '0.6.0')).toBe(false);
    expect(kitAtLeast('', '0.6.0')).toBe(false);
    expect(kitAtLeast('dev', '0.6.0')).toBe(false);
  });
});
