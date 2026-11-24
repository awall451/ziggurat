// Focus mode (#93): pure helpers shared by the server and the focus dialog.
const DAY = 86_400;

/**
 * A focus's likely size: how many cycles, how long and what they cost, and over
 * how many 5-hour usage windows. Back to back, a cycle takes its typical length
 * plus about 15 minutes between cycles.
 */
export function focusEstimate({ mode, until, cycles, perDay }, typical, now = Date.now() / 1000) {
  const secs = typical?.secs || 3600;
  const perDayBackToBack = Math.max(1, Math.floor(DAY / (secs + 900)));
  const daily = Math.min(perDay, perDayBackToBack);
  let n;
  if (mode === 'cycles') n = cycles;
  else if (mode === 'until') n = Math.max(1, Math.round((Math.max(0, until - now) / DAY) * daily));
  else n = daily; // until switched off: per day
  const hours = (n * secs) / 3600;
  return {
    cycles: n,
    perDay: mode === 'open',
    hours,
    costUsd: Number.isFinite(typical?.costUsd) ? n * typical.costUsd : null,
    windows: Math.max(1, Math.ceil((n * (secs + 900)) / (5 * 3600))),
    limitedByLength: daily < perDay
  };
}

/**
 * What a focus that is running still likely takes (#115), from the VM's
 * `focus.on` ({until, cycles, done, perDay}): the same estimate as for a new
 * focus, with its end time, its cycles left, or per day.
 */
export function focusLeft(on, typical, now = Date.now() / 1000) {
  if (!on) return null;
  const perDay = Number.isInteger(on.perDay) && on.perDay > 0 ? on.perDay : 6;
  if (Number.isFinite(on.until)) return focusEstimate({ mode: 'until', until: on.until, perDay }, typical, now);
  if (Number.isFinite(on.cycles)) return focusEstimate({ mode: 'cycles', cycles: Math.max(0, on.cycles - (on.done || 0)), perDay }, typical, now);
  return focusEstimate({ mode: 'open', perDay }, typical, now);
}
