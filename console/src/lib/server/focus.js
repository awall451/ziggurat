// Focus mode (#93, kit 0.27; several teams at once since #115): a team works
// in cycles back to back for a while, the teams not in focus optionally paused.
// Each VM keeps its own focus or pause (agent-kit-focus) and ends it by itself
// at its time; the console starts and stops it, and ends the pauses of a focus
// that has ended in another way (its cycles done, blocked on the owner,
// switched off). A VM's pause names one focus; when several focuses asked for
// pauses, it names the one that ends last, and passes to another such focus
// when that one ends early.
import path from 'node:path';
import { listProjects, getProject, DATA_DIR, readJson, writeJson } from './config.js';
import { kit } from './ssh.js';
import { audit } from './audit.js';
import { getStatus, peekStatus, invalidateStatus, kitAtLeast } from './live.js';
import { readCycles, typicalCycle } from './aggregate.js';

export const FOCUS_KIT = '0.27.0';
const DAY = 86_400;

const fail = (status, message) => Object.assign(new Error(message), { status });
const words = (res) => (res.stderr || res.stdout || '').trim().split('\n').at(-1)?.replace(/^agent-kit-focus:\s*/, '').slice(0, 300) || `exit ${res.code}`;
const visible = () => listProjects().filter((p) => !p.hidden);

/** Every team in focus now, from the cached statuses: [{id, name, ...focus.on}]. */
export function focusAll(statusOf = (id) => peekStatus(id)) {
  const out = [];
  for (const p of visible()) {
    const on = statusOf(p.id)?.focus?.on;
    if (on) out.push({ id: p.id, name: p.name, ...on });
  }
  return out;
}

/**
 * Every team in focus, from statuses fetched now (each cached for seconds; a
 * VM that does not answer within `ms` counts with its last known status).
 */
export async function focusAllSoon(ms = 1500) {
  const list = visible();
  const got = await Promise.all(list.map((p) => Promise.race([getStatus(p).catch(() => null), new Promise((r) => setTimeout(() => r(peekStatus(p.id)), ms))])));
  const byId = new Map(list.map((p, i) => [p.id, got[i]]));
  return focusAll((id) => byId.get(id));
}

// The focuses that asked for the other teams to be paused: {teamId: {until}}
// (until: unix seconds, or null for a focus by cycles or until switched off).
// An entry counts only while its team is in focus.
const pausesFile = () => path.join(DATA_DIR, 'focus-pauses.json');
const readPauses = () => {
  try {
    const o = readJson(pausesFile(), {});
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
};
function setPauses(id, value) {
  const o = readPauses();
  if (value) o[id] = value;
  else if (id in o) delete o[id];
  else return;
  writeJson(pausesFile(), o);
}
const endOf = (until) => (Number.isFinite(until) ? until : Infinity);
const pauseArgs = (id, until) => ['pause', ...(Number.isFinite(until) ? ['--until', String(until)] : ['--open']), '--for', id];

/**
 * The focus still running that wants the teams not in focus paused and ends
 * last, other than `except`: {id, until} or null.
 */
function pausingFocus(except, statusOf) {
  let best = null;
  for (const [id, want] of Object.entries(readPauses())) {
    if (id === except || !getProject(id) || !statusOf(id)?.focus?.on) continue;
    const until = Number.isFinite(want?.until) ? want.until : null;
    if (!best || endOf(until) > endOf(best.until)) best = { id, until };
  }
  return best;
}

/** What agent-kit-focus set is called with. Throws on anything out of range. */
export function focusArgs({ mode, until, cycles, perDay }, now = Date.now() / 1000) {
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > 200) throw fail(400, 'Cycles a day: 1 to 200');
  if (mode === 'until') {
    if (!Number.isInteger(until) || until < now + 60 || until > now + 31 * DAY) throw fail(400, 'The end must be between a minute and 31 days from now');
    return ['set', '--until', String(until), '--per-day', String(perDay)];
  }
  if (mode === 'cycles') {
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 500) throw fail(400, 'Cycles: 1 to 500');
    return ['set', '--cycles', String(cycles), '--per-day', String(perDay)];
  }
  if (mode === 'open') return ['set', '--open', '--per-day', String(perDay)];
  throw fail(400, 'Say when the focus ends: a time, a number of cycles, or when you switch it off');
}

/**
 * Put one team in focus; other teams may be in focus too. A team paused for
 * another team's focus starts only with `endPause` (its pause is ended first).
 * With `pauseOthers` every team not in focus (that has kit 0.27 and answers)
 * is paused for the same time: until the focus's end time, or, for a focus by
 * cycles or until switched off, open-ended (7 days at most on the VM; the
 * console ends the pauses when it sees the focus has ended). A team already
 * paused for another focus is paused for the one of the two that ends last.
 * {ok, detail, paused: [names], notPaused: [{name, why}]}.
 */
export async function startFocus(user, project, input) {
  const args = focusArgs(input);
  const statuses = new Map(await Promise.all(visible().map(async (p) => [p.id, await getStatus(p).catch(() => null)])));
  const st = statuses.get(project.id);
  if (!kitAtLeast(st?.kitVersion, FOCUS_KIT)) throw fail(400, `Focus needs kit ${FOCUS_KIT} on ${project.name}'s VM (it has ${st?.kitVersion || 'an older one'}).`);
  if (st?.focus?.on) throw fail(409, `${project.name} is in focus already.`);
  const pausedFor = st?.focus?.paused?.for;
  if (pausedFor) {
    const other = getProject(pausedFor)?.name || pausedFor;
    if (!input.endPause) throw fail(409, `${project.name} is paused for ${other}'s focus. End that pause to start this focus, or stop ${other}'s focus first.`);
    const r = await kit(project, 'agent-kit-focus', ['unpause'], { timeout: 60000 });
    audit(user, project.id, 'focus-unpause', { for: pausedFor, why: 'own focus' }, { ok: r.code === 0, detail: r.code === 0 ? null : words(r) });
    if (r.code !== 0) throw fail(502, words(r));
  }
  const res = await kit(project, 'agent-kit-focus', args, { timeout: 60000 });
  const ok = res.code === 0;
  audit(user, project.id, 'focus-start', { mode: input.mode, until: input.until ?? null, cycles: input.cycles ?? null, perDay: input.perDay, pauseOthers: input.pauseOthers ? 'yes' : null }, { ok, detail: ok ? null : words(res) });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, words(res));
  const until = input.mode === 'until' ? input.until : null;
  setPauses(project.id, input.pauseOthers ? { until } : null);
  const paused = [];
  const notPaused = [];
  if (input.pauseOthers) {
    for (const p of visible()) {
      if (p.id === project.id) continue;
      const s = statuses.get(p.id);
      if (!s?.reachable) {
        notPaused.push({ name: p.name, why: 'the VM does not answer' });
        continue;
      }
      if (!kitAtLeast(s.kitVersion, FOCUS_KIT)) {
        notPaused.push({ name: p.name, why: `kit ${s.kitVersion || 'unknown'}, needs ${FOCUS_KIT}` });
        continue;
      }
      if (s.focus?.on) continue; // in focus itself: never paused
      const was = s.focus?.paused;
      // Paused for another focus that ends later: it stays paused for that one.
      if (was?.for && endOf(was.until) >= endOf(until) && statuses.get(was.for)?.focus?.on) {
        paused.push(p.name);
        continue;
      }
      const r = await kit(p, 'agent-kit-focus', pauseArgs(project.id, until), { timeout: 60000 });
      audit(user, p.id, 'focus-pause', { for: project.id }, { ok: r.code === 0, detail: r.code === 0 ? null : words(r) });
      invalidateStatus(p.id);
      if (r.code === 0) paused.push(p.name);
      else notPaused.push({ name: p.name, why: words(r) });
    }
  }
  const tail = paused.length ? ` Paused: ${paused.join(', ')}.` : '';
  const miss = notPaused.length ? ` Not paused: ${notPaused.map((n) => `${n.name} (${n.why})`).join(', ')}.` : '';
  const also = focusAll((id) => statuses.get(id)).filter((f) => f.id !== project.id);
  const shared = also.length ? ` In focus with ${also.map((f) => f.name).join(', ')}: they share the usage window.` : '';
  return { ok: true, detail: `${project.name} is in focus: cycles back to back, at most ${input.perDay} a day.${shared}${tail}${miss}`, paused, notPaused };
}

/** End a focus now, and the pauses made for it (or pass them to another focus that wants them). */
export async function stopFocus(user, project) {
  const res = await kit(project, 'agent-kit-focus', ['clear', 'owner'], { timeout: 60000 });
  const ok = res.code === 0;
  audit(user, project.id, 'focus-stop', {}, { ok, detail: ok ? null : words(res) });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, words(res));
  setPauses(project.id, null);
  const { ended, kept } = await unpauseFor(user, project.id);
  const back = ended.length ? ` ${ended.join(', ')} run on their schedules again.` : '';
  const still = kept.length ? ` ${kept.map((k) => `${k.name} stays paused for ${k.for}'s focus`).join('; ')}.` : '';
  return { ok: true, detail: `Focus on ${project.name} ended.${back}${still}` };
}

/**
 * The pauses made for one team's focus, now that it has ended: passed to
 * another focus still running that wants the teams paused, else ended.
 * {ended: [names], kept: [{name, for}]}.
 */
async function unpauseFor(user, id, statusOf = (pid) => peekStatus(pid)) {
  const ended = [];
  const kept = [];
  const next = pausingFocus(id, statusOf);
  for (const p of visible()) {
    if (statusOf(p.id)?.focus?.paused?.for !== id) continue;
    if (next && next.id !== p.id) {
      const r = await kit(p, 'agent-kit-focus', pauseArgs(next.id, next.until), { timeout: 60000 }).catch((e) => ({ code: 1, stderr: e.message }));
      audit(user, p.id, 'focus-pause', { for: next.id, from: id }, { ok: r.code === 0, detail: r.code === 0 ? null : words(r) });
      invalidateStatus(p.id);
      if (r.code === 0) {
        kept.push({ name: p.name, for: getProject(next.id)?.name || next.id });
        continue;
      }
    }
    const r = await kit(p, 'agent-kit-focus', ['unpause'], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: e.message }));
    audit(user, p.id, 'focus-unpause', { for: id }, { ok: r.code === 0, detail: r.code === 0 ? null : words(r) });
    invalidateStatus(p.id);
    if (r.code === 0) ended.push(p.name);
  }
  return { ended, kept };
}

let lastReconcile = 0;
/**
 * Pauses whose focus has ended (its cycles done, blocked, switched off on the
 * VM): ended here as soon as a status shows it. Cached statuses only, at most
 * once a minute, never throws. Returns the promise for tests.
 */
export function reconcileFocus({ now = Date.now(), statusOf = (id) => peekStatus(id) } = {}) {
  if (now - lastReconcile < 60_000) return Promise.resolve([]);
  lastReconcile = now;
  const teams = new Set();
  for (const p of visible()) {
    const forId = statusOf(p.id)?.focus?.paused?.for;
    if (!forId) continue;
    const focused = getProject(forId);
    const fs = focused ? statusOf(forId) : null;
    // Only when the focused team answers and says it is not in focus (or is gone from the console).
    if (!focused || (fs?.reachable && fs.focus && !fs.focus.on)) teams.add(forId);
  }
  // Wishes for pauses of focuses that have ended.
  for (const id of Object.keys(readPauses())) {
    const fs = statusOf(id);
    if (!getProject(id) || (fs?.reachable && fs.focus && !fs.focus.on)) {
      try {
        setPauses(id, null);
      } catch {
        /* tried again next minute */
      }
    }
  }
  const run = async () => {
    const out = [];
    for (const id of teams) out.push(...(await unpauseFor({ name: 'console' }, id, statusOf)).ended);
    return out;
  };
  return run().catch(() => []);
}
export const _resetReconcile = () => (lastReconcile = 0);

/**
 * What the focus dialog shows: every visible team with what it would do in
 * focus (typical cycle, cap), and its jobs and one-time cycles set for a time.
 */
export function focusView() {
  return visible().map((p) => {
    const st = peekStatus(p.id) || {};
    return {
      id: p.id,
      name: p.name,
      canFocus: kitAtLeast(st.kitVersion, FOCUS_KIT),
      reachable: !!st.reachable,
      cap: Number.isInteger(st.cap) ? st.cap : null,
      focus: st.focus || null,
      typical: typicalCycle(readCycles(p.paths.fleet)),
      // Jobs and one-time cycles set for a time: they still run on a paused team.
      atJobs: (st.atJobs || []).map((j) => ({ id: j.id, at: j.at, kind: j.free ? 'once' : j.plan ? 'plan' : 'job' }))
    };
  });
}

export { focusEstimate, focusLeft } from '../focus.js';
