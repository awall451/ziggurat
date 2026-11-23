import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #90: start times that repeat less often or end, and one-time cycles (kit 0.26).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-rep-'));
process.env.CONSOLE_DATA_DIR = root;
process.env.CONSOLE_CONFIG_DIR = root;

const calls = [];
let answer = { code: 0, stdout: 'ok', stderr: '' };
let kitVersion = '0.26.0';
vi.mock('../src/lib/server/ssh.js', async (orig) => ({
  ...(await orig()),
  kit: vi.fn(async (project, script, argv, opts) => {
    calls.push([script, ...argv, opts?.input ?? null]);
    return answer;
  })
}));
vi.mock('../src/lib/server/live.js', async (orig) => {
  const real = await orig();
  return { ...real, peekStatus: vi.fn(() => ({ kitVersion })), invalidateStatus: vi.fn() };
});

const lib = await import('../src/lib/schedule.js');
const server = await import('../src/lib/server/schedule.js');

const slot = (o) => ({ days: ['daily'], time: '06:00', ...o });

describe('when a start time starts', () => {
  it('every other day from its first date', () => {
    const s = slot({ every: 2, from: '2026-02-02' });
    expect(['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04'].map((d) => lib.occursOn(s, d))).toEqual([false, true, false, true]);
  });

  it('every other week on its days, weeks counted from the Monday of the first date', () => {
    // 2026-02-02 is a Monday; from a Wednesday the first week is still that week.
    const s = { days: ['tue', 'thu'], time: '09:00', every: 2, from: '2026-02-04' };
    expect(['2026-02-03', '2026-02-05', '2026-02-10', '2026-02-12', '2026-02-17'].map((d) => lib.occursOn(s, d))).toEqual([false, true, false, false, true]);
  });

  it('ends on its last date, or after a number of times', () => {
    expect(lib.occursOn(slot({ until: '2026-02-03' }), '2026-02-04')).toBe(false);
    expect(lib.lastOf(slot({ from: '2026-02-02', count: 3 }))).toBe('2026-02-04');
    expect(lib.lastOf({ days: ['mon', 'fri'], time: '10:00', every: 2, from: '2026-02-04', count: 3 })).toBe('2026-02-20');
    expect(lib.endOf(slot({ from: '2026-02-02', count: 3, until: '2026-02-03' }))).toBe('2026-02-03');
    expect(lib.occursOn(slot({ from: '2026-02-02', count: 3 }), '2026-02-05')).toBe(false);
  });

  it('the timeline draws only the starts that happen', () => {
    const s = lib.validateSchedule({ tz: 'UTC', slots: [slot({ every: 2, from: '2026-02-02', count: 3 })] });
    const from = Date.UTC(2026, 1, 1);
    const at = lib.occurrences(s, from, from + 10 * 86_400_000).map((o) => o.date);
    expect(at).toEqual(['2026-02-02', '2026-02-04', '2026-02-06']);
  });
});

describe('the text the VM holds', () => {
  it('writes and reads the new fields; with a count the kit works out the end', () => {
    const text = lib.formatScheduleText({ tz: 'UTC', slots: [slot({ every: 2, from: '2026-02-02', count: 3, until: '2026-02-04' }), { days: ['tue', 'thu'], time: '09:00', until: '2026-03-01' }] });
    expect(text).toBe('tz UTC\nslot daily 06:00 every=2 from=2026-02-02 count=3\nslot tue,thu 09:00 until=2026-03-01\n');
    const back = lib.parseScheduleText('tz UTC\nslot daily 06:00 every=2 from=2026-02-02 until=2026-02-06 count=3\nslot daily 07:00 often=2\n');
    expect(back.slots).toEqual([slot({ every: 2, from: '2026-02-02', until: '2026-02-06', count: 3 })]);
  });

  it('keeps all seven days for a slot every N weeks', () => {
    const s = lib.validateSchedule({ tz: 'UTC', slots: [{ days: [...lib.DAYS], time: '06:00', every: 2, from: '2026-02-02' }] });
    expect(s.slots[0].days).toHaveLength(7);
    expect(lib.validateSchedule({ tz: 'UTC', slots: [{ days: [...lib.DAYS], time: '06:00' }] }).slots[0].days).toEqual(['daily']);
  });

  it('says what is wrong', () => {
    const v = (o) => () => lib.validateSchedule({ tz: 'UTC', slots: [slot(o)] });
    expect(v({ every: 2 })).toThrow(/need a first date/);
    expect(v({ count: 3 })).toThrow(/need a first date/);
    expect(v({ every: 60, from: '2026-02-02' })).toThrow(/every must be/);
    expect(v({ from: '2026-02-30' })).toThrow(/must be a date/);
    expect(v({ from: '2026-02-10', until: '2026-02-01' })).toThrow(/ends before it starts/);
    expect(v({ count: 0, from: '2026-02-02' })).toThrow(/number of times/);
    expect(lib.usesRepeat(slot({}))).toBe(false);
    expect(lib.usesRepeat(slot({ until: '2026-02-02' }))).toBe(true);
  });
});

describe('one-time cycles', () => {
  const project = { id: 'demo', name: 'Demo', kit: { state: '/var/lib/agent-kit' }, ssh: { alias: 'nowhere.invalid' } };
  const soon = () => Math.round(Date.now() / 1000) + 3600;
  beforeEach(() => {
    calls.length = 0;
    answer = { code: 0, stdout: 'ok', stderr: '' };
    kitVersion = '0.26.0';
  });

  it('are drawn as jobs with the typical cycle length', () => {
    const status = { atJobs: [{ id: '20261123T100000Z-f-once', at: 1795400000, free: true, pastCap: true }, { id: '20261123T100000Z-o-job', at: 1795400000, free: false }] };
    const cycles = [{ counted: true, halted: false, kind: 'normal', secs: 1800, costUsd: 1 }];
    expect(server.onceJobs(status, cycles)).toEqual([
      expect.objectContaining({ id: '20261123T100000Z-f-once', kind: 'once', state: 'set', start: 1795400000000, minutes: 30, pastCap: true })
    ]);
  });

  it('are set, moved and cancelled with the kit', async () => {
    const at = soon();
    const out = await server.onceSet({ name: 'owner' }, project, { at, pastCap: true });
    expect(out.id).toMatch(/^\d{8}T\d{6}Z-f-once$/);
    expect(calls[0]).toEqual(['agent-kit-oneshot', 'at', String(at), out.id, 'owner', '--free', '--past-cap', '']);
    calls.length = 0;
    await server.onceMove({ name: 'owner' }, project, { id: out.id, at: at + 600 });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([['agent-kit-oneshot', 'unat', out.id], ['agent-kit-oneshot', 'at', String(at + 600)]]);
    calls.length = 0;
    await server.onceCancel({ name: 'owner' }, project, { id: out.id });
    expect(calls[0].slice(0, 3)).toEqual(['agent-kit-oneshot', 'unat', out.id]);
  });

  it('are refused on an older kit, in the past, or with a bad id', async () => {
    await expect(server.onceSet({}, project, { at: Math.round(Date.now() / 1000) - 10 })).rejects.toThrow(/between a minute and 31 days/);
    await expect(server.onceCancel({}, project, { id: 'x; id' })).rejects.toThrow(/Bad cycle id/);
    kitVersion = '0.25.0';
    await expect(server.onceSet({}, project, { at: soon() })).rejects.toThrow(/needs kit 0\.26\.0/);
    await expect(server.setSchedule({}, project, { tz: 'UTC', slots: [slot({ until: '2027-01-01' })] })).rejects.toThrow(/needs kit 0\.26\.0/);
    expect(calls).toHaveLength(0);
  });

  it('pass the VM refusal on', async () => {
    answer = { code: 2, stdout: '', stderr: 'agent-kit-oneshot: the time must be between now and 31 days ahead' };
    await expect(server.onceSet({}, project, { at: soon() })).rejects.toThrow('the time must be between now and 31 days ahead');
  });
});
