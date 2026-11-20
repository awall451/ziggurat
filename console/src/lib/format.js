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
