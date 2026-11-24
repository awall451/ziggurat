import { describe, it, expect } from 'vitest';
import { thread } from '../src/lib/thread.js';

describe('the comments thread of an issue', () => {
  it('merges Boss, the lead and status changes, oldest first', () => {
    const issue = {
      notes: [{ at: '2026-01-01T10:05:00Z', who: 'owner', text: 'Still broken', delivered: true }],
      comments: [{ at: '2026-01-01T10:10:00Z', who: 'lead', status: 'done', text: 'Fixed the flicker.' }],
      history: [
        { at: '2026-01-01T10:00:00Z', to: 'new', who: 'owner', note: 'raised' },
        { at: '2026-01-01T10:01:00Z', to: 'new', who: 'owner', note: 'edited: title' },
        { at: '2026-01-01T10:10:00Z', from: 'new', to: 'done', who: 'lead', note: 'Fixed the flicker.' }
      ]
    };
    const t = thread(issue);
    expect(t.map((x) => [x.type, x.by])).toEqual([
      ['comment', 'boss'],
      ['event', 'lead'],
      ['comment', 'lead']
    ]);
    expect(t[1]).toMatchObject({ from: 'new', to: 'done' });
  });

  it('brings in lead updates from before kit 0.32 from the history', () => {
    const t = thread({
      notes: [],
      history: [{ at: '2026-01-01T10:00:00Z', from: 'new', to: 'in_progress', who: 'lead', note: 'Given to the artist.' }]
    });
    expect(t).toHaveLength(2);
    expect(t[1]).toMatchObject({ type: 'comment', by: 'lead', text: 'Given to the artist.', status: 'in_progress' });
  });

  it('an owner move is an event from Boss; an owner comment not on the VM says so', () => {
    const t = thread({
      notes: [{ at: '2026-01-01T09:00:00Z', who: 'owner', text: 'x', delivered: false, error: 'offline' }],
      history: [{ at: '2026-01-01T10:00:00Z', from: 'in_progress', to: 'done', who: 'owner', note: '' }]
    });
    expect(t[0]).toMatchObject({ by: 'boss', delivered: false, error: 'offline' });
    expect(t[1]).toMatchObject({ type: 'event', by: 'boss', to: 'done' });
  });
});
