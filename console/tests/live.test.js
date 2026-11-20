import { describe, it, expect } from 'vitest';
import { _test, kitAtLeast } from '../src/lib/server/live.js';
import { idleText } from '../src/lib/format.js';

// Raw status as the VM script prints it (all strings), for an idle team.
const raw = (o = {}) => ({ control: 'run 2026-11-20T00:00:33+00:00', lead: 'inactive', timer: 'enabled', cap: '1', today: '1', next: '1795139944', dayend: '1795219200', now: '1795139000', ...o });

describe('status of an idle team', () => {
  it('says the daily cap is used up, and when the VM day ends', () => {
    const st = _test.shape(raw());
    expect(st.state).toBe('idle');
    expect(st.idle).toEqual({ reason: 'cap', today: 1, cap: 1, nextAt: 1795139944, dayEndsAt: 1795219200 });
    expect(idleText(st.idle)).toMatch(/daily cycle cap is used up \(1 of 1 today\).*one-shot job/);
  });

  it('between cycles when the cap allows another', () => {
    const st = _test.shape(raw({ cap: '4' }));
    expect(st.idle.reason).toBe('between');
    expect(idleText(st.idle)).toMatch(/^Idle between cycles\. The next one starts at .+ \(1 of 4 today\)\.$/);
  });

  it('timer off, and a pending halt, come before the cap', () => {
    expect(_test.shape(raw({ cap: '4', timer: 'disabled' })).idle.reason).toBe('timer-off');
    expect(_test.shape(raw({ haltafter: '1795139000 plain owner' })).idle.reason).toBe('halt-after');
  });

  it('no idle reason for a running or halted team', () => {
    expect(_test.shape(raw({ lead: 'active' })).idle).toBeNull();
    expect(_test.shape(raw({ control: 'stop owner 2026-11-20T00:00:00+00:00' })).idle).toBeNull();
  });

  it('an older kit without the numbers: no cap reason, no crash', () => {
    const st = _test.shape(raw({ cap: undefined, today: undefined, next: undefined, dayend: undefined }));
    expect(st.idle).toMatchObject({ reason: 'between', today: null, cap: null });
    expect(idleText(st.idle)).toBe('Idle between cycles. The next one starts soon.');
  });

  it('reads whether a one-shot job ends in a halt or runs on', () => {
    expect(_test.shape(raw({ oneshot: '20261120T020000Z-o-abc 2026-11-20T02:00:00+00:00 run' })).oneshot).toMatchObject({ id: '20261120T020000Z-o-abc', runsOn: true });
    expect(_test.shape(raw({ oneshot: '20261120T020000Z-o-abc 2026-11-20T02:00:00+00:00' })).oneshot.runsOn).toBe(false);
  });
});

describe('kitAtLeast', () => {
  it('compares versions', () => {
    expect(kitAtLeast('0.6.0', '0.6.0')).toBe(true);
    expect(kitAtLeast('0.10.1', '0.6.0')).toBe(true);
    expect(kitAtLeast('1.0', '0.6.0')).toBe(true);
    expect(kitAtLeast('0.5.0', '0.6.0')).toBe(false);
    expect(kitAtLeast('', '0.6.0')).toBe(false);
    expect(kitAtLeast('dev', '0.6.0')).toBe(false);
  });
});
