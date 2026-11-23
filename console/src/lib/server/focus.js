// Focus mode (#93, kit 0.27): one team works in cycles back to back for a
// while, the others optionally paused. Each VM keeps its own focus or pause
// (agent-kit-focus) and ends it by itself at its time; the console starts and
// stops it, and ends the pauses of a focus that has ended in another way
// (its cycles done, blocked on the owner, switched off).
import { listProjects, getProject } from './config.js';
import { kit } from './ssh.js';
import { audit } from './audit.js';
import { getStatus, peekStatus, invalidateStatus, kitAtLeast } from './live.js';
import { readCycles, typicalCycle } from './aggregate.js';

export const FOCUS_KIT = '0.27.0';
const DAY = 86_400;

const fail = (status, message) => Object.assign(new Error(message), { status });
const words = (res) => (res.stderr || res.stdout || '').trim().split('\n').at(-1)?.replace(/^agent-kit-focus:\s*/, '').slice(0, 300) || `exit ${res.code}`;
const visible = () => listProjects().filter((p) => !p.hidden);

/** The team in focus now, from the cached statuses: {id, name, ...focus.on} or null. */
export function focusNow(statusOf = (id) => peekStatus(id)) {
  for (const p of visible()) {
    const on = statusOf(p.id)?.focus?.on;
    if (on) return { id: p.id, name: p.name, ...on };
  }
  return null;
}

/**
 * The team in focus, from statuses fetched now (each cached for seconds; a VM
 * that does not answer within `ms` counts with its last known status).
 */
export async function focusNowSoon(ms = 1500) {
  const list = visible();
  const got = await Promise.all(list.map((p) => Promise.race([getStatus(p).catch(() => null), new Promise((r) => setTimeout(() => r(peekStatus(p.id)), ms))])));
  const byId = new Map(list.map((p, i) => [p.id, got[i]]));
  return focusNow((id) => byId.get(id));
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
 * Put one team in focus. With `pauseOthers` every other team (that has kit
 * 0.27 and answers) is paused for the same time: until the focus's end time,
 * or, for a focus by cycles or until switched off, open-ended (7 days at most
 * on the VM; the console ends the pauses when it sees the focus has ended).
 * {ok, detail, paused: [names], notPaused: [{name, why}]}.
 */
export async function startFocus(user, project, input) {
  const args = focusArgs(input);
  const statuses = new Map(await Promise.all(visible().map(async (p) => [p.id, await getStatus(p).catch(() => null)])));
  const st = statuses.get(project.id);
  if (!kitAtLeast(st?.kitVersion, FOCUS_KIT)) throw fail(400, `Focus needs kit ${FOCUS_KIT} on ${project.name}'s VM (it has ${st?.kitVersion || 'an older one'}).`);
  const other = focusNow((id) => statuses.get(id));
  if (other) throw fail(409, `${other.name} is in focus already. Stop that focus first.`);
  const res = await kit(project, 'agent-kit-focus', args, { timeout: 60000 });
  const ok = res.code === 0;
  audit(user, project.id, 'focus-start', { mode: input.mode, until: input.until ?? null, cycles: input.cycles ?? null, perDay: input.perDay, pauseOthers: input.pauseOthers ? 'yes' : null }, { ok, detail: ok ? null : words(res) });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, words(res));
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
      const r = await kit(p, 'agent-kit-focus', ['pause', ...(input.mode === 'until' ? ['--until', String(input.until)] : ['--open']), '--for', project.id], { timeout: 60000 });
      audit(user, p.id, 'focus-pause', { for: project.id }, { ok: r.code === 0, detail: r.code === 0 ? null : words(r) });
      invalidateStatus(p.id);
      if (r.code === 0) paused.push(p.name);
      else notPaused.push({ name: p.name, why: words(r) });
    }
  }
  const tail = paused.length ? ` Paused: ${paused.join(', ')}.` : '';
  const miss = notPaused.length ? ` Not paused: ${notPaused.map((n) => `${n.name} (${n.why})`).join(', ')}.` : '';
  return { ok: true, detail: `${project.name} is in focus: cycles back to back, at most ${input.perDay} a day.${tail}${miss}`, paused, notPaused };
}

/** End a focus now, and the pauses made for it. */
export async function stopFocus(user, project) {
  const res = await kit(project, 'agent-kit-focus', ['clear', 'owner'], { timeout: 60000 });
  const ok = res.code === 0;
  audit(user, project.id, 'focus-stop', {}, { ok, detail: ok ? null : words(res) });
  invalidateStatus(project.id);
  if (!ok) throw fail(502, words(res));
  const ended = await unpauseFor(user, project.id);
  return { ok: true, detail: `Focus on ${project.name} ended.${ended.length ? ` ${ended.join(', ')} run on their schedules again.` : ''}` };
}

/** End every pause made for one team's focus. The names of the teams it ended for. */
async function unpauseFor(user, id, statusOf = (pid) => peekStatus(pid)) {
  const out = [];
  for (const p of visible()) {
    if (statusOf(p.id)?.focus?.paused?.for !== id) continue;
    const r = await kit(p, 'agent-kit-focus', ['unpause'], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: e.message }));
    audit(user, p.id, 'focus-unpause', { for: id }, { ok: r.code === 0, detail: r.code === 0 ? null : words(r) });
    invalidateStatus(p.id);
    if (r.code === 0) out.push(p.name);
  }
  return out;
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
  return Promise.all([...teams].map((id) => unpauseFor({ name: 'console' }, id, statusOf))).then((x) => x.flat()).catch(() => []);
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

export { focusEstimate } from '../focus.js';
