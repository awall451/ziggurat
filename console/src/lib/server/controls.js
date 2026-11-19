// Owner controls for a team. Every action is one fixed kit script on the VM
// with checked arguments, and every action is written to the audit log.
import { kit } from './ssh.js';
import { audit } from './audit.js';
import { invalidateStatus, getStatus } from './live.js';
import { sendOneshot, startOneshot, markStarted } from './feedback.js';
import { readToken } from './token.js';

export const CAP_KEYS = ['MAX_CYCLES_PER_DAY', 'CYCLE_BUDGET_USD', 'LEAD_MODEL', 'FALLBACK_MODEL'];

/** Free text becomes safe, separate words for the kit script's arguments. */
function words(text, fallback) {
  const list = String(text || '')
    .replace(/[^A-Za-z0-9.,:_@/ -]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 20)
    .map((w) => w.slice(0, 40));
  return list.length ? list : [fallback];
}

const detail = (res) => (res.stdout || res.stderr || '').trim().split('\n').slice(-3).join(' · ').slice(-400);

async function run(user, project, action, script, argv, shown = {}) {
  const res = await kit(project, script, argv, { timeout: 120000 });
  const ok = res.code === 0;
  audit(user, project.id, action, shown, { ok, detail: detail(res) || (ok ? null : `exit ${res.code}`) });
  invalidateStatus(project.id);
  return { ok, detail: detail(res) };
}

export function halt(user, project, reason) {
  const w = words(reason, 'owner');
  return run(user, project, 'halt', 'agent-kit-halt', [...w, 'via-console'], { reason: w.join(' ') });
}

export function resume(user, project) {
  return run(user, project, 'resume', 'agent-kit-resume', []);
}

/**
 * One cycle for one job on a halted team; the VM halts the team again when it
 * ends. The job travels as an owner message, so it shows in the Inbox with
 * the lead's reply. A refusal by the VM throws (the caller reports it).
 */
export async function oneshot(user, project, { text, attachments }) {
  const out = await sendOneshot(project, user, { text, attachments: Array.isArray(attachments) ? attachments.map(String) : [] });
  return settle(user, project, out);
}

/** Start a stored job again: one that was not started, or whose cycle ended before the lead finished it. */
export async function oneshotAgain(user, project, id) {
  const out = await startOneshot(project, String(id || ''));
  if (out.refused) throw new Error(out.error);
  return settle(user, project, out, { again: true });
}

async function settle(user, project, out, shown = {}) {
  const id = out.meta.id;
  let started = out.started;
  if (!started) {
    // No clear answer (the line dropped, a timeout). The job may be running
    // all the same: ask the VM before telling the owner it is not.
    const status = await getStatus(project, { fresh: true });
    if (status.oneshot?.id === id) {
      markStarted(project, id);
      started = true;
    }
  }
  audit(user, project.id, 'oneshot-start', { id, ...shown }, { ok: started, detail: started ? null : out.error });
  invalidateStatus(project.id);
  return {
    ok: true,
    started,
    id,
    detail: started
      ? 'One-shot job started. The team halts again when it ends.'
      : `No clear answer from the VM (${out.error}). The job is kept in the Inbox: start it from there once the VM answers, or close it.`
  };
}

export function haltAt(user, project, epoch, reason) {
  const t = Number(epoch);
  if (!Number.isInteger(t) || t < Date.now() / 1000 + 30 || t > Date.now() / 1000 + 30 * 86400) {
    throw new Error('Pick a time between one minute and 30 days from now');
  }
  const w = words(reason, 'owner');
  return run(user, project, 'schedule-halt', 'agent-kit-halt-at', ['set', String(t), ...w], { at: new Date(t * 1000).toISOString(), reason: w.join(' ') });
}

export function clearHaltAt(user, project) {
  return run(user, project, 'clear-scheduled-halt', 'agent-kit-halt-at', ['clear']);
}

export function setCap(user, project, key, value) {
  if (!CAP_KEYS.includes(key)) throw new Error('Unknown setting');
  const v = String(value).trim();
  const ok =
    key === 'MAX_CYCLES_PER_DAY'
      ? /^[0-9]{1,3}$/.test(v) && Number(v) <= 200
      : key === 'CYCLE_BUDGET_USD'
        ? /^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(v) && Number(v) >= 1 && Number(v) <= 500
        : /^[a-z][a-z0-9.-]{1,39}$/.test(v);
  if (!ok) throw new Error('That value is not allowed');
  return run(user, project, 'set-cap', 'agent-kit-caps', ['set', key, v], { key, value: v });
}

export function gate(user, project, on, reason) {
  return on
    ? run(user, project, 'gate-resume', 'agent-kit-gate', ['resume'])
    : run(user, project, 'gate-pause', 'agent-kit-gate', ['pause', ...words(reason, 'owner')], { reason: words(reason, 'owner').join(' ') });
}

/**
 * Give the saved subscription token to the team's VM (kit 0.3 or later). It
 * travels on stdin to a script that prints nothing from it; the audit log
 * records only that it happened.
 */
export async function applyToken(user, project) {
  const token = readToken();
  if (!token) throw new Error('No usable token is saved (claude-token in the console config folder)');
  const res = await kit(project, 'agent-kit-auth', ['set-token'], { input: token + '\n', timeout: 45000 });
  const ok = res.code === 0;
  audit(user, project.id, 'apply-token', {}, { ok, detail: ok ? 'token stored' : `refused (exit ${res.code})` });
  invalidateStatus(project.id);
  return { ok, detail: ok ? 'Token stored. It is used from the next cycle.' : 'The VM refused the token. Its kit may be older than 0.3.' };
}

const infoCache = new Map(); // id -> {at, value}

/** Caps and the team's own units, read from the VM (cached briefly). */
export async function info(project, { fresh = false } = {}) {
  const c = infoCache.get(project.id);
  if (!fresh && c && Date.now() - c.at < 15000) return c.value;
  const [caps, units, auth] = await Promise.all([kit(project, 'agent-kit-caps', ['show']), kit(project, 'agent-kit-units', []), kit(project, 'agent-kit-auth', ['status'])]);
  const value = { caps: {}, units: [], auth: null, error: null };
  // Kits before 0.3 have no agent-kit-auth: then there is simply no answer.
  try {
    const a = JSON.parse(auth.stdout.trim().split('\n').at(-1));
    if (typeof a.loggedIn === 'boolean') value.auth = { loggedIn: a.loggedIn, authMethod: a.authMethod || 'none', tokenStored: !!a.tokenStored, apiKeySet: !!a.apiKeySet, expiresAt: a.loginExpiresAt || null, plan: a.subscriptionType || null };
  } catch {
    value.auth = null;
  }
  if (caps.code === 0) {
    for (const line of caps.stdout.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m && CAP_KEYS.includes(m[1])) value.caps[m[1]] = m[2];
    }
  } else value.error = (caps.stderr || 'could not read the settings').trim().slice(-200);
  if (units.code === 0) {
    for (const line of units.stdout.split('\n')) {
      const [unit, kind, enabled, active] = line.trim().split(/\s+/);
      if (unit && /^[A-Za-z0-9@._-]+$/.test(unit)) value.units.push({ unit, kind, enabled, active });
    }
  }
  infoCache.set(project.id, { at: Date.now(), value });
  return value;
}

export function forgetInfo(id) {
  infoCache.delete(id);
}
