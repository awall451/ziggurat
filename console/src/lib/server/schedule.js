// Cycle schedules, server side: what the Schedule page shows, and the two
// things it can change (a project's schedule on its VM, the owner's settings).
//
// The VM starts the cycles itself, from /etc/agent-kit/schedule; the console
// only reads that file (with the status) and replaces it through the fixed kit
// script agent-kit-schedule. Teams keep their schedule when the console is off.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, listProjects, readJson, writeJson } from './config.js';
import { kit } from './ssh.js';
import { audit } from './audit.js';
import { invalidateStatus, kitAtLeast, peekStatus, runCycleState } from './live.js';
import { readCycles, typicalCycle } from './aggregate.js';
import { statusSoon } from './view.js';
import { jobsFor } from './backlog.js';
import { parseScheduleText, formatScheduleText, validateSchedule, validateSettings, validTimeZone, rangeFor, windowRange, cleanWindow, usesRepeat, REPEAT_KIT } from '../schedule.js';

export const SCHEDULE_KIT = '0.9.0';
const SETTINGS_FILE = path.join(CONFIG_DIR, 'schedule.json');
const VIEWS = ['day', 'week', 'month'];

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** The owner's settings for the timeline: its time zone and the quiet hours. */
export function getSettings() {
  const raw = readJson(SETTINGS_FILE, null);
  try {
    if (raw) return validateSettings(raw);
  } catch {
    /* a file edited by hand into something unusable: fall back */
  }
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { timezone: validTimeZone(guess) ? guess : 'UTC', quiet: [], clock: '24' };
}

export function saveSettings(user, input) {
  let s;
  try {
    s = validateSettings(input);
  } catch (e) {
    throw fail(400, e.message);
  }
  writeJson(SETTINGS_FILE, s);
  audit(user, null, 'schedule-settings', { timezone: s.timezone, quiet: s.quiet.length, clock: s.clock });
  return s;
}

/** A typical cycle length for a project, in seconds: the median of its last ten real cycles. */
export function typicalSecs(cycles) {
  const secs = cycles
    // Normal cycles and one-shot jobs only: planning cycles and chat turns are short and say nothing about a cycle's length.
    .filter((c) => c.counted && !c.halted && c.kind !== 'chat' && c.kind !== 'talk' && c.kind !== 'plan' && Number.isFinite(c.secs) && c.secs > 60)
    .slice(-10)
    .map((c) => c.secs)
    .sort((a, b) => a - b);
  if (!secs.length) return 3600;
  const mid = Math.floor(secs.length / 2);
  return Math.round(secs.length % 2 ? secs[mid] : (secs[mid - 1] + secs[mid]) / 2);
}

/** What the VM decided at each slot, from its pulled log: [{at, slot, day, what}]. */
function readSlotLog(fleet, from, to) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(fleet, 'schedule.log'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n').slice(-600)) {
    // A one-time cycle (kit 0.26) that did not run: "<time> job:<id> <date> missed: <why>".
    const once = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) job:([0-9]{8}T[0-9]{6}Z-f-[a-z0-9-]{1,40}) (\d{4}-\d{2}-\d{2}) (missed: [A-Za-z0-9 :()\/-]{1,80})$/.exec(line);
    if (once) {
      const at = Date.parse(once[1]);
      if (at >= from && at < to) out.push({ at, slot: 'once', day: once[3], what: `one-time cycle ${once[4]}` });
      continue;
    }
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) ([a-z,]{3,27}@\d{2}:\d{2}) (\d{4}-\d{2}-\d{2}) ([A-Za-z0-9 :()\/-]{1,80})$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (at >= from && at < to) out.push({ at, slot: m[2], day: m[3], what: m[4] });
  }
  return out;
}

/**
 * Everything the Schedule page shows. Either a calendar view (`view`, `date`),
 * or any window (`from`, `to` in ms) that the owner panned or zoomed to; a
 * window keeps `view` as the kind it came from ('day' or 'week').
 * Past cycles and the slot log are given for a wider stretch than the window,
 * so the page can pan a little before it has to ask again.
 */
export async function timeline({ view = 'day', date = null, from = null, to = null } = {}) {
  const settings = getSettings();
  let v = VIEWS.includes(view) ? view : 'day';
  const win = v === 'month' || from == null || to == null ? null : cleanWindow(Number(from), Number(to));
  const range = win ? windowRange(win.from, win.to, settings.timezone) : rangeFor(v, date, settings.timezone);
  const custom = !!win;
  const pad = v === 'month' ? 0 : range.to - range.from;
  const dataFrom = range.from - pad;
  const dataTo = range.to + pad;
  const projects = await Promise.all(
    listProjects()
      .filter((p) => !p.hidden)
      .map(async (p) => {
        const status = await statusSoon(p, 2500);
        const cycles = readCycles(p.paths.fleet);
        // Backlog jobs are drawn as jobs, with their estimate: not again as plain cycles.
        let jobs = [];
        try {
          jobs = jobsFor(p, status).filter((j) => (j.end ?? Math.max(j.estEnd, Date.now())) > dataFrom && j.start < dataTo);
        } catch {
          /* no backlog yet */
        }
        // One-time cycles set for a time (kit 0.26): drawn like planned jobs, with a typical cycle's length.
        jobs.push(...onceJobs(status, cycles, dataFrom, dataTo));
        const jobIds = new Set(jobs.map((j) => j.id));
        const past = [];
        for (const c of cycles) {
          // Chat turns with the lead are not drawn: they are seconds long and not cycles.
          if (c.kind === 'chat' || c.kind === 'talk' || (c.oneshot && jobIds.has(c.oneshot))) continue;
          const start = Date.parse(c.start);
          const end = Date.parse(c.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= dataFrom || start >= dataTo) continue;
          past.push({ start, end, limited: c.limited, halted: c.halted, costUsd: c.costUsd });
        }
        const since = status.leadActive && status.leadSince && !jobs.some((j) => j.state === 'running' && j.id === status.oneshot?.id) ? Date.parse(status.leadSince) : NaN;
        return {
          id: p.id,
          name: p.name,
          accent: p.accent,
          state: status.state,
          reachable: status.reachable,
          kitVersion: status.kitVersion || null,
          canSchedule: kitAtLeast(status.kitVersion, SCHEDULE_KIT),
          // Every N, first and last dates, a number of times, and one-time cycles (kit 0.26).
          canRepeat: kitAtLeast(status.kitVersion, REPEAT_KIT),
          // Focus mode (kit 0.27): in focus, or paused for another team's.
          focus: status.focus || null,
          cap: Number.isInteger(status.cap) ? status.cap : null,
          schedule: parseScheduleText(status.schedule),
          typicalSecs: typicalSecs(cycles),
          // Run a cycle now (kit 0.25).
          runCycle: { ...runCycleState(status), typical: typicalCycle(cycles) },
          past,
          running: Number.isFinite(since) ? { start: since } : null,
          // The cycle or job in progress is stuck, and why (kit 0.24).
          stalled: status.leadActive ? status.stalled || null : null,
          log: readSlotLog(p.paths.fleet, dataFrom, dataTo),
          atJobs: status.atJobs || [],
          // Backlog jobs (approved items, planning cycles set for a time), drawn with their estimate.
          jobs
        };
      })
  );
  return { view: v, custom, range, settings, projects, now: Date.now() };
}

/**
 * One-time cycles set for a time (agent-kit-oneshot at --free): as jobs for
 * the timeline, `kind: 'once'`, with the team's typical cycle length.
 */
export function onceJobs(status, cycles, from = -Infinity, to = Infinity) {
  const secs = typicalCycle(cycles).secs || 3600;
  const minutes = Math.max(5, Math.round(secs / 60));
  return (Array.isArray(status?.atJobs) ? status.atJobs : [])
    .filter((j) => j.free && j.at * 1000 + minutes * 60000 > from && j.at * 1000 < to)
    .map((j) => ({
      id: j.id,
      kind: 'once',
      pid: null,
      order: null,
      title: 'One-time cycle',
      minutes,
      cost: null,
      start: j.at * 1000,
      estEnd: j.at * 1000 + minutes * 60000,
      end: null,
      state: 'set',
      pastCap: !!j.pastCap,
      wait: j.wait || null
    }));
}

const FREE_ID = /^[0-9]{8}T[0-9]{6}Z-f-[a-z0-9-]{1,40}$/;
const sender = (user) => (user?.name && /^[A-Za-z0-9._@-]{1,80}$/.test(user.name) ? user.name : 'owner');
const kitWords = (res) => (res.stderr || res.stdout || '').trim().split('\n').at(-1)?.replace(/^agent-kit-oneshot:\s*/, '').slice(0, 300) || `exit ${res.code}`;

function onceTime(at) {
  const t = Number(at);
  const now = Date.now() / 1000;
  if (!Number.isInteger(t) || t < now + 60 || t > now + 31 * 86400) throw fail(400, 'Pick a time between a minute and 31 days from now');
  return t;
}
function needsKit(project, want, what) {
  const have = peekStatus(project.id)?.kitVersion;
  if (!kitAtLeast(have, want)) throw fail(400, `${what} needs kit ${want} on ${project.name}'s VM (it has ${have || 'an older one'}).`);
}

/** A one-time cycle: one normal cycle at a set time, then the team goes back to how it was. */
export async function onceSet(user, project, { at, pastCap = false } = {}) {
  needsKit(project, REPEAT_KIT, 'A one-time cycle');
  const t = onceTime(at);
  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-f-once`;
  const res = await kit(project, 'agent-kit-oneshot', ['at', String(t), id, sender(user), '--free', ...(pastCap ? ['--past-cap'] : [])], { input: '', timeout: 60000 });
  const ok = res.code === 0;
  audit(user, project.id, 'once-set', { id, at: new Date(t * 1000).toISOString(), pastCap: pastCap ? 'yes' : null }, { ok, detail: ok ? null : kitWords(res) });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, kitWords(res));
  return { ok, id, at: t };
}

/** Move a one-time cycle: the VM forgets the old time and gets the new one. Keeps "past the cap". */
export async function onceMove(user, project, { id, at, pastCap = false } = {}) {
  if (!FREE_ID.test(id || '')) throw fail(400, 'Bad cycle id');
  const t = onceTime(at);
  const un = await kit(project, 'agent-kit-oneshot', ['unat', id], { timeout: 60000 });
  if (un.code !== 0) throw fail(502, kitWords(un));
  const res = await kit(project, 'agent-kit-oneshot', ['at', String(t), id, sender(user), '--free', ...(pastCap ? ['--past-cap'] : [])], { input: '', timeout: 60000 });
  const ok = res.code === 0;
  audit(user, project.id, 'once-move', { id, at: new Date(t * 1000).toISOString() }, { ok, detail: ok ? null : kitWords(res) });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, `${kitWords(res)}. The cycle was taken off its old time: set it again.`);
  return { ok, id, at: t };
}

/** Cancel a one-time cycle that has not started. */
export async function onceCancel(user, project, { id } = {}) {
  if (!FREE_ID.test(id || '')) throw fail(400, 'Bad cycle id');
  const res = await kit(project, 'agent-kit-oneshot', ['unat', id], { timeout: 60000 });
  const ok = res.code === 0;
  audit(user, project.id, 'once-cancel', { id }, { ok, detail: ok ? null : kitWords(res) });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, kitWords(res));
  return { ok, id };
}

/** Replace a project's schedule on its VM. `input`: {tz, slots}. */
export async function setSchedule(user, project, input) {
  let schedule;
  try {
    schedule = validateSchedule(input);
  } catch (e) {
    throw fail(400, e.message);
  }
  // One-day changes (move or skip one start) need kit 0.14.1; an older kit refuses the whole schedule.
  // Every N, a first or last date, or a number of times need kit 0.26.
  if (schedule.slots.some(usesRepeat)) needsKit(project, REPEAT_KIT, 'A start time that repeats less often or ends');
  if (schedule.changes.length && !kitAtLeast(peekStatus(project.id)?.kitVersion, '0.14.1')) {
    throw fail(400, `Changing one day only needs kit 0.14.1 on ${project.name}'s VM. Change every day instead, or upgrade the kit.`);
  }
  const res = await kit(project, 'agent-kit-schedule', ['set'], { input: formatScheduleText(schedule), timeout: 60000 });
  const ok = res.code === 0;
  const detail = (res.stdout || res.stderr || '').trim().split('\n').slice(-2).join(' · ').slice(-300);
  audit(user, project.id, 'schedule-set', { tz: schedule.tz, slots: schedule.slots.length }, { ok, detail: ok ? null : detail || `exit ${res.code}` });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, detail || 'The VM refused the schedule');
  return { ok, schedule, detail };
}

/** Remove a project's schedule: its cycles follow each other again. */
export async function clearSchedule(user, project) {
  const res = await kit(project, 'agent-kit-schedule', ['clear'], { timeout: 60000 });
  const ok = res.code === 0;
  const detail = (res.stdout || res.stderr || '').trim().split('\n').slice(-2).join(' · ').slice(-300);
  audit(user, project.id, 'schedule-clear', {}, { ok, detail: ok ? null : detail || `exit ${res.code}` });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, detail || 'The VM refused');
  return { ok, detail };
}
