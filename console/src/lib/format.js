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

/** Why an idle team is idle, in one sentence (see idleWhy in live.js). */
export function idleText(idle, now = Date.now()) {
  if (!idle) return null;
  const counted = idle.cap != null && idle.today != null ? ` (${idle.today} of ${idle.cap} today)` : '';
  if (idle.reason === 'cap') {
    const end = clock(idle.dayEndsAt, now);
    return `Idle: the daily cycle cap is used up${counted}. It resets when the VM's day ends${end ? `, at ${end} your time` : ''}; the next cycle starts after that. Raise the cap under Controls, or start a one-shot job.`;
  }
  if (idle.reason === 'timer-off') return 'Idle: the lead timer is off, so no cycle starts on its own. Resume the team under Controls, or start a one-shot job.';
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
