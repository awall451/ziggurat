// Display helpers shared by the pages.

const nf = new Intl.NumberFormat('en-US');

export const num = (n) => (n == null ? '–' : nf.format(Math.round(n)));

export function usd(n, digits = 2) {
  if (n == null) return '–';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 5400 -> "1h 30m", 95 -> "1m 35s" */
export function dur(secs) {
  if (secs == null || Number.isNaN(secs)) return '–';
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export function between(a, b) {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? null : (y - x) / 1000;
}

/** "3m ago", "2h ago", "4d ago" */
export function ago(iso, now = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!t || Number.isNaN(t)) return '–';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function when(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '–';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "claude-opus-5-5" -> "opus" */
export function modelShort(id) {
  if (!id) return '–';
  const m = /(fable|mythos|opus|sonnet|haiku)/.exec(id);
  return m ? m[1] : id.replace(/^claude-/, '');
}

/** A VM time (unix seconds) in the viewer's own time, with the day when it is not today. */
export function clock(secs, now = Date.now()) {
  if (!Number.isFinite(secs)) return null;
  const d = new Date(secs * 1000);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return d.toLocaleString([], sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

const LIMIT_WORD = { five_hour: '5-hour window', seven_day: 'weekly limit', seven_day_opus: 'weekly limit', seven_day_sonnet: 'weekly limit' };

/**
 * What a stalled session waits on (status.stalled, kit 0.24), in one line:
 * "Stalled: usage limit (5-hour window), resets at 1:00 PM". Null when not stalled.
 */
export function stallText(st, now = Date.now()) {
  if (!st) return null;
  if (st.reason === 'usage-limit') {
    const what = LIMIT_WORD[st.limit] || (st.limit ? st.limit.replace(/_/g, ' ') : null);
    const at = clock(st.resetsAt, now);
    return `Stalled: usage limit${what ? ` (${what})` : ''}${at ? `, resets at ${at}` : ''}`;
  }
  if (st.reason === 'api-error') {
    return `Stalled: API errors, retrying${st.attempt ? ` (attempt ${st.attempt})` : ''}`;
  }
  if (st.reason === 'no-progress') {
    const min = st.minutes ?? (Number.isFinite(st.since) ? Math.floor((now / 1000 - st.since) / 60) : null);
    return `Stalled: no progress${min != null ? ` for ${min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`}` : ''}`;
  }
  return null;
}

/** The team's state for its pill: "stalled" for a running cycle that is stuck. */
export const pillState = (status) => (status?.state === 'running' && status?.stalled ? 'stalled' : status?.state === 'checking' ? 'idle' : status?.state);

const WAITING = [
  ['asks', 'question', 'questions'],
  ['escalations', 'escalation', 'escalations'],
  ['packages', 'package request', 'package requests'],
  ['held', 'check change', 'check changes'],
  ['chat', 'planning chat answer', 'planning chat answers'],
  ['talk', 'chat answer', 'chat answers'],
  // Said without a number: there is one remote per project.
  ['publishing', 'publishing is not working', 'publishing is not working', true]
];

/**
 * What waits for the owner on a project (`waiting` of the project view):
 * {total, inbox, text}. `inbox` is what the Inbox tab holds: the lead's
 * questions, package requests, held changes to the checks and publishing that
 * does not work. `backlog`: answers
 * of the lead in the Backlog chat that the owner has not opened. `chat`:
 * answers in the Chat tab's conversations (kit 0.33).
 */
export function waitingParts(waiting) {
  const w = waiting || {};
  const n = (k) => (Number.isFinite(w[k]) && w[k] > 0 ? w[k] : 0);
  const parts = WAITING.filter(([k]) => n(k)).map(([k, one, many, plain]) => (plain ? one : `${n(k)} ${n(k) > 1 ? many : one}`));
  return { total: WAITING.reduce((t, [k]) => t + n(k), 0), inbox: n('asks') + n('packages') + n('held') + n('publishing'), backlog: n('chat'), chat: n('talk'), text: parts.join(' · ') || 'Nothing' };
}

/** Why an idle team is idle, in one sentence (see idleWhy in live.js). */
export function idleText(idle, now = Date.now()) {
  if (!idle) return null;
  const counted = idle.cap != null && idle.today != null ? ` (${idle.today} of ${idle.cap} today)` : '';
  if (idle.reason === 'cap') {
    const end = clock(idle.dayEndsAt, now);
    return `Idle: the daily cycle cap is used up${counted}. It resets when the VM's day ends${end ? `, at ${end} your time` : ''}; the next cycle starts after that. Raise the cap under Controls, run a cycle past the cap, or start a one-shot job.`;
  }
  if (idle.reason === 'timer-off') return 'Idle: the lead timer is off, so no cycle starts on its own. Resume the team under Controls, or start a one-shot job.';
  if (idle.reason === 'between' && idle.nextSlot) {
    const next = clock(Math.floor(idle.nextSlot / 1000), now);
    return `Idle until the next scheduled cycle${next ? `, at ${next}` : ''}${counted}. See Schedule.`;
  }
  if (idle.reason === 'between') {
    const next = clock(idle.nextAt, now);
    return `Idle between cycles. The next one starts ${next ? `at ${next}` : 'soon'}${counted}.`;
  }
  return null;
}

export const STATUS_WORD = {
  running: 'running',
  waiting: 'waiting on agents',
  done: 'done',
  failed: 'failed',
  interrupted: 'interrupted',
  // Ended, outcome not pulled from the VM yet (see transcripts.js unrecorded).
  ending: 'ending',
  queued: 'queued'
};
