<script>
  import { goto, invalidateAll } from '$app/navigation';
  import Timeline from '$lib/components/Timeline.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import RunCycle from '$lib/components/RunCycle.svelte';
  import StartTimeDialog from '$lib/components/StartTimeDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import ProposalCard from '$lib/components/ProposalCard.svelte';
  import ConflictChoice from '$lib/components/ConflictChoice.svelte';
  import { conflictsAt, placeAfter, dateString, expectedStarts, gapNote, usageOverlaps, waitText } from '$lib/schedule.js';
  import { DAYS, plan, occurrences, markFresh, quietIntervals, validateSchedule, validTimeZone, slotId, todayIn, wallClock, windowRange, cleanWindow, clockLabel, zoneChoices, zoneLabel, instantOf, endOf } from '$lib/schedule.js';

  let { data } = $props();
  const tl = $derived(data.timeline);
  const settings = $derived(tl.settings);
  const clock = $derived(settings.clock);
  const isMonth = $derived(tl.view === 'month');
  const editable = $derived(!isMonth);

  // The stretch of time on screen. Moving and zooming change it here at once;
  // the data for the new stretch is fetched a moment later.
  let win = $state(null); // {from, to} while it differs from what the server sent
  $effect(() => {
    tl.range; // new data arrived: it is the window now
    win = null;
  });
  const range = $derived(win ? windowRange(win.from, win.to, settings.timezone) : tl.range);
  const span = $derived(range.to - range.from);
  let fetching;
  function show(from, to) {
    const w = cleanWindow(from, to);
    if (!w) return;
    win = w;
    clearTimeout(fetching);
    fetching = setTimeout(() => goto(`/schedule?view=${tl.view}&from=${w.from}&to=${w.to}`, { replaceState: true, noScroll: true, keepFocus: true }), 250);
  }
  const pan = (ms) => show(range.from + ms, range.to + ms);
  // A stretch picked by dragging: its ends go to the quarter hour.
  const QUARTER = 900_000;
  const zoom = (from, to) => show(Math.floor(from / QUARTER) * QUARTER, Math.ceil(to / QUARTER) * QUARTER);
  // The arrows move half a window, so what was at the edge comes to the middle; a week moves by a day.
  const stride = $derived(tl.view === 'week' && !tl.custom && !win ? 86_400_000 : span / 2);

  // Changes are kept here, per project, until they are applied to the VM.
  let drafts = $state({});
  let selected = $state(null); // {project, slot, date, at}: date and at when one start on the timeline was picked
  let busy = $state('');
  let problem = $state('');
  let done = $state('');
  let confirm = $state(null);
  let quietDraft = $state(null); // a copy of the settings while they are edited

  const copy = (v) => JSON.parse(JSON.stringify(v));
  const scheduleOf = (p) => (drafts[p.id] !== undefined ? drafts[p.id] : p.schedule);
  const usable = (s) => !!s && s.slots.length > 0 && validTimeZone(s.tz);

  // What is planned in the shown stretch, with changes counted as if they were applied.
  const planning = $derived(
    plan(
      tl.projects.map((p) => ({ id: p.id, name: p.name, schedule: usable(scheduleOf(p)) ? scheduleOf(p) : null, typicalSecs: p.typicalSecs, cap: p.cap })),
      settings,
      range.from,
      range.to
    )
  );
  const quiet = $derived(quietIntervals(settings, range.from, range.to));

  function noteFor(p) {
    const s = scheduleOf(p);
    if (!p.reachable && p.reachable !== null) return 'VM not reachable';
    if (!p.canSchedule) return p.kitVersion ? `kit ${p.kitVersion}: needs 0.9` : 'no kit status yet';
    if (drafts[p.id] !== undefined) return 'saving…';
    // Focus mode (kit 0.27).
    if (p.focus?.on) return 'in focus: back to back';
    if (p.focus?.paused) return `paused for ${p.focus.paused.for}`;
    if (!s) return 'back to back';
    return `${s.slots.length} start time${s.slots.length === 1 ? '' : 's'}${p.cap != null ? ` · cap ${p.cap}` : ''}`;
  }
  const rows = $derived(
    tl.projects.map((p) => ({
      id: p.id,
      name: p.name,
      accent: p.accent,
      tz: scheduleOf(p)?.tz && validTimeZone(scheduleOf(p).tz) ? scheduleOf(p).tz : settings.timezone,
      editable: editable && p.canSchedule,
      draft: drafts[p.id] !== undefined,
      note: noteFor(p),
      past: p.past,
      running: p.running,
      stalled: p.stalled || null,
      // With a change open, the starts it brings are marked: only those show when their time has passed.
      planned: drafts[p.id] !== undefined ? markFresh(planning.planned[p.id] || [], p.schedule, range.from, range.to) : planning.planned[p.id] || [],
      // Starts skipped for one day: drawn struck through, they do not run.
      skipped: occurrences(scheduleOf(p), range.from, range.to, { skipped: true })
        .filter((o) => o.skipped)
        .map((o) => ({ ...o, end: o.at + (p.typicalSecs || 3600) * 1000 })),
      jobs: p.jobs || [],
      // Where its waiting jobs are likely to start: behind a job that runs over, a cycle that runs, or the job they build on.
      expected: expectedStarts(p.jobs || [], tl.now, p.running ? Math.max(p.running.start + (p.typicalSecs || 3600) * 1000, tl.now) : null),
      log: p.log
    }))
  );
  // Jobs of different teams at the same time: they share one usage limit.
  const usage = $derived(usageOverlaps(rows, tl.now));

  // ---- backlog jobs: the pop-up, cancel, move ----
  let jobOpen = $state(null); // {project, job}
  let moving = $state(null); // {project, job}: the timeline carries the job's estimate
  let movePick = $state(null); // ms picked for the move
  const JOB_STATE = { set: 'Set for', running: 'Running since', done: 'Ran' };
  function whenAt(ms) {
    const c = wallClock(settings.timezone, ms);
    const day = new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    return `${day}, ${clockAt(ms)}`;
  }
  async function jobAct(projectId, body, key) {
    busy = key;
    problem = '';
    done = '';
    try {
      const r = await fetch(`/p/${projectId}/backlog/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.message || 'That did not work');
      done = out.detail || 'Done.';
      await invalidateAll();
      return out;
    } catch (e) {
      problem = e.message;
      return null;
    } finally {
      busy = '';
    }
  }
  // A job dragged on the timeline: the same path as Move, with the place already picked.
  function dragMove(projectId, job, at) {
    if (busy) return;
    if (job.kind === 'once') {
      // A one-time cycle dragged along its row: moved on the VM at once.
      busy = 'move';
      call({ action: 'once-move', project: projectId, id: job.id, at: Math.round(at / 1000), pastCap: !!job.pastCap })
        .then(() => (done = `${project(projectId).name}: the one-time cycle now starts ${whenAt(at)}.`))
        .catch((e) => (problem = e.message))
        .finally(() => (busy = ''));
      return;
    }
    moving = { project: projectId, job };
    movePick = at;
    moveHit = null;
    confirmMove();
  }
  function startMove() {
    moving = jobOpen;
    movePick = null;
    jobOpen = null;
  }
  // Before a move: what would the job run into on its row (not itself)?
  let moveHit = $state(null);
  const moveRow = $derived(moving ? rows.find((r) => r.id === moving.project) : null);
  async function confirmMove(skip = null) {
    const m = moving;
    if (!skip) {
      const found = conflictsAt(moveRow?.planned, moveRow?.jobs, movePick, m.job.minutes, m.job.id, tl.now);
      if (found.length) return (moveHit = found);
    }
    const out = await jobAct(m.project, { action: 'move-at', id: m.job.id, at: Math.round(movePick / 1000), skip }, 'move');
    if (out) {
      moving = null;
      movePick = null;
      moveHit = null;
    }
  }
  function moveAfter() {
    movePick = placeAfter(moveRow?.planned, moveRow?.jobs, movePick, moving.job.minutes, moving.job.id, tl.now);
    moveHit = null;
  }
  // Close behind another job of the team, or before the job it builds on would be merged: a note, never a refusal.
  const moveNote = $derived(moving && movePick && !moveHit ? gapNote(moveRow?.jobs, movePick, moving.job.minutes, { ignore: moving.job.id, after: moving.job.after || [], now: tl.now }) : null);
  const moveTz = $derived(moving ? scheduleOf(project(moving.project))?.tz : null);
  const canSkipMove = $derived(!!moveHit && moveHit.length === 1 && moveHit[0].kind === 'cycle' && !!moveTz);
  const skipMove = () => confirmMove({ slot: moveHit[0].slot, date: dateString(wallClock(moveTz, moveHit[0].at)) });
  async function cancelJob() {
    const j = jobOpen;
    const out = await jobAct(j.project, { action: 'cancel-at', id: j.job.id }, 'cancel-job');
    if (out) jobOpen = null;
  }

  const project = (id) => tl.projects.find((p) => p.id === id);
  function draftOf(id) {
    if (drafts[id] === undefined) drafts[id] = copy(project(id).schedule) || { tz: settings.timezone, slots: [] };
    return drafts[id];
  }
  const clash = (d, slot, except) => d.slots.some((s, i) => i !== except && slotId(s) === slotId(slot));

  // Dragging one start of a repeating slot asks, like a calendar: that day only, or every day.
  let scope = $state(null); // {id, index, time, bar}
  function move(id, index, time, bar = null) {
    if (bar?.date) {
      scope = { id, index, time, bar };
      return;
    }
    moveEvery(id, index, time);
  }
  const scopeSlot = $derived(scope ? scheduleOf(project(scope.id))?.slots[scope.index] : null);
  function moveOnce() {
    const { id, index, time, bar } = scope;
    scope = null;
    const d = draftOf(id);
    const slot = d.slots[index];
    const key = slotId(slot);
    d.changes = (d.changes || []).filter((c) => !(c.date === bar.date && c.slot === key));
    if (time !== slot.time) d.changes.push({ kind: 'move', date: bar.date, slot: key, time });
    problem = '';
    commit(id);
  }
  function moveAll() {
    const { id, index, time } = scope;
    scope = null;
    moveEvery(id, index, time);
  }
  function moveEvery(id, index, time) {
    const d = draftOf(id);
    if (clash(d, { ...d.slots[index], time }, index)) {
      problem = 'There is already a start time then, on the same days.';
      return;
    }
    problem = '';
    // One-day changes follow their slot to its new time.
    const before = slotId(d.slots[index]);
    d.slots[index].time = time;
    const after = slotId(d.slots[index]);
    d.changes = (d.changes || []).map((c) => (c.slot === before ? { ...c, slot: after } : c));
    commit(id);
  }

  // ---- the pop-up for one start time (#90) ------------------------------------
  // pop: {project, mode: 'new' | 'slot' | 'once', index, bar, job, form}. Done sends it to the VM at once.
  let pop = $state(null);
  let popBusy = $state(false);
  let popProblem = $state('');
  const tzOf = (p) => (validTimeZone(scheduleOf(p)?.tz) ? scheduleOf(p).tz : settings.timezone);
  const dayName = (ds) => DAYS[(Math.round(Date.parse(`${ds}T00:00:00Z`) / 86_400_000) + 3) % 7];
  const blankForm = (date, time, unit = 'day', day = null) => ({ date, time, repeat: true, unit, every: 1, days: day ? [day] : [dayName(date)], ends: 'never', until: date, count: 5, pastCap: false });
  function openPop(next) {
    popProblem = '';
    problem = '';
    pop = next;
  }
  function add(id, time, day, ms = null) {
    const p = project(id);
    const tz = tzOf(p);
    const date = ms != null ? dateString(wallClock(tz, ms)) : todayIn(tz, tl.now);
    // In a stretch of several days a click means that weekday; otherwise every day.
    openPop({ project: id, mode: 'new', form: blankForm(date, time, span > 36 * 3_600_000 ? 'week' : 'day', span > 36 * 3_600_000 ? day : null) });
  }
  function addNow(id) {
    const tz = tzOf(project(id));
    const c = wallClock(tz, tl.now + 3_600_000);
    add(id, `${String(c.H).padStart(2, '0')}:00`, null, tl.now + 3_600_000);
  }
  function select(id, index, bar = null) {
    const p = project(id);
    const slot = scheduleOf(p)?.slots[index];
    if (!slot) return;
    const today = todayIn(tzOf(p), tl.now);
    const weekly = slot.days[0] !== 'daily';
    const end = endOf(slot);
    openPop({
      project: id,
      mode: 'slot',
      index,
      bar,
      form: {
        // A start time with no first date is shown from today: Done keeps it without one.
        date: slot.from && slot.from > today ? slot.from : today,
        time: slot.time,
        repeat: true,
        unit: weekly ? 'week' : 'day',
        every: slot.every || 1,
        days: weekly ? [...slot.days] : [dayName(today)],
        ends: slot.count ? 'after' : slot.until ? 'on' : 'never',
        until: end || today,
        count: slot.count || 5,
        pastCap: false,
        from: slot.from || null
      }
    });
  }
  function openOnce(id, job) {
    const tz = tzOf(project(id));
    const c = wallClock(tz, job.start);
    const date = dateString(c);
    openPop({ project: id, mode: 'once', job, form: { ...blankForm(date, `${String(c.H).padStart(2, '0')}:${String(c.M).padStart(2, '0')}`), repeat: false, pastCap: !!job.pastCap } });
  }
  /** The slot a repeating form stands for. */
  function slotOf(f, today) {
    const weekly = f.unit === 'week';
    const days = weekly ? DAYS.filter((d) => f.days.includes(d)) : ['daily'];
    const slot = { days: weekly && days.length === 7 && f.every === 1 ? ['daily'] : days, time: f.time };
    if (f.every > 1) slot.every = f.every;
    // A first date only where it matters: every N counts from it, a count starts there, or it is later than today.
    if (f.every > 1 || f.ends === 'after' || f.date > today) slot.from = f.date;
    if (f.ends === 'on') slot.until = f.until;
    if (f.ends === 'after') slot.count = f.count;
    return slot;
  }
  async function popDone() {
    const p = project(pop.project);
    const f = pop.form;
    const tz = tzOf(p);
    popBusy = true;
    popProblem = '';
    try {
      if (!f.repeat) {
        const [y, m, d] = f.date.split('-').map(Number);
        const [H, M] = f.time.split(':').map(Number);
        const at = Math.round(instantOf(tz, y, m, d, H, M) / 1000);
        if (pop.mode === 'once') {
          if (at * 1000 !== pop.job.start || f.pastCap !== !!pop.job.pastCap) await call({ action: 'once-move', project: p.id, id: pop.job.id, at, pastCap: f.pastCap });
        } else {
          await call({ action: 'once-set', project: p.id, at, pastCap: f.pastCap });
          // A repeating start time turned into a one-time cycle: the old one goes.
          if (pop.mode === 'slot') {
            const dr = draftOf(p.id);
            dr.slots.splice(pop.index, 1);
            await commit(p.id, true);
          }
        }
        done = `${p.name}: one cycle set for ${whenAt(at * 1000)}.`;
      } else {
        const slot = slotOf(f, todayIn(tz, tl.now));
        const dr = draftOf(p.id);
        const index = pop.mode === 'slot' ? pop.index : -1;
        if (clash(dr, slot, index)) throw new Error('There is already a start time then, on the same days.');
        if (index >= 0) {
          // One-day changes follow their slot to its new time.
          const before = slotId(dr.slots[index]);
          dr.slots[index] = slot;
          dr.changes = (dr.changes || []).map((c) => (c.slot === before ? { ...c, slot: slotId(slot) } : c));
        } else dr.slots.push(slot);
        await commit(p.id, true);
        if (pop.mode === 'once') await call({ action: 'once-cancel', project: p.id, id: pop.job.id });
        done = `${p.name}: start times saved on its VM.`;
      }
      pop = null;
    } catch (e) {
      popProblem = e.message;
      delete drafts[p.id];
    } finally {
      popBusy = false;
    }
  }
  async function popDelete() {
    const p = project(pop.project);
    if (pop.mode === 'once') {
      popBusy = true;
      try {
        await call({ action: 'once-cancel', project: p.id, id: pop.job.id });
        done = `${p.name}: the one-time cycle is cancelled.`;
        pop = null;
      } catch (e) {
        popProblem = e.message;
      } finally {
        popBusy = false;
      }
      return;
    }
    if (pop.mode !== 'slot') return (pop = null);
    const { index, bar } = pop;
    pop = null;
    selected = { project: p.id, slot: index, date: bar?.date || null, at: bar?.at ?? null };
    askDelete();
  }
  /** One request to /api/schedule; throws the server's words. */
  async function call(body) {
    const res = await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || 'The action failed');
    await invalidateAll();
    return out;
  }
  /**
   * Send a team's changed start times to its VM at once (no Apply step since #90).
   * With `raise`, a refusal throws; otherwise it is shown, and the page goes back to what the VM has.
   */
  async function commit(id, raise = false) {
    const p = project(id);
    const d = drafts[id];
    if (d === undefined) return;
    busy = `apply-${id}`;
    try {
      if (!d.slots.length) await call({ action: 'clear', project: id });
      else {
        const s = validateSchedule(d);
        await call({ action: 'set', project: id, tz: s.tz, slots: s.slots, changes: s.changes });
      }
      delete drafts[id];
      if (!raise) done = `${p.name}: saved on its VM.`;
    } catch (e) {
      delete drafts[id];
      if (raise) throw e;
      problem = `${p.name}: ${e.message}`;
    } finally {
      busy = '';
    }
  }

  function removeSlot() {
    const id = selected.project;
    const d = draftOf(id);
    d.slots.splice(selected.slot, 1);
    selected = null;
    commit(id);
  }
  // Deleting one start of a repeating slot asks, like a calendar: that day only, or every day.
  let del = $state(null); // {project, slot, date}
  const delSlot = $derived(del ? scheduleOf(project(del.project))?.slots[del.slot] : null);
  function askDelete() {
    // Picked from the list of times, or a start that has passed: there is no one day to skip.
    if (selected.date && selected.at > tl.now) del = { ...selected };
    else removeSlot();
  }
  function deleteOnce() {
    const { project: id, slot: index, date } = del;
    del = null;
    const d = draftOf(id);
    const key = slotId(d.slots[index]);
    d.changes = (d.changes || []).filter((c) => !(c.date === date && c.slot === key));
    d.changes.push({ kind: 'skip', date, slot: key });
    problem = '';
    selected = null;
    commit(id);
  }
  function deleteAll() {
    selected = { project: del.project, slot: del.slot };
    del = null;
    removeSlot();
  }
  // One-day skips that are still to come, for the team's panel.
  const skipsOf = (p) => {
    const s = scheduleOf(p);
    if (!s) return [];
    const from = todayIn(validTimeZone(s.tz) ? s.tz : settings.timezone, tl.now);
    return (s.changes || []).filter((c) => c.kind === 'skip' && c.date >= from);
  };
  function undoSkip(id, c) {
    const d = draftOf(id);
    d.changes = (d.changes || []).filter((x) => !(x.kind === 'skip' && x.date === c.date && x.slot === c.slot));
    problem = '';
    commit(id);
  }
  function discard(id) {
    delete drafts[id];
    if (selected?.project === id) selected = null;
    problem = '';
  }

  async function send(body, label) {
    busy = label;
    problem = '';
    done = '';
    try {
      const res = await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The action failed');
      await invalidateAll();
      return out;
    } catch (e) {
      problem = e.message;
      return null;
    } finally {
      busy = '';
      confirm = null;
    }
  }
  function askClear(p) {
    confirm = {
      title: `Remove all start times of ${p.name}?`,
      body: 'Its cycles follow each other again, 15 minutes apart, until the daily cap is used up. That is how every team runs without set times.',
      word: 'Remove all',
      danger: true,
      run: async () => {
        const out = await send({ action: 'clear', project: p.id }, `clear-${p.id}`);
        if (!out) return;
        discard(p.id);
        done = `${p.name}: start times removed. Its cycles run back to back again.`;
      }
    };
  }

  // The owner's own settings: time zone of the timeline, clock, quiet hours.
  async function setClock(value) {
    if (value === clock) return;
    await send({ action: 'settings', timezone: settings.timezone, quiet: settings.quiet, clock: value }, 'clock');
  }
  function editSettings() {
    quietDraft = copy(settings);
  }
  function addQuiet() {
    quietDraft.quiet.push({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' });
  }
  function toggleQuietDay(q, day) {
    let days = q.days[0] === 'daily' ? [...DAYS] : [...q.days];
    days = days.includes(day) ? days.filter((x) => x !== day) : [...days, day];
    if (!days.length) return;
    days = DAYS.filter((x) => days.includes(x));
    q.days = days.length === 7 ? ['daily'] : days;
  }
  async function saveSettings() {
    const out = await send({ action: 'settings', timezone: quietDraft.timezone, quiet: quietDraft.quiet, clock }, 'settings');
    if (!out) return;
    quietDraft = null;
    done = 'Saved.';
  }

  // Time zones by the names people use, plus whatever is already in use here.
  const zones = $derived(zoneChoices([settings.timezone, ...tl.projects.map((p) => scheduleOf(p)?.tz).filter(Boolean), quietDraft?.timezone].filter(Boolean), tl.now));
  const link = (view, date) => `/schedule?view=${view}${date ? `&date=${date}` : ''}`;
  const has = (slot, day) => slot.days[0] === 'daily' || slot.days.includes(day);
  const daysText = (slot) => {
    const days = slot.days[0] === 'daily' ? (slot.every > 1 ? `every ${slot.every} days` : 'every day') : slot.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(', ') + (slot.every > 1 ? `, every ${slot.every} weeks` : '');
    // From kit 0.26: a first date, and an end.
    const from = slot.from && slot.from > todayIn(settings.timezone, tl.now) ? `, from ${dateText(slot.from, { day: 'numeric', month: 'short' })}` : '';
    const end = slot.count ? `, ${slot.count} times` : slot.until ? `, until ${dateText(slot.until, { day: 'numeric', month: 'short' })}` : '';
    return days + from + end;
  };
  const two = (n) => String(n).padStart(2, '0');
  const clockAt = (ms) => {
    const c = wallClock(settings.timezone, ms);
    return clockLabel(`${two(c.H)}:${two(c.M)}`, clock);
  };
  const dateText = (d, o) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', ...o });
  const rangeText = $derived.by(() => {
    if (isMonth) return dateText(range.days[0].date, { month: 'long', year: 'numeric' });
    const first = range.days[0];
    const last = range.days.at(-1);
    const whole = range.from === first.from && range.to === last.to;
    if (whole && range.days.length === 1) return dateText(first.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (whole) return `${dateText(first.date, { day: 'numeric', month: 'short' })} to ${dateText(last.date, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    // The end's own date: a window that ends at midnight ends on the next day.
    const e = wallClock(settings.timezone, range.to);
    const endDate = `${e.y}-${String(e.m).padStart(2, '0')}-${String(e.d).padStart(2, '0')}`;
    return `${dateText(first.date, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clockAt(range.from)} to ${dateText(endDate, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clockAt(range.to)}`;
  });
  const lengthText = (secs) => (secs >= 3600 ? `${Math.floor(secs / 3600)} h ${String(Math.round((secs % 3600) / 60)).padStart(2, '0')} min` : `${Math.round(secs / 60)} min`);
  const strideText = $derived(stride >= 86_400_000 ? `${Math.round(stride / 86_400_000)} day${stride >= 2 * 86_400_000 ? 's' : ''}` : stride >= 3_600_000 ? `${Math.round(stride / 3_600_000)} hours` : `${Math.round(stride / 60000)} minutes`);

  // Month: per project and day, cycles that ran and start times still to come.
  const month = $derived.by(() => {
    if (!isMonth) return [];
    return tl.projects.map((p) => ({
      p,
      cells: range.days.map((day) => ({
        day,
        ran: p.past.filter((c) => c.start >= day.from && c.start < day.to).length,
        limited: p.past.some((c) => c.limited && c.start >= day.from && c.start < day.to),
        planned: (planning.planned[p.id] || []).filter((b) => b.at >= day.from && b.at < day.to && b.at >= tl.now).length
      }))
    }));
  });
  const today = $derived(todayIn(settings.timezone, tl.now));
</script>

<svelte:head><title>Schedule · Ziggurat</title></svelte:head>

<div class="page">
  <div class="top">
    <div>
      <h1>Schedule</h1>
      <p class="dim small">When each team's cycles start. Times in {zoneLabel(settings.timezone, tl.now)}, now {clockAt(tl.now)}. A team with no start times runs its cycles back to back.</p>
    </div>
    <span class="grow"></span>
    <div class="seg" aria-label="Clock">
      <button class="btn quiet sm" class:on={clock === '24'} aria-pressed={clock === '24'} onclick={() => setClock('24')} disabled={!!busy}>24 h</button>
      <button class="btn quiet sm" class:on={clock === '12'} aria-pressed={clock === '12'} onclick={() => setClock('12')} disabled={!!busy}>12 h</button>
    </div>
    <div class="seg" aria-label="How much time to show">
      {#each ['day', 'week', 'month'] as v (v)}
        <a class="btn quiet sm" class:on={tl.view === v && !tl.custom && !win} aria-current={tl.view === v && !tl.custom && !win ? 'page' : undefined} href={link(v, range.date)}>{v[0].toUpperCase() + v.slice(1)}</a>
      {/each}
    </div>
    <div class="seg" aria-label="Move through time">
      {#if isMonth}
        <a class="btn quiet sm icon" href={link('month', tl.range.prev)} aria-label="Earlier" title="The month before">‹</a>
      {:else}
        <button class="btn quiet sm icon" onclick={() => pan(-stride)} aria-label="Earlier" title="{strideText} earlier">‹</button>
      {/if}
      <a class="btn quiet sm" href={link('day', null)} title="Today, as a day">Today</a>
      {#if isMonth}
        <a class="btn quiet sm icon" href={link('month', tl.range.next)} aria-label="Later" title="The month after">›</a>
      {:else}
        <button class="btn quiet sm icon" onclick={() => pan(stride)} aria-label="Later" title="{strideText} later">›</button>
      {/if}
    </div>
  </div>

  {#if problem}<div class="panel note bad" role="alert">{problem}</div>{/if}
  {#if done}<div class="panel note good" role="status">{done}</div>{/if}

  <section class="panel block">
    <div class="row">
      <h2>{rangeText}</h2>
      <span class="grow"></span>
      <span class="legend small dim">
        <span class="key past"></span> ran <span class="key plan"></span> planned (typical length) <span class="key quiet"></span> quiet hours
        <span class="key over"></span> likely overlap <span class="key job"></span> planned job (estimate dashed)
      </span>
    </div>

    {#if !tl.projects.length}
      <p class="dim">No projects yet.</p>
    {:else if isMonth}
      <div class="scroll-x">
        <div class="month" style="--days: {range.days.length}">
          <span></span>
          {#each range.days as day (day.date)}
            <a class="mhead small" class:today={day.date === today} href={link('day', day.date)} title="Open this day">{Number(day.date.slice(8))}<br /><span class="dim">{day.name[0].toUpperCase()}</span></a>
          {/each}
          {#each month as r (r.p.id)}
            <span class="mname" style="--row: {r.p.accent}">{r.p.name}</span>
            {#each r.cells as c (c.day.date)}
              <span class="mcell" class:today={c.day.date === today} style="--row: {r.p.accent}" title="{r.p.name}, {c.day.date}: {c.ran} ran{c.limited ? ' (usage limit hit)' : ''}, {c.planned} planned">
                {#if c.ran}<b class:limited={c.limited}>{c.ran}</b>{/if}
                {#if c.planned}<i>{c.planned}</i>{/if}
              </span>
            {/each}
          {/each}
        </div>
      </div>
      <p class="dim small">Per day: cycles that ran (filled) and start times still to come (outlined). Open a day or the week to change times.</p>
    {:else}
      <Timeline {rows} {range} tz={settings.timezone} {clock} {quiet} now={tl.now} {selected} onmove={move} onadd={add} onselect={select} onzoom={zoom} onpan={pan} onjob={(project, job) => (job.kind === 'once' ? openOnce(project, job) : (jobOpen = { project, job }))} onjobmove={editable ? dragMove : null} ghost={moving ? { project: moving.project, minutes: moving.job.minutes, at: movePick } : null} onpick={(_, ms) => ((movePick = ms), (moveHit = null))} />
    {#if moving && moveHit}
      <ConflictChoice conflicts={moveHit} team={project(moving.project)?.name} {clockAt} busy={!!busy} onafter={moveAfter} onskip={canSkipMove ? skipMove : null} oncancel={() => (moveHit = null)} />
    {/if}
    {#if moveNote}
      <div class="actions gapnote small">
        <span>
          {#if moveNote.kind === 'builds'}It builds on {moveNote.order != null ? `#${moveNote.order} ` : ''}“{moveNote.title}”, which would not be merged by then: it would wait.{:else}That is close behind {moveNote.order != null ? `#${moveNote.order} ` : ''}“{moveNote.title}”. Jobs run over, and the gate needs a few minutes to merge.{/if}
          Leaving room: <b>{clockAt(moveNote.at)}</b>.
        </span>
        <span class="spacer"></span>
        <button class="btn sm" onclick={() => (movePick = moveNote.at)} disabled={!!busy}>Place it there</button>
      </div>
    {/if}
    {#if moving}
      <div class="actions movebar">
        {#if movePick}
          <span>Move <b>{moving.job.kind === 'plan' ? 'the planning cycle' : moving.job.title}</b> to <b>{whenAt(movePick)}</b>, until about {clockAt(movePick + moving.job.minutes * 60000)}.</span>
        {:else}
          <span class="small">Click in {tl.projects.find((x) => x.id === moving.project)?.name}'s row to pick the new start (estimate {moving.job.minutes} min).</span>
        {/if}
        <span class="spacer"></span>
        <button class="btn quiet" onclick={() => ((moving = null), (movePick = null), (moveHit = null))} disabled={!!busy}>Cancel</button>
        <button class="btn primary" onclick={() => confirmMove()} disabled={!movePick || !!busy || !!moveHit}>{busy === 'move' ? 'Moving…' : 'Move it'}</button>
      </div>
    {/if}
      <p class="dim small">
        <b>Move through time:</b> the arrows, or scroll sideways (Shift + wheel). <b>Zoom in:</b> drag across empty space. <b>Change times:</b> drag a planned start, or
        click an empty place in a row to add one (repeating, or one time only), or click a start to change it. Every change is sent to the team's VM at once. <b>Move a planned job or one-time cycle:</b> drag it along its row.
      </p>
    {/if}
  </section>

  {#if usage.length}
    <section class="panel note caution block">
      <h2>Shared usage</h2>
      <ul class="warns">
        {#each usage as w (w.text)}<li>{w.text}</li>{/each}
      </ul>
      <p class="dim small">Every team draws on the same subscription. Nothing here is blocked.</p>
    </section>
  {/if}

  {#if planning.warnings.length}
    <section class="panel note caution block">
      <h2>Worth a look</h2>
      <ul class="warns">
        {#each planning.warnings as w (w.kind + w.text)}<li>{w.text}</li>{/each}
      </ul>
      <p class="dim small">Nothing here is blocked. A cycle has no fixed length: overlaps are judged from each team's typical one.</p>
    </section>
  {/if}

  <div class="cols">
    {#each tl.projects as p (p.id)}
      {@const s = scheduleOf(p)}
      <section class="panel block" style="--row: {p.accent}">
        <div class="row">
          <h2><span class="dot"></span>{p.name}</h2>
          <span class="grow"></span>
          {#if p.runCycle}<RunCycle id={p.id} name={p.name} rc={p.runCycle} quietNow={quietIntervals(settings, Date.now() - 1000, Date.now() + 1000).some((q) => Date.now() >= q.from && Date.now() < q.to)} small />{/if}
          <a class="small" href="/p/{p.id}/controls">Controls</a>
        </div>
        {#if !p.canSchedule}
          <p class="dim">{p.kitVersion ? `This VM runs kit ${p.kitVersion}. Start times need kit 0.9 or later.` : 'The VM does not answer, or has no kit yet.'}</p>
        {:else}
          <p class="small dim">
            {#if !s}No start times: its cycles follow each other until the daily cap{p.cap != null ? ` (${p.cap})` : ''} is used up.
            {:else}Its cycles start only at these times. Daily cap: {p.cap ?? 'not known'}. Typical cycle: {lengthText(p.typicalSecs)}.{/if}
          </p>
          {#if s}
            <div class="chips">
              {#each s.slots as slot, i (slotId(slot) + i)}
                <button class="btn quiet sm mono" class:on={selected?.project === p.id && selected.slot === i} onclick={() => select(p.id, i)} disabled={!editable} title="Change or remove this start time">
                  {clockLabel(slot.time, clock)} <span class="dim">{daysText(slot)}</span>
                </button>
              {/each}
              {#if !s.slots.length}<span class="dim small">None yet.</span>{/if}
            </div>
            {#each skipsOf(p) as c (c.date + c.slot)}
              <div class="actions">
                <span class="small">{dateText(c.date, { weekday: 'short', day: 'numeric', month: 'short' })} only: {clockLabel(c.slot.split('@')[1], clock)} skipped</span>
                {#if editable}<button class="btn quiet sm" onclick={() => undoSkip(p.id, c)} disabled={!!busy} title="Run this start again on that day">Undo</button>{/if}
              </div>
            {/each}
            <label class="stack"
              ><span class="small dim">These times are in</span>
              <select
                class="field"
                value={s.tz}
                onchange={(e) => {
                  draftOf(p.id).tz = e.currentTarget.value;
                  commit(p.id);
                }}
                disabled={!editable}
              >
                {#each zones as z (z.tz)}<option value={z.tz}>{z.label}</option>{/each}
              </select></label
            >
          {/if}
          <div class="actions">
            {#if p.schedule}<button class="btn danger sm" onclick={() => askClear(p)} disabled={!!busy}>Remove all…</button>{/if}
            <button class="btn quiet sm" onclick={() => addNow(p.id)} disabled={!editable || !!busy} title="A start time, repeating or one time only">+ Start time</button>
          </div>
        {/if}
      </section>
    {/each}
  </div>

  <section class="panel block">
    <div class="row">
      <h2>Your hours</h2>
      <span class="grow"></span>
      {#if !quietDraft}<button class="btn quiet sm" onclick={editSettings}>Change</button>{/if}
    </div>
    {#if !quietDraft}
      <p class="small dim">
        The timeline is shown in {zoneLabel(settings.timezone, tl.now)}.
        {#if settings.quiet.length}
          Quiet hours: {settings.quiet.map((q) => `${daysText(q)} ${clockLabel(q.from, clock)} to ${clockLabel(q.to, clock)}`).join('; ')}.
        {:else}
          No quiet hours set.
        {/if}
        Quiet hours are shaded, and a start time inside them is pointed out. Nothing is blocked.
      </p>
    {:else}
      <label class="stack narrow"
        ><span class="small dim">Time zone of the timeline</span>
        <select class="field" bind:value={quietDraft.timezone}>
          {#each zones as z (z.tz)}<option value={z.tz}>{z.label}</option>{/each}
        </select></label
      >
      {#each quietDraft.quiet as q, i (i)}
        <div class="row wrap">
          <div class="days">
            {#each DAYS as day (day)}
              <button class="btn quiet sm" class:on={has(q, day)} aria-pressed={has(q, day)} onclick={() => toggleQuietDay(q, day)}>{day[0].toUpperCase() + day.slice(1)}</button>
            {/each}
          </div>
          <input class="field mono" type="time" bind:value={q.from} aria-label="From" />
          <span class="dim">to</span>
          <input class="field mono" type="time" bind:value={q.to} aria-label="To" />
          <button class="btn danger sm" onclick={() => quietDraft.quiet.splice(i, 1)}>Remove</button>
        </div>
      {/each}
      <div class="actions">
        <button class="btn quiet" onclick={addQuiet}>+ Quiet hours</button>
        <span class="spacer"></span>
        <button class="btn quiet" onclick={() => (quietDraft = null)} disabled={!!busy}>Cancel</button>
        <button class="btn primary" onclick={saveSettings} disabled={!!busy}>{busy === 'settings' ? 'Saving…' : 'Save'}</button>
      </div>
    {/if}
  </section>

</div>

<ConfirmDialog {confirm} busy={!!busy} oncancel={() => (confirm = null)} />

{#if del && delSlot}
  {@const dp = project(del.project)}
  <Modal title="Delete a repeating start time" onclose={() => (del = null)}>
    <p class="small">
      {dp?.name}'s {clockLabel(delSlot.time, clock)} start ({daysText(delSlot)}). Delete it for:
    </p>
    <div class="actions end">
      <button class="btn quiet" onclick={() => (del = null)}>Cancel</button>
      <button class="btn" onclick={deleteOnce}>Only {dateText(del.date, { weekday: 'short', day: 'numeric', month: 'short' })}</button>
      <button class="btn danger" onclick={deleteAll}>This and every later day</button>
    </div>
    <p class="small dim">
      "Only that day" keeps the start time and skips that one start; you can undo it in the team's panel. It is sent to the VM at once.
    </p>
  </Modal>
{/if}

{#if scope}
  {@const sp = project(scope.id)}
  {@const slot = scopeSlot}
  <Modal title="Change a repeating start time" onclose={() => (scope = null)}>
    <p class="small">
      {sp?.name}'s {clockLabel(slot.time, clock)} start ({daysText(slot)}) to <b>{clockLabel(scope.time, clock)}</b>. Change it for:
    </p>
    <div class="actions end">
      <button class="btn quiet" onclick={() => (scope = null)}>Cancel</button>
      <button class="btn" onclick={moveOnce}>Only {dateText(scope.bar.date, { weekday: 'short', day: 'numeric', month: 'short' })}</button>
      <button class="btn primary" onclick={moveAll}>{slot.days[0] === 'daily' ? 'Every day' : `Every ${daysText(slot)}`}</button>
    </div>
    <p class="small dim">It is sent to the VM at once.</p>
  </Modal>
{/if}

{#if pop}
  {@const pp = project(pop.project)}
  <StartTimeDialog
    title={pop.mode === 'new' ? `${pp?.name}: add a start time` : pop.mode === 'once' ? `${pp?.name}: one-time cycle` : `${pp?.name}: start time`}
    bind:form={pop.form}
    existing={pop.mode !== 'new'}
    canRepeatMore={!!pp?.canRepeat}
    canOnce={!!pp?.canRepeat}
    zone={zoneLabel(tzOf(pp), tl.now)}
    typical={`A cycle of ${pp?.name} typically takes ${lengthText(pp?.typicalSecs || 3600)}.`}
    today={todayIn(tzOf(pp), tl.now)}
    busy={popBusy}
    problem={popProblem}
    ondone={popDone}
    ondelete={popDelete}
    oncancel={() => (pop = null)}
  />
{/if}

{#if jobOpen}
  {@const j = jobOpen.job}
  {@const team = tl.projects.find((x) => x.id === jobOpen.project)}
  <Modal title={j.kind === 'plan' ? `${team?.name}: planning cycle` : `${team?.name}: planned job`} onclose={() => (jobOpen = null)}>
    <p class="small">
      {JOB_STATE[j.state]} <b>{whenAt(j.start)}</b>{j.state === 'done' ? `, until ${clockAt(j.end)}` : ''}. Estimate {j.minutes} min{j.state === 'done' ? `, took ${lengthText((j.end - j.start) / 1000)}` : ''}.
    </p>
    {#if j.wait}<p class="small s-interrupted">Its time has come: {waitText(j.wait)}.</p>{/if}
    {#if j.state === 'set' && rows.find((r) => r.id === jobOpen.project)?.expected?.[j.id]}
      <p class="small s-interrupted">Expected to start about {clockAt(rows.find((r) => r.id === jobOpen.project).expected[j.id])} instead of {clockAt(j.start)}.</p>
    {/if}
    {#if j.stopped}<p class="small s-failed">Stopped by the time limit: it ran to twice its estimate. What it had not submitted is still on its branches.</p>{/if}
    {#if j.state === 'running' && tl.now > j.estEnd}
      <p class="small s-interrupted">
        Past its estimate.
        {#if j.noBrake}No time limit is set for this job.{:else if j.kind !== 'plan'}{team?.name}'s lead is told to wrap up at {clockAt(j.start + Math.max(j.minutes * 1.5, j.minutes + 10) * 60000)}; the job is stopped at {clockAt(j.start + Math.max(j.minutes * 2, j.minutes + 20) * 60000)}.{/if}
      </p>
    {/if}
    {#if j.prop}
      <ProposalCard prop={j.prop} bare />
    {:else if j.kind === 'plan'}
      <p class="small dim">The lead looks for what to do next and writes proposals, no code.</p>
    {/if}
    <div class="actions">
      {#if j.state === 'set'}
        <button class="btn danger" onclick={cancelJob} disabled={!!busy}>{busy === 'cancel-job' ? 'Cancelling…' : 'Cancel it'}</button>
      {/if}
      <a class="btn quiet" href="/p/{jobOpen.project}/backlog">Open in Backlog</a>
      <span class="spacer"></span>
      {#if j.state === 'set'}<button class="btn primary" onclick={startMove} disabled={!!busy}>Move…</button>{/if}
    </div>
  </Modal>
{/if}

<style>
  .page {
    padding: 32px 24px;
    max-width: 1500px;
    width: 100%;
    margin: 0 auto;
  }
  .top {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .top p,
  .block p {
    margin: 0;
  }
  .grow {
    flex: 1;
  }
  .gapnote {
    margin-top: 10px;
    padding: 8px 12px;
    border: 1px solid var(--warn);
    border-radius: 10px;
    background: rgba(251, 191, 36, 0.08);
  }
  .movebar {
    margin-top: 10px;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: rgba(var(--glow), 0.08);
  }
  .block {
    padding: 18px;
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }
  .cols .block {
    margin-bottom: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .row.wrap {
    flex-wrap: wrap;
    align-items: flex-end;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .stack.narrow {
    max-width: 460px;
  }
  select.field {
    min-height: 36px;
  }
  .days,
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    background: var(--row);
    margin-right: 8px;
  }
  .warns {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .legend {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .key {
    display: inline-block;
    width: 16px;
    height: 10px;
    border-radius: 3px;
    margin-left: 8px;
  }
  .key.past {
    background: var(--cyan);
    opacity: 0.85;
  }
  .key.plan {
    border: 1px dashed var(--cyan);
    background: rgba(var(--glow), 0.16);
  }
  .key.quiet {
    background: var(--warn);
    opacity: 0.25;
  }
  .key.job {
    background: repeating-linear-gradient(-45deg, var(--accent) 0 3px, rgba(var(--glow), 0.3) 3px 7px);
    border: 1px dashed var(--accent);
  }
  .key.over {
    border: 2px solid var(--warn);
  }
  .month {
    display: grid;
    grid-template-columns: 140px repeat(var(--days), minmax(26px, 1fr));
    gap: 3px;
    align-items: stretch;
    min-width: 900px;
  }
  .mhead {
    text-align: center;
    text-decoration: none;
    color: var(--ink-2);
    border-radius: 6px;
    padding: 2px 0;
  }
  .mhead.today,
  .mcell.today {
    outline: 1px solid var(--line-strong);
  }
  .mname {
    align-self: center;
    font-weight: 600;
    border-left: 4px solid var(--row);
    padding-left: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mcell {
    min-height: 38px;
    border-radius: 6px;
    background: var(--well);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .mcell b {
    font-weight: 600;
    color: var(--bg);
    background: var(--row);
    border-radius: 4px;
    padding: 0 5px;
  }
  .mcell b.limited {
    box-shadow: 0 0 0 2px var(--critical);
  }
  .mcell i {
    font-style: normal;
    color: var(--row);
    border: 1px dashed var(--row);
    border-radius: 4px;
    padding: 0 4px;
  }
</style>
