// Cycle schedules: the rules and the time arithmetic, shared by the server and
// the Schedule page. Pure functions, no DOM and no Node modules.
//
// A schedule is {tz, slots: [{days, time}]}: `days` is ['daily'] or a list of
// mon..sun, `time` is HH:MM, local to `tz`. The VM holds the same thing as text
// (kit script agent-kit-schedule) and is the one that starts the cycles.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const MAX_SLOTS = 100;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(\/[A-Za-z0-9_+-]{1,30}){0,2}$/;
const DAY_MS = 86_400_000;

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !TZ_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** ['wed','mon','wed'] -> ['mon','wed']; ['daily'] stays; anything else: null. */
function cleanDays(days) {
  if (!Array.isArray(days) || !days.length || days.length > 7) return null;
  if (days.length === 1 && days[0] === 'daily') return ['daily'];
  if (!days.every((d) => DAYS.includes(d))) return null;
  const out = DAYS.filter((d) => days.includes(d));
  return out.length === 7 ? ['daily'] : out;
}

export const slotId = (slot) => `${slot.days.join(',')}@${slot.time}`;

/** A checked copy of a schedule in its fixed form. Throws an Error that says what is wrong. */
export function validateSchedule(input) {
  if (!input || typeof input !== 'object') throw new Error('schedule: must be an object');
  if (!validTimeZone(input.tz)) throw new Error('tz: must be a time zone name like Europe/Amsterdam');
  if (!Array.isArray(input.slots) || !input.slots.length) throw new Error('slots: at least one (clear the schedule for none)');
  if (input.slots.length > MAX_SLOTS) throw new Error(`slots: at most ${MAX_SLOTS}`);
  const seen = new Set();
  const slots = [];
  for (const [i, s] of input.slots.entries()) {
    const days = cleanDays(s?.days);
    if (!days) throw new Error(`slot ${i + 1}: days must be daily or a list of ${DAYS.join(' ')}`);
    if (typeof s.time !== 'string' || !TIME_RE.test(s.time)) throw new Error(`slot ${i + 1}: the time must be HH:MM`);
    const slot = { days, time: s.time };
    if (seen.has(slotId(slot))) throw new Error(`slot ${i + 1}: the same slot twice (${days.join(',')} ${s.time})`);
    seen.add(slotId(slot));
    slots.push(slot);
  }
  slots.sort((a, b) => a.time.localeCompare(b.time) || slotId(a).localeCompare(slotId(b)));
  // One-day changes (kit 0.14.1), like editing one event of a recurring entry:
  // {kind: 'move', date, slot, time} or {kind: 'skip', date, slot}. Changes of
  // slots that no longer exist are dropped; one change per slot and day.
  const ids = new Set(slots.map(slotId));
  const changes = [];
  const seenChange = new Set();
  for (const c of Array.isArray(input.changes) ? input.changes : []) {
    if (!c || !['move', 'skip'].includes(c.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(c.date || '') || !ids.has(c.slot)) continue;
    if (c.kind === 'move' && !TIME_RE.test(c.time || '')) continue;
    const key = `${c.date} ${c.slot}`;
    if (seenChange.has(key)) continue;
    seenChange.add(key);
    changes.push(c.kind === 'move' ? { kind: 'move', date: c.date, slot: c.slot, time: c.time } : { kind: 'skip', date: c.date, slot: c.slot });
  }
  if (changes.length > 200) throw new Error('at most 200 one-day changes');
  changes.sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
  return { tz: input.tz, slots, changes };
}

/** The VM's text form. */
export function formatScheduleText(schedule) {
  const s = validateSchedule(schedule);
  return (
    [
      `tz ${s.tz}`,
      ...s.slots.map((x) => `slot ${x.days.join(',')} ${x.time}`),
      ...s.changes.map((c) => (c.kind === 'move' ? `move ${c.date} ${c.slot} ${c.time}` : `skip ${c.date} ${c.slot}`))
    ].join('\n') + '\n'
  );
}

/** Read the VM's text form. Anything that does not fit is left out; null when nothing usable is there. */
export function parseScheduleText(text) {
  let tz = null;
  const slots = [];
  const changes = [];
  for (const line of String(text || '').split('\n')) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'move' && w.length === 4) changes.push({ kind: 'move', date: w[1], slot: w[2], time: w[3] });
    else if (w[0] === 'skip' && w.length === 3) changes.push({ kind: 'skip', date: w[1], slot: w[2] });
    else if (w[0] === 'tz' && w.length === 2 && validTimeZone(w[1])) tz = w[1];
    else if (w[0] === 'slot' && w.length === 3 && TIME_RE.test(w[2])) {
      const days = cleanDays(w[1].split(','));
      if (days) slots.push({ days, time: w[2] });
    }
  }
  if (!tz || !slots.length) return null;
  try {
    return validateSchedule({ tz, slots: slots.slice(0, MAX_SLOTS), changes: changes.slice(0, 200) });
  } catch {
    return null;
  }
}

// ---- time zones --------------------------------------------------------------

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `ms`: {y, m, d, H, M}. */
export function wallClock(tz, ms) {
  const p = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, H: p.hour, M: p.minute };
}

const sameClock = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d && a.H === b.H && a.M === b.M;

/**
 * The instant at which the wall clock in `tz` shows the given time. null when
 * that time does not exist that day (clocks go forward); the first of the two
 * when it happens twice (clocks go back), as the VM uses it.
 */
export function instantOf(tz, y, m, d, H, M) {
  const want = { y, m, d, H, M };
  const asUtc = Date.UTC(y, m - 1, d, H, M);
  const offsetAt = (ms) => {
    const c = wallClock(tz, ms);
    return Date.UTC(c.y, c.m - 1, c.d, c.H, c.M) - ms;
  };
  for (const guess of [asUtc - offsetAt(asUtc), asUtc - offsetAt(asUtc - offsetAt(asUtc))]) {
    if (!sameClock(wallClock(tz, guess), want)) continue;
    const earlier = guess - 3_600_000;
    return sameClock(wallClock(tz, earlier), want) ? earlier : guess;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
export const dateString = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const parseDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};
/** A calendar date moved by whole days (plain calendar arithmetic, no time zone). */
function addDays(date, n) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
/** mon..sun for a calendar date. */
const dayName = (date) => DAYS[(new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay() + 6) % 7];
/** Midnight at the start of a calendar date in `tz` (the first instant of that date). */
function startOfDay(tz, date) {
  for (let H = 0; H < 4; H++) {
    for (const M of [0, 30]) {
      const t = instantOf(tz, date.y, date.m, date.d, H, M);
      if (t != null) return t;
    }
  }
  return Date.UTC(date.y, date.m - 1, date.d);
}

export function todayIn(tz, now = Date.now()) {
  return dateString(wallClock(tz, now));
}

/**
 * The range a view shows, in `tz`. view: 'day' | 'week' | 'month'. A week is
 * the seven days from `date` on (today by default): the schedule looks ahead.
 * Returns {from, to, date, prev, next, days: [{date, from, to, name}]}.
 */
export function rangeFor(view, date, tz, now = Date.now()) {
  let d = parseDate(date) || parseDate(todayIn(tz, now));
  let count = 1;
  let step = 1;
  if (view === 'week') {
    count = 7;
    step = 7;
  } else if (view === 'month') {
    d = { y: d.y, m: d.m, d: 1 };
    count = new Date(Date.UTC(d.y, d.m, 0)).getUTCDate();
  }
  const days = [];
  for (let i = 0; i < count; i++) {
    const day = addDays(d, i);
    days.push({ date: dateString(day), name: dayName(day), from: startOfDay(tz, day), to: startOfDay(tz, addDays(day, 1)) });
  }
  const prev = view === 'month' ? { y: d.m === 1 ? d.y - 1 : d.y, m: d.m === 1 ? 12 : d.m - 1, d: 1 } : addDays(d, -step);
  const next = view === 'month' ? { y: d.m === 12 ? d.y + 1 : d.y, m: d.m === 12 ? 1 : d.m + 1, d: 1 } : addDays(d, step);
  return { from: days[0].from, to: days.at(-1).to, date: dateString(d), prev: dateString(prev), next: dateString(next), days };
}

export const MIN_WINDOW = 3_600_000; // one hour
export const MAX_WINDOW = 62 * DAY_MS;

/**
 * Any stretch of time as a range the timeline can draw: {from, to, days}, where
 * `days` are the calendar days in `tz` that it touches (whole days, so a day's
 * own from/to may lie outside the window).
 */
export function windowRange(from, to, tz) {
  const days = [];
  let day = parseDate(todayIn(tz, from));
  for (let i = 0; i < 70; i++) {
    const start = startOfDay(tz, day);
    if (start >= to) break;
    const next = addDays(day, 1);
    days.push({ date: dateString(day), name: dayName(day), from: start, to: startOfDay(tz, next) });
    day = next;
  }
  return { from, to, days, date: days[0]?.date ?? todayIn(tz, from) };
}

/** A window kept inside sensible limits: at least an hour, at most two months. null when it is not one. */
export function cleanWindow(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const span = Math.min(Math.max(to - from, MIN_WINDOW), MAX_WINDOW);
  return { from: Math.round(from), to: Math.round(from + span) };
}

/**
 * Every start a schedule plans in [from, to): [{at, slot (index), id, date}], oldest first.
 * With `skipped`, a start that is skipped for one day is given too, at its
 * slot's own time and marked `skipped`: it does not run, but it can be shown.
 */
export function occurrences(schedule, from, to, { skipped = false } = {}) {
  if (!schedule?.slots?.length) return [];
  const out = [];
  const first = addDays(parseDate(todayIn(schedule.tz, from)), -1);
  const days = Math.ceil((to - from) / DAY_MS) + 3;
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    const name = dayName(date);
    const ds = dateString(date);
    schedule.slots.forEach((slot, index) => {
      if (slot.days[0] !== 'daily' && !slot.days.includes(name)) return;
      const id = slotId(slot);
      const change = (schedule.changes || []).find((c) => c.date === ds && c.slot === id);
      const skip = change?.kind === 'skip';
      if (skip && !skipped) return;
      const time = change?.kind === 'move' ? change.time : slot.time;
      const [H, M] = time.split(':').map(Number);
      const at = instantOf(schedule.tz, date.y, date.m, date.d, H, M);
      if (at != null && at >= from && at < to) out.push({ at, slot: index, id, date: ds, moved: change?.kind === 'move', ...(skip ? { skipped: true } : {}) });
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The next planned start after `now`, or null. */
export function nextStart(schedule, now = Date.now()) {
  return occurrences(schedule, now, now + 8 * DAY_MS)[0]?.at ?? null;
}

/** The time of day (HH:MM, snapped to `snap` minutes) the wall clock in `tz` shows at `ms`. */
export function timeOfDay(tz, ms, snap = 15) {
  const c = wallClock(tz, ms);
  let minutes = Math.round((c.H * 60 + c.M) / snap) * snap;
  if (minutes >= 1440) minutes = 1440 - snap;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// ---- how times and zones are shown --------------------------------------------

/** 'HH:MM' as the owner reads it: '13:30' or '1:30 PM'. */
export function clockLabel(time, clock = '24') {
  if (clock !== '12') return time;
  const [H, M] = time.split(':').map(Number);
  return `${H % 12 || 12}:${pad(M)} ${H < 12 ? 'AM' : 'PM'}`;
}
/** An hour on the axis: '14' or '2p'. */
export function hourLabel(H, clock = '24') {
  if (clock !== '12') return pad(H);
  return `${H % 12 || 12}${H < 12 ? 'a' : 'p'}`;
}

// The zones people usually mean, with the names they are known by. The list a
// browser offers has several hundred city names, most of them unfamiliar.
const COMMON_ZONES = [
  ['Pacific/Honolulu', 'Hawaii Time'],
  ['America/Anchorage', 'Alaska Time'],
  ['America/Los_Angeles', 'Pacific Time (Los Angeles)'],
  ['America/Phoenix', 'Mountain Time, no daylight saving (Phoenix)'],
  ['America/Denver', 'Mountain Time (Denver)'],
  ['America/Chicago', 'Central Time (Chicago)'],
  ['America/New_York', 'Eastern Time (New York)'],
  ['America/Halifax', 'Atlantic Time (Halifax)'],
  ['America/Mexico_City', 'Mexico City'],
  ['America/Bogota', 'Colombia, Peru (Bogota)'],
  ['America/Sao_Paulo', 'Brasilia Time (Sao Paulo)'],
  ['America/Argentina/Buenos_Aires', 'Argentina (Buenos Aires)'],
  ['UTC', 'Coordinated Universal Time'],
  ['Europe/London', 'UK Time (London)'],
  ['Europe/Lisbon', 'Western European Time (Lisbon)'],
  ['Europe/Amsterdam', 'Central European Time (Amsterdam, Berlin, Paris)'],
  ['Europe/Athens', 'Eastern European Time (Athens, Helsinki)'],
  ['Europe/Istanbul', 'Turkey (Istanbul)'],
  ['Europe/Moscow', 'Moscow Time'],
  ['Africa/Lagos', 'West Africa Time (Lagos)'],
  ['Africa/Cairo', 'Egypt (Cairo)'],
  ['Africa/Johannesburg', 'South Africa (Johannesburg)'],
  ['Asia/Dubai', 'Gulf Time (Dubai)'],
  ['Asia/Karachi', 'Pakistan (Karachi)'],
  ['Asia/Kolkata', 'India Time (Kolkata)'],
  ['Asia/Dhaka', 'Bangladesh (Dhaka)'],
  ['Asia/Bangkok', 'Indochina Time (Bangkok, Jakarta)'],
  ['Asia/Shanghai', 'China Time (Shanghai)'],
  ['Asia/Singapore', 'Singapore, Malaysia'],
  ['Asia/Tokyo', 'Japan Time (Tokyo)'],
  ['Asia/Seoul', 'Korea Time (Seoul)'],
  ['Australia/Perth', 'Australian Western Time (Perth)'],
  ['Australia/Adelaide', 'Australian Central Time (Adelaide)'],
  ['Australia/Sydney', 'Australian Eastern Time (Sydney)'],
  ['Pacific/Auckland', 'New Zealand Time (Auckland)']
];

/** Minutes a zone is ahead of UTC at instant `ms`. */
function offsetMinutes(tz, ms) {
  const c = wallClock(tz, ms);
  return Math.round((Date.UTC(c.y, c.m - 1, c.d, c.H, c.M) - Math.floor(ms / 60000) * 60000) / 60000);
}
/** 'EST', 'CDT'... when the zone has a letter name in English; '' otherwise. */
function shortName(tz, ms) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
    return part && /^[A-Z]{2,5}$/.test(part.value) && part.value !== 'GMT' ? part.value : '';
  } catch {
    return '';
  }
}
/** 'EST · UTC-05:00 · Eastern Time (New York)' for a zone, as of `now`. */
export function zoneLabel(tz, now = Date.now()) {
  if (!validTimeZone(tz)) return tz;
  const off = offsetMinutes(tz, now);
  const sign = off < 0 ? '-' : '+';
  const utc = tz === 'UTC' ? 'UTC' : `UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  const known = COMMON_ZONES.find(([z]) => z === tz);
  const abbr = shortName(tz, now);
  return [abbr, abbr === utc ? '' : utc, known ? known[1] : tz.replace(/_/g, ' ')].filter(Boolean).join(' · ');
}
/** The zones offered in a picker, west to east: [{tz, label}]. `also`: zones in use that are not on the list. */
export function zoneChoices(also = [], now = Date.now()) {
  const all = [...COMMON_ZONES.map(([z]) => z)];
  for (const z of also) if (validTimeZone(z) && !all.includes(z)) all.push(z);
  return all
    .filter((z) => validTimeZone(z))
    .map((tz) => ({ tz, label: zoneLabel(tz, now), off: offsetMinutes(tz, now) }))
    .sort((a, b) => a.off - b.off || a.label.localeCompare(b.label))
    .map(({ tz, label }) => ({ tz, label }));
}

// ---- quiet hours and warnings ------------------------------------------------

/** Owner settings: {timezone, quiet: [{days, from, to}], clock: '12' | '24'}. Throws an Error that says what is wrong. */
export function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('settings: must be an object');
  if (!validTimeZone(input.timezone)) throw new Error('timezone: must be a time zone name like Europe/Amsterdam');
  if (!Array.isArray(input.quiet) || input.quiet.length > 20) throw new Error('quiet: a list of at most 20 entries');
  const quiet = input.quiet.map((q, i) => {
    const days = cleanDays(q?.days);
    if (!days) throw new Error(`quiet hours ${i + 1}: days must be daily or a list of ${DAYS.join(' ')}`);
    if (!TIME_RE.test(q.from || '') || !TIME_RE.test(q.to || '') || q.from === q.to) throw new Error(`quiet hours ${i + 1}: two different times, HH:MM`);
    return { days, from: q.from, to: q.to };
  });
  if (input.clock != null && input.clock !== '12' && input.clock !== '24') throw new Error('clock: 12 or 24');
  return { timezone: input.timezone, quiet, clock: input.clock === '12' ? '12' : '24' };
}

/** Quiet hours as intervals inside [from, to): [{from, to}]. A range that ends before it starts runs past midnight. */
export function quietIntervals(settings, from, to) {
  const out = [];
  if (!settings?.quiet?.length) return out;
  const tz = settings.timezone;
  const first = addDays(parseDate(todayIn(tz, from)), -1);
  const days = Math.ceil((to - from) / DAY_MS) + 3;
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    for (const q of settings.quiet) {
      if (q.days[0] !== 'daily' && !q.days.includes(dayName(date))) continue;
      const [h1, m1] = q.from.split(':').map(Number);
      const [h2, m2] = q.to.split(':').map(Number);
      const end = q.to > q.from ? date : addDays(date, 1);
      const a = instantOf(tz, date.y, date.m, date.d, h1, m1) ?? startOfDay(tz, date);
      const b = instantOf(tz, end.y, end.m, end.d, h2, m2) ?? startOfDay(tz, end);
      if (b > from && a < to) out.push({ from: Math.max(a, from), to: Math.min(b, to) });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

const slotWords = (slot, clock) => `${slot.days[0] === 'daily' ? 'daily' : slot.days.join(', ')} ${clockLabel(slot.time, clock)}`;

/**
 * What is planned in [from, to) and what the owner should know about it.
 * projects: [{id, name, schedule, typicalSecs, cap}]. A week is enough to find
 * every problem of a weekly pattern.
 * Returns {planned: {id: [{at, end, slot, id, flags: []}]}, warnings: [{kind, project, slot, text}]}.
 */
export function plan(projects, settings, from, to) {
  const planned = {};
  const warnings = [];
  const clock = settings?.clock;
  const said = new Set();
  const warn = (key, w) => {
    if (said.has(key)) return;
    said.add(key);
    warnings.push(w);
  };
  for (const p of projects) {
    planned[p.id] = occurrences(p.schedule, from, to).map((o) => ({ ...o, end: o.at + (p.typicalSecs || 3600) * 1000, flags: [] }));
  }
  const quiet = quietIntervals(settings, from, to);
  for (const p of projects) {
    for (const bar of planned[p.id]) {
      if (quiet.some((q) => bar.at >= q.from && bar.at < q.to)) {
        bar.flags.push('quiet');
        warn(`quiet ${p.id} ${bar.id}`, { kind: 'quiet', project: p.id, slot: bar.id, text: `${p.name}: the start time ${slotWords(p.schedule.slots[bar.slot], clock)} is inside your quiet hours.` });
      }
    }
    // The cap counts by the VM's day, which is a UTC day.
    if (Number.isInteger(p.cap)) {
      const perDay = new Map();
      for (const bar of planned[p.id]) {
        const day = new Date(bar.at).toISOString().slice(0, 10);
        perDay.set(day, (perDay.get(day) || 0) + 1);
      }
      const most = Math.max(0, ...perDay.values());
      if (most > p.cap) warn(`cap ${p.id}`, { kind: 'cap', project: p.id, slot: null, text: `${p.name}: up to ${most} start times on one day, but the daily cap is ${p.cap}. The ones beyond the cap are skipped. Raise the cap under Controls.` });
    }
  }
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i];
      const b = projects[j];
      for (const x of planned[a.id]) {
        for (const y of planned[b.id]) {
          if (x.at < y.end && y.at < x.end) {
            if (!x.flags.includes('overlap')) x.flags.push('overlap');
            if (!y.flags.includes('overlap')) y.flags.push('overlap');
            warn(`overlap ${a.id} ${x.id} ${b.id} ${y.id}`, {
              kind: 'overlap',
              project: a.id,
              slot: x.id,
              text: `${a.name} (${slotWords(a.schedule.slots[x.slot], clock)}) and ${b.name} (${slotWords(b.schedule.slots[y.slot], clock)}) are likely to run at the same time.`
            });
          }
        }
      }
    }
  }
  return { planned, warnings };
}

/**
 * What a job placed at [start, start + minutes) would run into on its team's
 * row: planned cycle starts (with their typical length) and other backlog jobs
 * that are set or running. `ignore` is the id of a job being moved.
 * [{kind: 'cycle', at, end, slot} | {kind: 'job', at, end, title}]
 */
export function conflictsAt(planned = [], jobs = [], start, minutes, ignore = null, now = Date.now()) {
  const end = start + minutes * 60000;
  const out = [];
  for (const b of planned) {
    if (b.at < end && start < b.end) out.push({ kind: 'cycle', at: b.at, end: b.end, slot: b.id });
  }
  for (const j of jobs) {
    if (j.id === ignore || (j.state !== 'set' && j.state !== 'running')) continue;
    const e = j.state === 'running' ? Math.max(j.estEnd, now) : j.estEnd;
    if (j.start < end && start < e) out.push({ kind: 'job', at: j.start, end: e, title: j.title });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The first start after `start` (on the quarter hour) where the job runs into nothing. */
export function placeAfter(planned, jobs, start, minutes, ignore = null, now = Date.now()) {
  const Q = 15 * 60000;
  let t = start;
  for (let i = 0; i < 50; i++) {
    const hit = conflictsAt(planned, jobs, t, minutes, ignore, now);
    if (!hit.length) return t;
    t = Math.ceil(Math.max(...hit.map((h) => h.end)) / Q) * Q;
  }
  return t;
}
