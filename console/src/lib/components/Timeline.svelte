<script>
  // One row per project, time across. Past cycles are solid, the running one
  // grows to "now", planned slots are dashed (their end is a guess). Planned
  // slots can be dragged to another time of day; an empty place in a row adds one.
  import { wallClock, timeOfDay, DAYS } from '$lib/schedule.js';

  let {
    rows = [], // [{id, name, accent, tz, editable, note, past, running, planned, log}]
    range, // {from, to, days}
    view = 'week',
    tz, // the time zone the axis is drawn in
    quiet = [], // [{from, to}]
    now = Date.now(),
    selected = null, // {project, slot}
    onmove = () => {}, // (project, slot index, 'HH:MM')
    onadd = () => {}, // (project, 'HH:MM', day name)
    onselect = () => {} // (project, slot index)
  } = $props();

  const LABEL = 150;
  const HEAD = 34;
  const ROW = 46;
  const PAD = 10;
  let width = $state(1100);
  const track = $derived(Math.max(300, width - LABEL - PAD));
  const height = $derived(HEAD + rows.length * ROW + 8);
  const span = $derived(range.to - range.from);
  const x = (t) => LABEL + ((Math.min(Math.max(t, range.from), range.to) - range.from) / span) * track;
  const two = (n) => String(n).padStart(2, '0');

  // Hour lines: every hour for a day (labelled every 2), every 6 hours for a week.
  const ticks = $derived.by(() => {
    const out = [];
    const step = view === 'day' ? 3_600_000 : 6 * 3_600_000;
    for (const day of range.days) {
      for (let t = day.from; t < day.to; t += step) {
        const c = wallClock(tz, t);
        out.push({ t, major: t === day.from, label: view === 'day' ? (c.H % 2 === 0 ? two(c.H) : '') : c.H === 12 ? '12' : '' });
      }
    }
    return out;
  });
  const dayLabel = (day) => `${day.name[0].toUpperCase()}${day.name.slice(1)} ${Number(day.date.slice(8))}`;
  const clockText = (t) => {
    const c = wallClock(tz, t);
    return `${two(c.H)}:${two(c.M)}`;
  };
  const lengthText = (ms) => {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} h ${two(m % 60)} min` : `${m} min`;
  };

  let drag = $state(null); // {project, slot, at, startX, dx, moved}

  function grab(e, row, bar) {
    if (!row.editable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = { project: row.id, slot: bar.slot, at: bar.at, startX: e.clientX, dx: 0, moved: false, tz: row.tz };
  }
  function pull(e) {
    if (!drag) return;
    drag.dx = e.clientX - drag.startX;
    if (Math.abs(drag.dx) > 4) drag.moved = true;
  }
  function drop() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return onselect(d.project, d.slot);
    onmove(d.project, d.slot, timeOfDay(d.tz, d.at + (d.dx / track) * span));
  }
  const shift = (row, bar) => (drag && drag.project === row.id && drag.slot === bar.slot ? drag.dx : 0);

  function addAt(e, row) {
    if (!row.editable) return;
    const box = e.currentTarget.getBoundingClientRect();
    const t = range.from + ((e.clientX - box.left) / box.width) * span;
    const c = wallClock(row.tz, t);
    const name = DAYS[(new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay() + 6) % 7];
    onadd(row.id, timeOfDay(row.tz, t), name);
  }
  function key(e, row, bar) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onselect(row.id, bar.slot);
    }
  }
</script>

<div class="wrap" bind:clientWidth={width}>
  <svg {width} {height} role="group" aria-label="Cycle timeline">
    <defs>
      <pattern id="tl-limit" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="3" height="6" fill="var(--critical)" opacity="0.55" />
      </pattern>
    </defs>

    <!-- quiet hours, behind everything -->
    {#each quiet as q (q.from)}
      <rect class="quiet" x={x(q.from)} y={HEAD} width={Math.max(0, x(q.to) - x(q.from))} height={rows.length * ROW}>
        <title>Your quiet hours</title>
      </rect>
    {/each}

    <!-- axis -->
    {#each ticks as t (t.t)}
      <line class={t.major ? 'grid major' : 'grid'} x1={x(t.t)} x2={x(t.t)} y1={t.major ? 6 : HEAD} y2={height - 6} />
      {#if t.label}<text class="tick" x={x(t.t) + 3} y={HEAD - 6}>{t.label}</text>{/if}
    {/each}
    {#if view !== 'day'}
      {#each range.days as day (day.date)}
        <text class="day" x={x(day.from) + 6} y={16}>{dayLabel(day)}</text>
      {/each}
    {/if}

    {#each rows as row, i (row.id)}
      {@const y = HEAD + i * ROW}
      <g style="--row: {row.accent}">
        <line class="rule" x1={0} x2={width} y1={y + ROW} y2={y + ROW} />
        <text class="name" x={8} y={y + 20}>{row.name}</text>
        <text class="sub" x={8} y={y + 36}>{row.note}</text>
        <!-- an empty place in the row adds a slot there -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <rect class="lane" class:editable={row.editable} x={LABEL} y={y + 2} width={track} height={ROW - 4} onclick={(e) => addAt(e, row)}>
          {#if row.editable}<title>Click to add a slot here</title>{/if}
        </rect>

        {#each row.past as c (c.start)}
          <rect class="past" x={x(c.start)} y={y + 10} width={Math.max(3, x(c.end) - x(c.start))} height={ROW - 20} rx="3">
            <title>{row.name}: ran {clockText(c.start)} to {clockText(c.end)} ({lengthText(c.end - c.start)}){c.limited ? ', hit a usage limit' : ''}{c.halted ? ', halted' : ''}</title>
          </rect>
          {#if c.limited}<rect class="limited" x={x(c.start)} y={y + 10} width={Math.max(3, x(c.end) - x(c.start))} height={ROW - 20} rx="3" />{/if}
        {/each}

        {#if row.running}
          <rect class="running" x={x(row.running.start)} y={y + 10} width={Math.max(4, x(now) - x(row.running.start))} height={ROW - 20} rx="3">
            <title>{row.name}: a cycle is running since {clockText(row.running.start)}</title>
          </rect>
        {/if}

        {#each row.log as l (l.at + l.slot)}
          {#if l.what !== 'started'}
            <text class="skip" x={x(l.at) - 4} y={y + ROW - 6}>×<title>{clockText(l.at)}: {l.what}</title></text>
          {/if}
        {/each}

        {#each row.planned as bar (bar.at + bar.id)}
          {#if bar.at >= now || row.draft}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <g
              class="slot"
              class:editable={row.editable}
              class:sel={selected && selected.project === row.id && selected.slot === bar.slot}
              class:overlap={bar.flags.includes('overlap')}
              class:inquiet={bar.flags.includes('quiet')}
              transform="translate({shift(row, bar)} 0)"
              role="button"
              tabindex={row.editable ? 0 : -1}
              aria-label="{row.name}, slot at {clockText(bar.at)}"
              onpointerdown={(e) => grab(e, row, bar)}
              onpointermove={pull}
              onpointerup={drop}
              onpointercancel={() => (drag = null)}
              onkeydown={(e) => key(e, row, bar)}
            >
              <rect x={x(bar.at)} y={y + 8} width={Math.max(6, x(bar.end) - x(bar.at))} height={ROW - 16} rx="4" />
              <line class="start" x1={x(bar.at)} x2={x(bar.at)} y1={y + 5} y2={y + ROW - 5} />
              <title>{row.name}: starts {clockText(bar.at)}, typical length {lengthText(bar.end - bar.at)}{bar.flags.includes('overlap') ? '. Likely overlaps another team' : ''}{bar.flags.includes('quiet') ? '. In your quiet hours' : ''}{row.editable ? '. Drag to move, click to edit' : ''}</title>
            </g>
          {/if}
        {/each}
      </g>
    {/each}

    {#if now >= range.from && now < range.to}
      <line class="now" x1={x(now)} x2={x(now)} y1={HEAD - 4} y2={height - 6} />
      <text class="nowtext" x={x(now) + 4} y={HEAD + 10}>now</text>
    {/if}
  </svg>
</div>

<style>
  .wrap {
    width: 100%;
    overflow: hidden;
  }
  svg {
    display: block;
    touch-action: pan-y;
    user-select: none;
  }
  .grid {
    stroke: var(--grid);
    stroke-width: 1;
    opacity: 0.6;
  }
  .grid.major {
    stroke: var(--axis);
    opacity: 0.9;
  }
  .rule {
    stroke: var(--line);
    opacity: 0.5;
  }
  .tick,
  .sub,
  .nowtext {
    fill: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .day {
    fill: var(--ink-2);
    font-size: 12px;
  }
  .name {
    fill: var(--ink);
    font-size: 13px;
    font-weight: 600;
  }
  .quiet {
    fill: var(--warn);
    opacity: 0.07;
  }
  .lane {
    fill: transparent;
  }
  .lane.editable {
    cursor: copy;
  }
  .past {
    fill: var(--row);
    opacity: 0.85;
  }
  .limited {
    fill: url(#tl-limit);
    pointer-events: none;
  }
  .running {
    fill: var(--row);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }
  .skip {
    fill: var(--muted);
    font-size: 12px;
    cursor: default;
  }
  .slot rect {
    fill: var(--row);
    fill-opacity: 0.16;
    stroke: var(--row);
    stroke-width: 1.2;
    stroke-dasharray: 5 3;
  }
  .slot .start {
    stroke: var(--row);
    stroke-width: 3;
  }
  .slot.editable {
    cursor: grab;
  }
  .slot.editable:active {
    cursor: grabbing;
  }
  .slot.overlap rect {
    stroke: var(--warn);
    stroke-width: 1.8;
  }
  .slot.inquiet .start {
    stroke: var(--warn);
  }
  .slot.sel rect {
    fill-opacity: 0.38;
    stroke-dasharray: none;
    stroke-width: 2;
  }
  .slot:focus-visible {
    outline: none;
  }
  .slot:focus-visible rect {
    stroke: var(--ink-strong);
    stroke-width: 2;
  }
  .now {
    stroke: var(--ink-strong);
    stroke-width: 1.2;
    opacity: 0.8;
  }
</style>
