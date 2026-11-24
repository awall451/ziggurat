import { describe, it, expect } from 'vitest';
import { focusSpan } from '../src/lib/schedule.js';

describe('a focus on the timeline', () => {
  const now = 1_795_490_000_000;
  const since = 1_795_487_000;
  it('with an end time: from its start to that time', () => {
    expect(focusSpan({ on: { since, until: since + 30_000, perDay: 15 } }, 1800, now)).toEqual({ kind: 'focus', from: since * 1000, to: (since + 30_000) * 1000, end: 'set', perDay: 15 });
  });
  it('for N cycles: the cycles left, each a typical cycle and 15 minutes, from now', () => {
    const s = focusSpan({ on: { since, cycles: 10, done: 3, perDay: 15 } }, 2700, now);
    expect(s).toMatchObject({ kind: 'focus', end: 'about', cycles: 10, done: 3 });
    expect(s.to).toBe(now + 7 * 3600 * 1000);
  });
  it('until switched off: to the end of what is shown', () => {
    expect(focusSpan({ on: { since, perDay: 6 } }, 1800, now, now + 86_400_000)).toMatchObject({ end: 'open', to: now + 86_400_000 });
  });
  it('a paused team: the stretch of its pause', () => {
    expect(focusSpan({ on: null, paused: { since, until: since + 9000, for: 'revview' } }, 1800, now)).toEqual({ kind: 'paused', from: since * 1000, to: (since + 9000) * 1000, end: 'set', for: 'revview' });
  });
  it('nothing without focus', () => {
    expect(focusSpan(null, 1800, now)).toBeNull();
    expect(focusSpan({ on: null, paused: null }, 1800, now)).toBeNull();
  });
});
