<script>
  // One row per project, time across, for any stretch of time. Past cycles are
  // solid, the running one grows to "now", planned start times are dashed (their
  // end is a guess).
  //   drag a start time        move it to another time of day
  //   click an empty place     add a start time there
  //   drag across empty space  zoom in to that stretch
  //   scroll sideways          move through time (also Shift + wheel)
  import { wallClock, timeOfDay, hourLabel, clockLabel, DAYS } from '$lib/schedule.js';

  let {
    rows = [], // [{id, name, accent, tz, editable, draft, note, past, running, planned, log}]
    range, // {from, to, days}
    tz, // the time zone the axis is drawn in
    clock = '24',
    quiet = [], // [{from, to}]
    now = Date.now(),
    selected = null, // {project, slot}
    onmove = () => {}, // (project, slot index, 'HH:MM')
    onadd = () => {}, // (project, 'HH:MM', day name)
    onselect = () => {}, // (project, slot index)
    onzoom = () => {}, // (from, to)
    onpan = () => {} // (milliseconds, positive is later)
  } = $props();

  const LABEL = 150;
  const HEAD = 40;
  const ROW = 46;
  const PAD = 10;
  const HOUR = 3_600_000;
  let width = $state(1100);
  const track = $derived(Math.max(300, width - LABEL - PAD));
  const height = $derived(HEAD + rows.length * ROW + 8);
  const span = $derived(range.to - range.from);
  const inside = (t) => t >= range.from && t < range.to;
  const x = (t) => LABEL + ((Math.min(Math.max(t, range.from), range.to) - range.from) / span) * track;
  const two = (n) => String(n).padStart(2, '0');

  // How dense the hour lines are depends on how much time is shown.
  const density = $derived(span <= 8 * HOUR ? { line: 1, label: 1 } : span <= 36 * HOUR ? { line: 1, label: 2 } : span <= 4 * 24 * HOUR ? { line: 3, label: 6 } : span <= 10 * 24 * HOUR ? { line: 6, label: 12 } : { line: 24, label: 0 });
  const ticks = $derived.by(() => {
    const out = [];
    for (const day of range.days) {
      for (let t = day.from; t < day.to; t += HOUR) {
        if (!inside(t)) continue;
        const H = wallClock(tz, t).H;
        const major = t === day.from;
        if (!major && H % density.line !== 0) continue;
        const labelled = density.label && H % density.label === 0 && (density.label < 12 ? true : H === 12);
        out.push({ t, major, label: labelled ? hourLabel(H, clock) : '' });
      }
    }
    return out;
  });
  // A day's name sits at its start, or at the left edge for a day that began before the window.
  const dayMarks = $derived(range.days.filter((d) => d.to > range.from && d.from < range.to).map((d) => ({ ...d, at: Math.max(d.from, range.from) })));
  const dayLabel = (day) => `${day.name[0].toUpperCase()}${day.name.slice(1)} ${Number(day.date.slice(8))}`;
  const clockText = (t) => {
    const c = wallClock(tz, t);
    return clockLabel(`${two(c.H)}:${two(c.M)}`, clock);
  };
  const lengthText = (ms) => {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} h ${two(m % 60)} min` : `${m} min`;
  };
  const visible = (a, b) => b > range.from && a < range.to;

  // ---- moving a start time ----
  let drag = $state(null); // {project, slot, at, startX, dx, moved, tz}
  function grab(e, row, bar) {
    if (!row.editable) return;
    e.stopPropagation();
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
  function key(e, row, bar) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onselect(row.id, bar.slot);
    }
  }

  // ---- empty space: a click adds, a drag zooms ----
  let svg = $state();
  let pick = $state(null); // {x0, x1, row}
  const timeAt = (clientX) => {
    const left = svg.getBoundingClientRect().left + LABEL;
    return range.from + (Math.min(Math.max(clientX - left, 0), track) / track) * span;
  };
  function press(e, row) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pick = { x0: e.clientX, x1: e.clientX, row };
  }
  function sweep(e) {
    if (pick) pick.x1 = e.clientX;
  }
  function release() {
    if (!pick) return;
    const p = pick;
    pick = null;
    if (Math.abs(p.x1 - p.x0) < 6) {
      if (!p.row?.editable) return;
      const t = timeAt(p.x0);
      const c = wallClock(p.row.tz, t);
      onadd(p.row.id, timeOfDay(p.row.tz, t), DAYS[(new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay() + 6) % 7]);
      return;
    }
    const a = timeAt(Math.min(p.x0, p.x1));
    const b = timeAt(Math.max(p.x0, p.x1));
    onzoom(a, b);
  }
  const pickBox = $derived.by(() => {
    if (!pick || Math.abs(pick.x1 - pick.x0) < 6) return null;
    const left = svg.getBoundingClientRect().left;
    const a = Math.min(Math.max(Math.min(pick.x0, pick.x1) - left, LABEL), LABEL + track);
    const b = Math.min(Math.max(Math.max(pick.x0, pick.x1) - left, LABEL), LABEL + track);
    return { x: a, w: b - a, from: timeAt(Math.min(pick.x0, pick.x1)), to: timeAt(Math.max(pick.x0, pick.x1)) };
  });

  // ---- sideways scrolling moves through time ----
  function wheel(node) {
    const on = (e) => {
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!sideways && !e.shiftKey) return;
      e.preventDefault();
      const px = sideways ? e.deltaX : e.deltaY;
      onpan((px / track) * span);
    };
    node.addEventListener('wheel', on, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', on) };
  }
</script>

<div class="wrap" bind:clientWidth={width}>
  <svg bind:this={svg} {width} {height} role="group" aria-label="Cycle timeline" use:wheel>
    <defs>
      <pattern id="tl-limit" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="3" height="6" fill="var(--critical)" opacity="0.55" />
      </pattern>
      <clipPath id="tl-track"><rect x={LABEL} y="0" width={track} {height} /></clipPath>
    </defs>

    <!-- the header strip also takes a drag to zoom -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect class="lane zoomable" x={LABEL} y="0" width={track} height={HEAD} onpointerdown={(e) => press(e, null)} onpointermove={sweep} onpointerup={release} onpointercancel={() => (pick = null)}>
      <title>Drag to zoom in to a stretch of time</title>
    </rect>

    {#each quiet as q (q.from)}
      {#if visible(q.from, q.to)}
        <rect class="quiet" x={x(q.from)} y={HEAD} width={Math.max(0, x(q.to) - x(q.from))} height={rows.length * ROW}><title>Your quiet hours</title></rect>
      {/if}
    {/each}

    {#each ticks as t (t.t)}
      <line class={t.major ? 'grid major' : 'grid'} x1={x(t.t)} x2={x(t.t)} y1={t.major ? 4 : HEAD} y2={height - 6} />
      {#if t.label}<text class="tick" x={x(t.t) + 3} y={HEAD - 6}>{t.label}</text>{/if}
    {/each}
    {#each dayMarks as day (day.date)}
      <text class="day" x={x(day.at) + 6} y={15}>{dayLabel(day)}</text>
    {/each}

    {#each rows as row, i (row.id)}
      {@const y = HEAD + i * ROW}
      <g style="--row: {row.accent}">
        <line class="rule" x1={0} x2={width} y1={y + ROW} y2={y + ROW} />
        <text class="name" x={8} y={y + 20}>{row.name}</text>
        <text class="sub" x={8} y={y + 36}>{row.note}</text>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <rect class="lane zoomable" class:editable={row.editable} x={LABEL} y={y + 2} width={track} height={ROW - 4} onpointerdown={(e) => press(e, row)} onpointermove={sweep} onpointerup={release} onpointercancel={() => (pick = null)}>
          <title>{row.editable ? 'Click to add a start time here. Drag to zoom in.' : 'Drag to zoom in.'}</title>
        </rect>

        <g clip-path="url(#tl-track)">
          {#each row.past as c (c.start)}
            {#if visible(c.start, c.end)}
              <rect class="past" x={x(c.start)} y={y + 10} width={Math.max(3, x(c.end) - x(c.start))} height={ROW - 20} rx="3">
                <title>{row.name}: ran {clockText(c.start)} to {clockText(c.end)} ({lengthText(c.end - c.start)}){c.limited ? ', hit a usage limit' : ''}{c.halted ? ', halted' : ''}</title>
              </rect>
              {#if c.limited}<rect class="limited" x={x(c.start)} y={y + 10} width={Math.max(3, x(c.end) - x(c.start))} height={ROW - 20} rx="3" />{/if}
            {/if}
          {/each}

          {#if row.running && visible(row.running.start, now)}
            <rect class="running" x={x(row.running.start)} y={y + 10} width={Math.max(4, x(now) - x(row.running.start))} height={ROW - 20} rx="3">
              <title>{row.name}: a cycle is running since {clockText(row.running.start)}</title>
            </rect>
          {/if}

          {#each row.log as l (l.at + l.slot)}
            {#if l.what !== 'started' && inside(l.at)}
              <text class="skip" x={x(l.at) - 4} y={y + ROW - 6}>×<title>{clockText(l.at)}: {l.what}</title></text>
            {/if}
          {/each}

          {#each row.planned as bar (bar.at + bar.id)}
            {#if (bar.at >= now || row.draft) && visible(bar.at, bar.end)}
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
                aria-label="{row.name}, starts at {clockText(bar.at)}"
                onpointerdown={(e) => grab(e, row, bar)}
                onpointermove={pull}
                onpointerup={drop}
                onpointercancel={() => (drag = null)}
                onkeydown={(e) => key(e, row, bar)}
              >
                <rect x={x(bar.at)} y={y + 8} width={Math.max(6, x(bar.end) - x(bar.at))} height={ROW - 16} rx="4" />
                {#if inside(bar.at)}<line class="start" x1={x(bar.at)} x2={x(bar.at)} y1={y + 5} y2={y + ROW - 5} />{/if}
                <title>{row.name}: starts {clockText(bar.at)}, typical length {lengthText(bar.end - bar.at)}{bar.flags.includes('overlap') ? '. Likely overlaps another team' : ''}{bar.flags.includes('quiet') ? '. In your quiet hours' : ''}{row.editable ? '. Drag to move, click to change' : ''}</title>
              </g>
            {/if}
          {/each}
        </g>
      </g>
    {/each}

    {#if inside(now)}
      <line class="now" x1={x(now)} x2={x(now)} y1={HEAD - 4} y2={height - 6} />
      <text class="nowtext" x={x(now) + 4} y={HEAD + 10}>now</text>
    {/if}

    {#if pickBox}
      <rect class="pick" x={pickBox.x} y="2" width={pickBox.w} height={height - 8} rx="3" />
      <text class="picktext" x={pickBox.x + 4} y={height - 10}>{clockText(pickBox.from)} to {clockText(pickBox.to)}</text>
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
    pointer-events: none;
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
  .nowtext,
  .picktext {
    fill: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
    pointer-events: none;
  }
  .picktext {
    fill: var(--ink);
  }
  .day {
    fill: var(--ink-2);
    font-size: 12px;
    pointer-events: none;
  }
  .name {
    fill: var(--ink);
    font-size: 13px;
    font-weight: 600;
  }
  .quiet {
    fill: var(--warn);
    opacity: 0.07;
    pointer-events: none;
  }
  .lane {
    fill: transparent;
  }
  .lane.zoomable {
    cursor: zoom-in;
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
    pointer-events: none;
  }
  .pick {
    fill: rgba(var(--glow), 0.14);
    stroke: var(--line-strong);
    pointer-events: none;
  }
</style>
