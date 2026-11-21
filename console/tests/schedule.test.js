import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-schedule-'));
process.env.CONSOLE_DATA_DIR = path.join(T, 'data');
process.env.CONSOLE_CONFIG_DIR = path.join(T, 'config');
fs.mkdirSync(process.env.CONSOLE_CONFIG_DIR, { recursive: true });
const FLEET = path.join(T, 'fleet');
fs.mkdirSync(path.join(FLEET, 'alpha'), { recursive: true });
fs.writeFileSync(
  path.join(T, 'config', 'projects.json'),
  JSON.stringify({ projects: [{ id: 'alpha', name: 'Alpha', ssh: { alias: 'alpha' }, paths: { fleet: path.join(FLEET, 'alpha'), transcripts: path.join(T, 'tr') } }] })
);

const calls = [];
let answer = { code: 0, stdout: 'schedule set: 2 slot(s)\n', stderr: '' };
let status = { reachable: true, state: 'idle', kitVersion: '0.9.0', cap: 4, schedule: 'tz America/New_York\nslot daily 01:00\n', leadActive: false };
vi.mock('../src/lib/server/ssh.js', async (importOriginal) => ({
  ...(await importOriginal()),
  kit: async (project, script, argv, opts = {}) => {
    calls.push({ project: project.id, script, argv, input: opts.input ?? null });
    return answer;
  }
}));
vi.mock('../src/lib/server/view.js', () => ({ statusSoon: async () => status }));

const lib = await import('../src/lib/schedule.js');
const server = await import('../src/lib/server/schedule.js');
const config = await import('../src/lib/server/config.js');
const user = { name: 'owner' };
const NY = 'America/New_York';
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

beforeEach(() => {
  calls.length = 0;
  answer = { code: 0, stdout: 'schedule set\n', stderr: '' };
});

describe('a schedule', () => {
  it('is kept in one fixed form', () => {
    const s = lib.validateSchedule({ tz: NY, slots: [{ days: ['wed', 'mon', 'wed'], time: '13:30' }, { days: DAYS7(), time: '01:00' }] });
    expect(s).toEqual({ tz: NY, slots: [{ days: ['daily'], time: '01:00' }, { days: ['mon', 'wed'], time: '13:30' }] });
    expect(lib.formatScheduleText(s)).toBe('tz America/New_York\nslot daily 01:00\nslot mon,wed 13:30\n');
    expect(lib.parseScheduleText(lib.formatScheduleText(s))).toEqual(s);
  });

  it('says what is wrong with a bad one', () => {
    const bad = (input, re) => expect(() => lib.validateSchedule(input)).toThrow(re);
    bad({ tz: 'Mars/Phobos', slots: [{ days: ['daily'], time: '01:00' }] }, /tz/);
    bad({ tz: '../../etc/passwd', slots: [{ days: ['daily'], time: '01:00' }] }, /tz/);
    bad({ tz: NY, slots: [] }, /at least one/);
    bad({ tz: NY, slots: [{ days: ['funday'], time: '01:00' }] }, /days/);
    bad({ tz: NY, slots: [{ days: ['daily'], time: '24:00' }] }, /time/);
    bad({ tz: NY, slots: [{ days: ['daily'], time: '01:00; rm -rf /' }] }, /time/);
    bad({ tz: NY, slots: [{ days: ['mon', 'wed'], time: '01:00' }, { days: ['wed', 'mon'], time: '01:00' }] }, /twice/);
    bad({ tz: NY, slots: Array.from({ length: 101 }, (_, i) => ({ days: ['daily'], time: `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` })) }, /at most/);
  });

  it('read from a VM, lines that do not fit are left out', () => {
    expect(lib.parseScheduleText('tz America/New_York\nslot daily 01:00\nslot daily 99:00\nrun something\nslot nope 02:00\n')).toEqual({ tz: NY, slots: [{ days: ['daily'], time: '01:00' }] });
    expect(lib.parseScheduleText('')).toBeNull();
    expect(lib.parseScheduleText('slot daily 01:00\n')).toBeNull();
    expect(lib.parseScheduleText('tz Nowhere/Land\nslot daily 01:00\n')).toBeNull();
  });
});
function DAYS7() {
  return [...lib.DAYS];
}

describe('times in a time zone', () => {
  const s = { tz: NY, slots: [{ days: ['daily'], time: '02:30' }, { days: ['daily'], time: '01:30' }] };

  it('a week with the clocks going forward is an hour short, and 02:30 does not happen that day', () => {
    const r = lib.rangeFor('week', '2026-03-08', NY);
    expect([r.date, r.prev, r.next]).toEqual(['2026-03-02', '2026-02-23', '2026-03-09']);
    expect((r.to - r.from) / 3_600_000).toBe(167);
    const at = lib.occurrences(s, r.from, r.to).filter((o) => o.id === 'daily@02:30').map((o) => iso(o.at));
    expect(at).toHaveLength(6);
    expect(at).not.toContain('2026-03-08T06:30');
    expect(at[0]).toBe('2026-03-02T07:30');
    expect(lib.instantOf(NY, 2026, 3, 8, 2, 30)).toBeNull();
  });

  it('a time that happens twice is used once, the first time', () => {
    const r = lib.rangeFor('day', '2026-11-01', NY);
    expect((r.to - r.from) / 3_600_000).toBe(25);
    expect(lib.occurrences(s, r.from, r.to).filter((o) => o.id === 'daily@01:30').map((o) => iso(o.at))).toEqual(['2026-11-01T05:30']);
  });

  it('days of the week follow the calendar of the schedule, not UTC', () => {
    // Monday 20:30 in New York is already Tuesday in UTC.
    const mon = { tz: NY, slots: [{ days: ['mon'], time: '20:30' }] };
    const r = lib.rangeFor('week', '2026-01-07', NY);
    expect(lib.occurrences(mon, r.from, r.to).map((o) => iso(o.at))).toEqual(['2026-01-06T01:30']);
  });

  it('a month view covers the whole month; the next start and a snapped time of day', () => {
    const r = lib.rangeFor('month', '2026-02-14', NY);
    expect(r.days).toHaveLength(28);
    expect([r.prev, r.next]).toEqual(['2026-01-01', '2026-03-01']);
    expect(lib.rangeFor('month', '2026-12-05', NY).next).toBe('2027-01-01');
    const now = Date.parse('2026-01-05T12:00:00Z');
    expect(iso(lib.nextStart({ tz: NY, slots: [{ days: ['daily'], time: '13:00' }] }, now))).toBe('2026-01-05T18:00');
    expect(lib.timeOfDay(NY, Date.parse('2026-01-05T18:07:00Z'))).toBe('13:00');
    expect(lib.timeOfDay(NY, Date.parse('2026-01-05T18:08:00Z'))).toBe('13:15');
    expect(lib.timeOfDay(NY, Date.parse('2026-01-06T04:58:00Z'))).toBe('23:45');
  });
});

describe('how times and zones are shown', () => {
  it('a 12 or a 24 hour clock', () => {
    expect([lib.clockLabel('00:05'), lib.clockLabel('00:05', '12'), lib.clockLabel('12:00', '12'), lib.clockLabel('13:30', '12'), lib.clockLabel('23:45', '12')]).toEqual(['00:05', '12:05 AM', '12:00 PM', '1:30 PM', '11:45 PM']);
    expect([lib.hourLabel(0), lib.hourLabel(0, '12'), lib.hourLabel(12, '12'), lib.hourLabel(14, '12'), lib.hourLabel(14)]).toEqual(['00', '12a', '12p', '2p', '14']);
  });

  it('zones by the names people use, with the offset of the day', () => {
    const winter = Date.parse('2026-01-15T12:00:00Z');
    const summer = Date.parse('2026-07-15T12:00:00Z');
    expect(lib.zoneLabel(NY, winter)).toBe('EST · UTC-05:00 · Eastern Time (New York)');
    expect(lib.zoneLabel(NY, summer)).toBe('EDT · UTC-04:00 · Eastern Time (New York)');
    expect(lib.zoneLabel('UTC', winter)).toBe('UTC · Coordinated Universal Time');
    expect(lib.zoneLabel('Asia/Kolkata', winter)).toBe('UTC+05:30 · India Time (Kolkata)');
    const choices = lib.zoneChoices(['America/Creston', NY, 'not a zone'], winter);
    // West to east, the familiar ones, and a zone already in use is kept even if it is not on the list.
    expect(choices.map((c) => c.tz).indexOf('America/Los_Angeles')).toBeLessThan(choices.map((c) => c.tz).indexOf(NY));
    expect(choices.filter((c) => c.tz === NY)).toHaveLength(1);
    expect(choices.find((c) => c.tz === 'America/Creston').label).toBe('MST · UTC-07:00 · America/Creston');
    expect(choices.some((c) => c.tz === 'not a zone')).toBe(false);
    expect(choices.length).toBeLessThan(45);
  });

  it('any stretch of time can be shown', () => {
    const w = lib.windowRange(Date.parse('2026-01-07T17:00:00Z'), Date.parse('2026-01-08T17:00:00Z'), NY);
    expect(w.days.map((d) => `${d.date} ${d.name}`)).toEqual(['2026-01-07 wed', '2026-01-08 thu']);
    expect(w.date).toBe('2026-01-07');
    expect(lib.cleanWindow(1000, 2000)).toEqual({ from: 1000, to: 1000 + lib.MIN_WINDOW });
    expect(lib.cleanWindow(0, 400 * 86_400_000).to).toBe(lib.MAX_WINDOW);
    expect(lib.cleanWindow(NaN, 5)).toBeNull();
  });
});

describe('what the owner is told', () => {
  const settings = { timezone: NY, quiet: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' }] };
  const r = lib.rangeFor('week', '2026-01-07', NY);
  const a = { id: 'a', name: 'Alpha', typicalSecs: 5400, cap: 2, schedule: { tz: NY, slots: [{ days: ['daily'], time: '01:00' }, { days: ['daily'], time: '13:00' }, { days: ['daily'], time: '19:00' }] } };
  const b = { id: 'b', name: 'Beta', typicalSecs: 3600, cap: 4, schedule: { tz: NY, slots: [{ days: ['daily'], time: '02:00' }] } };

  it('overlaps, quiet hours and the cap, each once', () => {
    const { planned, warnings } = lib.plan([a, b], settings, r.from, r.to);
    expect(planned.a).toHaveLength(21);
    expect(warnings.map((w) => w.kind).sort()).toEqual(['cap', 'overlap', 'quiet']);
    expect(warnings.find((w) => w.kind === 'overlap').text).toMatch(/Alpha \(daily 01:00\) and Beta \(daily 02:00\)/);
    expect(warnings.find((w) => w.kind === 'quiet').text).toMatch(/Alpha: the start time daily 13:00 is inside your quiet hours/);
    expect(warnings.find((w) => w.kind === 'cap').text).toMatch(/3 start times on one day, but the daily cap is 2/);
    // The owner's clock is used in what is said.
    const said = lib.plan([a, b], { ...settings, clock: '12' }, r.from, r.to).warnings.map((w) => w.text).join(' ');
    expect(said).toMatch(/Alpha \(daily 1:00 AM\) and Beta \(daily 2:00 AM\)/);
    expect(said).toMatch(/daily 1:00 PM is inside/);
    // A weekend 13:00 is not in the quiet hours; a weekday one is.
    const flags = (iso0) => planned.a.find((x) => iso(x.at) === iso0).flags;
    expect(flags('2026-01-07T18:00')).toContain('quiet');
    expect(flags('2026-01-10T18:00')).not.toContain('quiet');
    expect(flags('2026-01-07T06:00')).toContain('overlap');
  });

  it('nothing to say when teams are apart and outside quiet hours', () => {
    const calm = lib.plan([{ ...a, cap: 4, schedule: { tz: NY, slots: [{ days: ['daily'], time: '01:00' }] } }, { ...b, schedule: { tz: NY, slots: [{ days: ['daily'], time: '05:00' }] } }], settings, r.from, r.to);
    expect(calm.warnings).toEqual([]);
  });

  it('quiet hours may run past midnight', () => {
    const night = { timezone: NY, quiet: [{ days: ['daily'], from: '22:00', to: '06:00' }] };
    const day = lib.rangeFor('day', '2026-01-07', NY);
    const q = lib.quietIntervals(night, day.from, day.to);
    expect(q.map((x) => [iso(x.from), iso(x.to)])).toEqual([
      ['2026-01-07T05:00', '2026-01-07T11:00'],
      ['2026-01-08T03:00', '2026-01-08T05:00']
    ]);
    expect(() => lib.validateSettings({ timezone: NY, quiet: [{ days: ['daily'], from: '09:00', to: '09:00' }] })).toThrow(/two different times/);
    expect(() => lib.validateSettings({ timezone: 'Nowhere', quiet: [] })).toThrow(/timezone/);
    expect(lib.validateSettings({ timezone: NY, quiet: [] }).clock).toBe('24');
    expect(lib.validateSettings({ timezone: NY, quiet: [], clock: '12' }).clock).toBe('12');
    expect(() => lib.validateSettings({ timezone: NY, quiet: [], clock: 'am' })).toThrow(/clock/);
  });
});

describe('the server side', () => {
  const project = () => config.getProject('alpha');

  it('sends a schedule as text to the one fixed script', async () => {
    const out = await server.setSchedule(user, project(), { tz: NY, slots: [{ days: ['fri', 'mon'], time: '13:30' }, { days: ['daily'], time: '01:00' }] });
    expect(out.ok).toBe(true);
    expect(calls).toEqual([{ project: 'alpha', script: 'agent-kit-schedule', argv: ['set'], input: 'tz America/New_York\nslot daily 01:00\nslot mon,fri 13:30\n' }]);
  });

  it('a bad schedule never reaches the VM', async () => {
    await expect(server.setSchedule(user, project(), { tz: NY, slots: [{ days: ['daily'], time: '1:00\nslot daily 02:00' }] })).rejects.toMatchObject({ status: 400 });
    await expect(server.setSchedule(user, project(), { tz: 'x; reboot', slots: [{ days: ['daily'], time: '01:00' }] })).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it('passes on a refusal from the VM, and clears with the same script', async () => {
    answer = { code: 2, stdout: '', stderr: 'agent-kit-schedule: line 1: unknown time zone: X\n' };
    await expect(server.setSchedule(user, project(), { tz: NY, slots: [{ days: ['daily'], time: '01:00' }] })).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/unknown time zone/) });
    answer = { code: 0, stdout: 'no schedule\n', stderr: '' };
    await server.clearSchedule(user, project());
    expect(calls.at(-1)).toMatchObject({ script: 'agent-kit-schedule', argv: ['clear'] });
  });

  it('keeps the owner settings in the config folder, checked', () => {
    expect(server.getSettings().quiet).toEqual([]);
    const s = server.saveSettings(user, { timezone: NY, quiet: [{ days: ['sat', 'sun'], from: '10:00', to: '14:00' }] });
    expect(server.getSettings()).toEqual(s);
    expect(() => server.saveSettings(user, { timezone: NY, quiet: [{ days: ['sat'], from: 'noon', to: '14:00' }] })).toThrow(/quiet hours 1/);
    fs.writeFileSync(path.join(T, 'config', 'schedule.json'), '{"timezone": 7}');
    expect(server.getSettings().quiet).toEqual([]);
    server.saveSettings(user, s);
  });

  it('a typical cycle is the median of the last real ones', () => {
    const c = (secs, extra = {}) => ({ secs, counted: true, halted: false, ...extra });
    expect(server.typicalSecs([])).toBe(3600);
    expect(server.typicalSecs([c(600), c(1200), c(6000)])).toBe(1200);
    expect(server.typicalSecs([c(600), c(1200), c(9000, { halted: true }), c(20, {}), c(30000, { counted: false })])).toBe(900);
  });

  it('leaves planning cycles and chat turns out of the typical length', () => {
    const c = (secs, kind) => ({ secs, counted: true, halted: false, kind });
    expect(server.typicalSecs([c(600, 'normal'), c(1200, 'oneshot'), c(90, 'plan'), c(70, 'plan'), c(65, 'chat')])).toBe(900);
  });

  it('builds the timeline from the ledger, the status and the slot log', async () => {
    const dir = path.join(FLEET, 'alpha');
    fs.writeFileSync(
      path.join(dir, 'cycles.jsonl'),
      [
        { date: '2026-01-07', start: '2026-01-07T06:00:10+00:00', end: '2026-01-07T07:10:00+00:00', secs: 4190, counted: true, limited: true },
        { date: '2025-12-01', start: '2025-12-01T06:00:00+00:00', end: '2025-12-01T07:00:00+00:00', secs: 3600, counted: true }
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n'
    );
    fs.writeFileSync(path.join(dir, 'schedule.log'), '2026-01-07T06:00:02Z daily@01:00 2026-01-07 started\n2026-01-07T18:00:01Z daily@13:00 2026-01-07 skipped: daily cap (4/4)\n<script>alert(1)</script>\n2026-01-07T19:00:00Z bad slot name here\n');
    const tl = await server.timeline({ view: 'day', date: '2026-01-07' });
    expect(tl.view).toBe('day');
    const p = tl.projects[0];
    expect(p).toMatchObject({ id: 'alpha', canSchedule: true, cap: 4, schedule: { tz: NY, slots: [{ days: ['daily'], time: '01:00' }] } });
    expect(p.past).toHaveLength(1);
    expect(p.past[0].limited).toBe(true);
    expect(p.log.map((l) => l.what)).toEqual(['started', 'skipped: daily cap (4/4)']);
    status = { ...status, kitVersion: '0.8.0' };
    expect((await server.timeline({ view: 'nonsense' })).view).toBe('week');
    // A window the owner moved or zoomed to; data is given for a wider stretch than is shown.
    const from = Date.parse('2026-01-07T08:00:00Z');
    const zoomed = await server.timeline({ view: 'day', from: String(from), to: String(from + 4 * 3_600_000) });
    expect(zoomed).toMatchObject({ view: 'day', custom: true, range: { from, to: from + 4 * 3_600_000 } });
    expect(zoomed.projects[0].past).toHaveLength(1); // the 06:00 cycle, just before the window
    expect((await server.timeline({ view: 'day', from: 'x', to: '5' })).custom).toBe(false);
    expect((await server.timeline({ view: 'month', from: String(from), to: String(from + 1000) })).custom).toBe(false);
    expect((await server.timeline({})).projects[0].canSchedule).toBe(false);
    status = { ...status, kitVersion: '0.9.0' };
  });
});
