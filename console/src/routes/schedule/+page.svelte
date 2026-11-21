<script>
  import { goto, invalidateAll } from '$app/navigation';
  import Timeline from '$lib/components/Timeline.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import ProposalCard from '$lib/components/ProposalCard.svelte';
  import { DAYS, plan, quietIntervals, validateSchedule, validTimeZone, slotId, todayIn, wallClock, windowRange, cleanWindow, clockLabel, zoneChoices, zoneLabel } from '$lib/schedule.js';

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
  let selected = $state(null); // {project, slot}
  let busy = $state('');
  let problem = $state('');
  let done = $state('');
  let confirm = $state(null);
  let quietDraft = $state(null); // a copy of the settings while they are edited

  const copy = (v) => JSON.parse(JSON.stringify(v));
  const scheduleOf = (p) => (drafts[p.id] !== undefined ? drafts[p.id] : p.schedule);
  const usable = (s) => !!s && s.slots.length > 0 && validTimeZone(s.tz);
  const changed = $derived(tl.projects.filter((p) => drafts[p.id] !== undefined));

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
    if (drafts[p.id] !== undefined) return 'changed, not applied';
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
      planned: planning.planned[p.id] || [],
      jobs: p.jobs || [],
      log: p.log
    }))
  );

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
  function startMove() {
    moving = jobOpen;
    movePick = null;
    jobOpen = null;
  }
  async function confirmMove() {
    const m = moving;
    const out = await jobAct(m.project, { action: 'move-at', id: m.job.id, at: Math.round(movePick / 1000) }, 'move');
    if (out) {
      moving = null;
      movePick = null;
    }
  }
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

  function move(id, index, time) {
    const d = draftOf(id);
    if (clash(d, { ...d.slots[index], time }, index)) {
      problem = 'There is already a start time then, on the same days.';
      return;
    }
    problem = '';
    d.slots[index].time = time;
    selected = { project: id, slot: index };
  }
  function add(id, time, day) {
    const d = draftOf(id);
    // In a stretch of several days a click means that day; otherwise every day.
    const slot = { days: span > 36 * 3_600_000 ? [day] : ['daily'], time };
    if (clash(d, slot, -1)) return;
    problem = '';
    d.slots.push(slot);
    selected = { project: id, slot: d.slots.length - 1 };
  }
  function select(id, index) {
    selected = { project: id, slot: index };
  }
  const sel = $derived(selected && scheduleOf(project(selected.project))?.slots[selected.slot] ? { p: project(selected.project), slot: scheduleOf(project(selected.project)).slots[selected.slot] } : null);

  function setTime(time) {
    if (/^\d{2}:\d{2}$/.test(time)) move(selected.project, selected.slot, time);
  }
  function toggleDay(day) {
    const d = draftOf(selected.project);
    const slot = d.slots[selected.slot];
    let days = slot.days[0] === 'daily' ? [...DAYS] : [...slot.days];
    days = days.includes(day) ? days.filter((x) => x !== day) : [...days, day];
    if (!days.length) return;
    days = DAYS.filter((x) => days.includes(x));
    const next = { ...slot, days: days.length === 7 ? ['daily'] : days };
    if (clash(d, next, selected.slot)) return;
    d.slots[selected.slot] = next;
  }
  function removeSlot() {
    const d = draftOf(selected.project);
    d.slots.splice(selected.slot, 1);
    selected = null;
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
  async function apply(p) {
    let s;
    try {
      s = validateSchedule(drafts[p.id]);
    } catch (e) {
      problem = `${p.name}: ${e.message}`;
      return;
    }
    const out = await send({ action: 'set', project: p.id, tz: s.tz, slots: s.slots }, `apply-${p.id}`);
    if (!out) return;
    discard(p.id);
    done = `${p.name}: applied. Its cycles now start at these times only.`;
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
  const daysText = (slot) => (slot.days[0] === 'daily' ? 'every day' : slot.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(', '));
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
        <span class="key over"></span> likely overlap <span class="key job"></span> backlog job (estimate dashed)
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
      <Timeline {rows} {range} tz={settings.timezone} {clock} {quiet} now={tl.now} {selected} onmove={move} onadd={add} onselect={select} onzoom={zoom} onpan={pan} onjob={(project, job) => (jobOpen = { project, job })} ghost={moving ? { project: moving.project, minutes: moving.job.minutes } : null} onpick={(_, ms) => (movePick = ms)} />
    {#if moving}
      <div class="actions movebar">
        {#if movePick}
          <span>Move <b>{moving.job.kind === 'plan' ? 'the planning cycle' : moving.job.title}</b> to <b>{whenAt(movePick)}</b>, until about {clockAt(movePick + moving.job.minutes * 60000)}.</span>
        {:else}
          <span class="small">Click in {tl.projects.find((x) => x.id === moving.project)?.name}'s row to pick the new start (estimate {moving.job.minutes} min).</span>
        {/if}
        <span class="spacer"></span>
        <button class="btn quiet" onclick={() => ((moving = null), (movePick = null))} disabled={!!busy}>Cancel</button>
        <button class="btn primary" onclick={confirmMove} disabled={!movePick || !!busy}>{busy === 'move' ? 'Moving…' : 'Move it'}</button>
      </div>
    {/if}
      <p class="dim small">
        <b>Move through time:</b> the arrows, or scroll sideways (Shift + wheel). <b>Zoom in:</b> drag across empty space. <b>Change times:</b> drag a planned start, or
        click an empty place in a row to add one. Changes are not active until you apply them.
      </p>
    {/if}
  </section>

  {#if changed.length}
    <section class="panel note caution block" aria-label="Changes not applied yet">
      <h2>Not active yet</h2>
      <p class="small">You changed start times here. A team keeps its old times until you apply the change, which sends the new times to that team's VM.</p>
      {#each changed as p (p.id)}
        <div class="actions">
          <span><b>{p.name}</b>: {scheduleOf(p).slots.length ? scheduleOf(p).slots.map((s) => `${clockLabel(s.time, clock)} ${daysText(s)}`).join(' · ') : 'no start times left'}</span>
          <span class="spacer"></span>
          <button class="btn quiet" onclick={() => discard(p.id)} disabled={!!busy}>Undo changes</button>
          <button class="btn primary" onclick={() => apply(p)} disabled={!!busy || !usable(scheduleOf(p))}>{busy === `apply-${p.id}` ? 'Applying…' : `Apply to ${p.name}`}</button>
        </div>
      {/each}
    </section>
  {/if}

  {#if sel && editable}
    <section class="panel lit block" aria-label="Selected start time">
      <div class="row">
        <h2>{sel.p.name}: starts at {clockLabel(sel.slot.time, clock)}, {daysText(sel.slot)}</h2>
        <span class="grow"></span>
        <button class="btn quiet icon" onclick={() => (selected = null)} aria-label="Close" title="Close">×</button>
      </div>
      <div class="row wrap">
        <label class="stack"
          ><span class="small dim">Start</span>
          <input class="field mono" type="time" step="900" value={sel.slot.time} onchange={(e) => setTime(e.currentTarget.value)} /></label
        >
        <div class="stack">
          <span class="small dim">On</span>
          <div class="days">
            {#each DAYS as day (day)}
              <button class="btn quiet sm" class:on={has(sel.slot, day)} aria-pressed={has(sel.slot, day)} onclick={() => toggleDay(day)}>{day[0].toUpperCase() + day.slice(1)}</button>
            {/each}
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="btn danger sm" onclick={removeSlot}>Remove this start time</button>
      </div>
      <p class="dim small">
        Time zone: {zoneLabel(scheduleOf(sel.p).tz, tl.now)}. A cycle of {sel.p.name} typically takes {lengthText(sel.p.typicalSecs)}. If its previous cycle is still running at a
        start time, that one is skipped.
      </p>
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
          <a class="small" href="/p/{p.id}/controls">Controls</a>
        </div>
        {#if !p.canSchedule}
          <p class="dim">{p.kitVersion ? `This VM runs kit ${p.kitVersion}. Start times need kit 0.9 or later.` : 'The VM does not answer, or has no kit yet.'}</p>
        {:else}
          <p class="small dim">
            {#if !s}No start times: its cycles follow each other until the daily cap{p.cap != null ? ` (${p.cap})` : ''} is used up.
            {:else if drafts[p.id] !== undefined}Changed here. Not active until you apply it.
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
            <label class="stack"
              ><span class="small dim">These times are in</span>
              <select
                class="field"
                value={s.tz}
                onchange={(e) => {
                  draftOf(p.id).tz = e.currentTarget.value;
                }}
                disabled={!editable}
              >
                {#each zones as z (z.tz)}<option value={z.tz}>{z.label}</option>{/each}
              </select></label
            >
          {/if}
          <div class="actions">
            {#if p.schedule}<button class="btn danger sm" onclick={() => askClear(p)} disabled={!!busy}>Remove all…</button>{/if}
            <button class="btn quiet sm" onclick={() => add(p.id, '00:00', range.days[0].name)} disabled={!editable || !!busy} title="Adds a start time at midnight; then set its time and days">+ Start time</button>
            {#if drafts[p.id] !== undefined}
              <span class="spacer"></span>
              <button class="btn quiet sm" onclick={() => discard(p.id)} disabled={!!busy}>Undo</button>
              <button class="btn primary sm" onclick={() => apply(p)} disabled={!!busy || !usable(s)} title="Send these start times to {p.name}'s VM">{busy === `apply-${p.id}` ? 'Applying…' : 'Apply'}</button>
            {/if}
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

{#if jobOpen}
  {@const j = jobOpen.job}
  {@const team = tl.projects.find((x) => x.id === jobOpen.project)}
  <Modal title={j.kind === 'plan' ? `${team?.name}: planning cycle` : `${team?.name}: backlog job`} onclose={() => (jobOpen = null)}>
    <p class="small">
      {JOB_STATE[j.state]} <b>{whenAt(j.start)}</b>{j.state === 'done' ? `, until ${clockAt(j.end)}` : ''}. Estimate {j.minutes} min{j.state === 'done' ? `, took ${lengthText((j.end - j.start) / 1000)}` : ''}.
    </p>
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
