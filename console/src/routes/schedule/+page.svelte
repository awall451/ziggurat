<script>
  import { invalidateAll } from '$app/navigation';
  import Timeline from '$lib/components/Timeline.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import { DAYS, plan, quietIntervals, validateSchedule, validTimeZone, slotId, todayIn, wallClock } from '$lib/schedule.js';

  let { data } = $props();
  const tl = $derived(data.timeline);
  const settings = $derived(tl.settings);
  const range = $derived(tl.range);
  const editable = $derived(tl.view !== 'month');

  // Changes are kept here, per project, until they are saved to the VM.
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

  // What is planned in the shown range, with drafts counted as if they were saved.
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
    if (drafts[p.id] !== undefined) return 'not saved yet';
    if (!s) return 'back to back';
    return `${s.slots.length} slot${s.slots.length === 1 ? '' : 's'}${p.cap != null ? ` · cap ${p.cap}` : ''}`;
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
      log: p.log
    }))
  );

  const project = (id) => tl.projects.find((p) => p.id === id);
  function draftOf(id) {
    if (drafts[id] === undefined) drafts[id] = copy(project(id).schedule) || { tz: settings.timezone, slots: [] };
    return drafts[id];
  }
  const clash = (d, slot, except) => d.slots.some((s, i) => i !== except && slotId(s) === slotId(slot));

  function move(id, index, time) {
    const d = draftOf(id);
    if (clash(d, { ...d.slots[index], time }, index)) {
      problem = 'There is already a slot at that time on the same days.';
      return;
    }
    problem = '';
    d.slots[index].time = time;
    selected = { project: id, slot: index };
  }
  function add(id, time, day) {
    const d = draftOf(id);
    const slot = { days: tl.view === 'week' ? [day] : ['daily'], time };
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
  async function save(p) {
    let s;
    try {
      s = validateSchedule(drafts[p.id]);
    } catch (e) {
      problem = `${p.name}: ${e.message}`;
      return;
    }
    const out = await send({ action: 'set', project: p.id, tz: s.tz, slots: s.slots }, `save-${p.id}`);
    if (!out) return;
    discard(p.id);
    done = `${p.name}: schedule saved. Cycles now start at its slots only.`;
  }
  function askClear(p) {
    confirm = {
      title: `Clear the schedule of ${p.name}?`,
      body: 'Its cycles follow each other again, 15 minutes apart, until the daily cap is used up. That is how every team runs without a schedule.',
      word: 'Clear schedule',
      danger: true,
      run: async () => {
        const out = await send({ action: 'clear', project: p.id }, `clear-${p.id}`);
        if (!out) return;
        discard(p.id);
        done = `${p.name}: schedule cleared.`;
      }
    };
  }

  // Quiet hours and the time zone of the timeline.
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
    const out = await send({ action: 'settings', timezone: quietDraft.timezone, quiet: quietDraft.quiet }, 'settings');
    if (!out) return;
    quietDraft = null;
    done = 'Settings saved.';
  }

  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const link = (view, date) => `/schedule?view=${view}${date ? `&date=${date}` : ''}`;
  const has = (slot, day) => slot.days[0] === 'daily' || slot.days.includes(day);
  const daysText = (slot) => (slot.days[0] === 'daily' ? 'every day' : slot.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(', '));
  const rangeText = $derived.by(() => {
    const f = (d, o) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', ...o });
    if (tl.view === 'day') return f(range.days[0].date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (tl.view === 'month') return f(range.days[0].date, { month: 'long', year: 'numeric' });
    return `${f(range.days[0].date, { day: 'numeric', month: 'short' })} to ${f(range.days.at(-1).date, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  });
  const lengthText = (secs) => (secs >= 3600 ? `${Math.floor(secs / 3600)} h ${String(Math.round((secs % 3600) / 60)).padStart(2, '0')} min` : `${Math.round(secs / 60)} min`);

  // Month: per project and day, cycles that ran and slots still to come.
  const month = $derived.by(() => {
    if (tl.view !== 'month') return [];
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
  const zoneClock = $derived.by(() => {
    const c = wallClock(settings.timezone, tl.now);
    return `${String(c.H).padStart(2, '0')}:${String(c.M).padStart(2, '0')}`;
  });
</script>

<svelte:head><title>Schedule · Ziggurat</title></svelte:head>

<div class="page">
<div class="top">
  <div>
    <h1>Schedule</h1>
    <p class="dim small">
      When each team's cycles start. Times in {settings.timezone} (now {zoneClock}). A team without a schedule runs its cycles back to back.
    </p>
  </div>
  <span class="grow"></span>
  <div class="seg" role="tablist" aria-label="View">
    {#each ['day', 'week', 'month'] as v (v)}
      <a class="btn quiet" class:on={tl.view === v} role="tab" aria-selected={tl.view === v} href={link(v, range.date)}>{v[0].toUpperCase() + v.slice(1)}</a>
    {/each}
  </div>
  <div class="seg">
    <a class="btn quiet" href={link(tl.view, range.prev)} aria-label="Earlier">‹</a>
    <a class="btn quiet" href={link(tl.view, null)}>Today</a>
    <a class="btn quiet" href={link(tl.view, range.next)} aria-label="Later">›</a>
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
      <span class="key over"></span> likely overlap
    </span>
  </div>

  {#if !tl.projects.length}
    <p class="dim">No projects yet.</p>
  {:else if tl.view === 'month'}
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
    <p class="dim small">Per day: cycles that ran (filled) and slots still to come (outlined). Open a day or the week to change times.</p>
  {:else}
    <Timeline {rows} {range} view={tl.view} tz={settings.timezone} {quiet} now={tl.now} {selected} onmove={move} onadd={add} onselect={select} />
    <p class="dim small">Drag a planned slot to another time (it snaps to 15 minutes), or click an empty place in a row to add one. Nothing changes on a VM until you save.</p>
  {/if}
</section>

{#if sel && editable}
  <section class="panel lit block" aria-label="Selected slot">
    <div class="row">
      <h2>{sel.p.name}: slot at {sel.slot.time}, {daysText(sel.slot)}</h2>
      <span class="grow"></span>
      <button class="btn quiet" onclick={() => (selected = null)}>Close</button>
    </div>
    <div class="row wrap">
      <label class="stack"
        ><span class="small dim">Start ({scheduleOf(sel.p).tz})</span>
        <input class="field mono" type="time" step="900" value={sel.slot.time} onchange={(e) => setTime(e.currentTarget.value)} /></label
      >
      <div class="stack">
        <span class="small dim">Days</span>
        <div class="days">
          {#each DAYS as day (day)}
            <button class="btn quiet day" class:on={has(sel.slot, day)} aria-pressed={has(sel.slot, day)} onclick={() => toggleDay(day)}>{day[0].toUpperCase() + day.slice(1)}</button>
          {/each}
        </div>
      </div>
      <span class="grow"></span>
      <button class="btn stop" onclick={removeSlot}>Remove slot</button>
    </div>
    <p class="dim small">A cycle of {sel.p.name} typically takes {lengthText(sel.p.typicalSecs)} (median of its last cycles). If the previous cycle is still running when a slot comes, that slot is skipped.</p>
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
        <p class="dim">{p.kitVersion ? `This VM runs kit ${p.kitVersion}. Schedules need kit 0.9 or later.` : 'The VM does not answer, or has no kit yet.'}</p>
      {:else}
        <p class="small dim">
          {#if !s}No schedule: cycles follow each other until the daily cap{p.cap != null ? ` (${p.cap})` : ''} is used up.
          {:else if drafts[p.id] !== undefined}Changed here, not saved to the VM yet.
          {:else}Cycles start only at these times. Daily cap: {p.cap ?? 'not known'}. Typical cycle: {lengthText(p.typicalSecs)}.{/if}
        </p>
        {#if s}
          <label class="stack"
            ><span class="small dim">Time zone of these times</span>
            <input
              class="field mono"
              list="zones"
              value={s.tz}
              onchange={(e) => {
                draftOf(p.id).tz = e.currentTarget.value.trim();
              }}
            /></label
          >
          {#if !validTimeZone(s.tz)}<p class="s-failed small">Not a time zone name. Example: Europe/Amsterdam.</p>{/if}
          <div class="chips">
            {#each s.slots as slot, i (slotId(slot) + i)}
              <button class="btn quiet chipbtn mono" class:on={selected?.project === p.id && selected.slot === i} onclick={() => select(p.id, i)} disabled={!editable}>
                {slot.time} <span class="dim">{daysText(slot)}</span>
              </button>
            {/each}
            {#if !s.slots.length}<span class="dim small">No slots yet.</span>{/if}
          </div>
        {/if}
        <div class="row wrap">
          <button class="btn quiet" onclick={() => add(p.id, '00:00', range.days[0].name)} disabled={!editable || !!busy}>Add a slot</button>
          {#if drafts[p.id] !== undefined}
            <button class="btn go" onclick={() => save(p)} disabled={!!busy || !usable(s)}>{busy === `save-${p.id}` ? 'Saving…' : 'Save to the VM'}</button>
            <button class="btn quiet" onclick={() => discard(p.id)} disabled={!!busy}>Discard changes</button>
          {/if}
          <span class="grow"></span>
          {#if p.schedule}<button class="btn quiet" onclick={() => askClear(p)} disabled={!!busy}>Clear schedule…</button>{/if}
        </div>
      {/if}
    </section>
  {/each}
</div>
<datalist id="zones">
  {#each zones as z (z)}<option value={z}></option>{/each}
</datalist>

<section class="panel block">
  <div class="row">
    <h2>Your hours</h2>
    <span class="grow"></span>
    {#if !quietDraft}<button class="btn quiet" onclick={editSettings}>Change</button>{/if}
  </div>
  {#if !quietDraft}
    <p class="small dim">
      The timeline is shown in {settings.timezone}.
      {#if settings.quiet.length}
        Quiet hours: {settings.quiet.map((q) => `${daysText(q)} ${q.from} to ${q.to}`).join('; ')}.
      {:else}
        No quiet hours set.
      {/if}
      Quiet hours are shaded and a slot that starts in them is pointed out. Nothing is blocked.
    </p>
  {:else}
    <label class="stack narrow"><span class="small dim">Time zone of the timeline</span><input class="field mono" list="zones" bind:value={quietDraft.timezone} /></label>
    {#each quietDraft.quiet as q, i (i)}
      <div class="row wrap">
        <div class="days">
          {#each DAYS as day (day)}
            <button class="btn quiet day" class:on={has(q, day)} aria-pressed={has(q, day)} onclick={() => toggleQuietDay(q, day)}>{day[0].toUpperCase() + day.slice(1)}</button>
          {/each}
        </div>
        <input class="field mono" type="time" bind:value={q.from} aria-label="From" />
        <span class="dim">to</span>
        <input class="field mono" type="time" bind:value={q.to} aria-label="To" />
        <button class="btn quiet" onclick={() => quietDraft.quiet.splice(i, 1)}>Remove</button>
      </div>
    {/each}
    <div class="row wrap">
      <button class="btn quiet" onclick={addQuiet}>Add quiet hours</button>
      <button class="btn go" onclick={saveSettings} disabled={!!busy}>{busy === 'settings' ? 'Saving…' : 'Save'}</button>
      <button class="btn quiet" onclick={() => (quietDraft = null)} disabled={!!busy}>Cancel</button>
    </div>
  {/if}
</section>

</div>

<ConfirmDialog {confirm} busy={!!busy} oncancel={() => (confirm = null)} />

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
  .seg {
    display: flex;
    gap: 4px;
  }
  .seg a {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
  .btn.on {
    border-color: var(--line-strong);
    background: rgba(var(--glow), 0.2);
    color: var(--ink-strong);
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
    max-width: 320px;
  }
  .days,
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .btn.day {
    min-height: 30px;
    padding: 0 9px;
    font-size: 12px;
  }
  .chipbtn {
    min-height: 30px;
    padding: 0 10px;
    font-size: 12px;
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
