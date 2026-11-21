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
import { invalidateStatus, kitAtLeast } from './live.js';
import { readCycles } from './aggregate.js';
import { statusSoon } from './view.js';
import { parseScheduleText, formatScheduleText, validateSchedule, validateSettings, validTimeZone, rangeFor, windowRange, cleanWindow } from '../schedule.js';

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
    .filter((c) => c.counted && !c.halted && c.kind !== 'chat' && c.kind !== 'plan' && Number.isFinite(c.secs) && c.secs > 60)
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
export async function timeline({ view = 'week', date = null, from = null, to = null } = {}) {
  const settings = getSettings();
  let v = VIEWS.includes(view) ? view : 'week';
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
        const past = [];
        for (const c of cycles) {
          // Chat turns with the lead are not drawn: they are seconds long and not cycles.
          if (c.kind === 'chat') continue;
          const start = Date.parse(c.start);
          const end = Date.parse(c.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= dataFrom || start >= dataTo) continue;
          past.push({ start, end, limited: c.limited, halted: c.halted, costUsd: c.costUsd });
        }
        const since = status.leadActive && status.leadSince ? Date.parse(status.leadSince) : NaN;
        return {
          id: p.id,
          name: p.name,
          accent: p.accent,
          state: status.state,
          reachable: status.reachable,
          kitVersion: status.kitVersion || null,
          canSchedule: kitAtLeast(status.kitVersion, SCHEDULE_KIT),
          cap: Number.isInteger(status.cap) ? status.cap : null,
          schedule: parseScheduleText(status.schedule),
          typicalSecs: typicalSecs(cycles),
          past,
          running: Number.isFinite(since) ? { start: since } : null,
          log: readSlotLog(p.paths.fleet, dataFrom, dataTo),
          // One-shot jobs and planning cycles set for a time (kit 0.10). Bars on the timeline are for later.
          atJobs: status.atJobs || []
        };
      })
  );
  return { view: v, custom, range, settings, projects, now: Date.now() };
}

/** Replace a project's schedule on its VM. `input`: {tz, slots}. */
export async function setSchedule(user, project, input) {
  let schedule;
  try {
    schedule = validateSchedule(input);
  } catch (e) {
    throw fail(400, e.message);
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
