<script>
  // One row per project, time across, for any stretch of time. Past cycles are
  // solid, the running one grows to "now", planned start times are dashed (their
  // end is a guess).
  //   drag a start time        move it to another time of day
  //   click an empty place     add a start time there
  //   drag across empty space  zoom in to that stretch
  //   scroll sideways          move through time (also Shift + wheel)
  // Backlog jobs (row.jobs) are drawn with their estimate; hover shows what
  // they are, a click calls onjob. A job that waits for its time can be dragged
  // along its row (or moved with the arrow keys, then Enter): onjobmove. With `ghost` set, the pointer carries a bar
  // of that length along its row and a click calls onpick with the start; the
  // parent passes the picked start back as ghost.at, which stays drawn and can
  // be dragged, or picked again with another click.
  import { wallClock, timeOfDay, hourLabel, clockLabel, draggedStart, waitText, DAYS, focusSpan } from '$lib/schedule.js';
  import { stallText } from '$lib/format.js';

  let {
    rows = [], // [{id, name, accent, tz, editable, draft, note, past, running, planned, skipped, log, expected}]
    // planned: [{at, end, slot, id, flags, fresh}]; fresh = brought by a change that is not applied yet
    // expected: {job id: ms}, where a waiting job is likely to start when that is later than set
    range, // {from, to, days}
    tz, // the time zone the axis is drawn in
    clock = '24',
    quiet = [], // [{from, to}]
    now = Date.now(),
    selected = null, // {project, slot}
    onmove = () => {}, // (project, slot index, 'HH:MM', the bar that was dragged)
    onadd = () => {}, // (project, 'HH:MM', day name, the moment clicked in ms)
    onselect = () => {}, // (project, slot index, the bar that was picked)
    onzoom = () => {}, // (from, to)
    onpan = () => {}, // (milliseconds, positive is later)
    onjob = null, // (project, job): a backlog job was clicked
    onjobmove = null, // (project, job, start in ms): a job set for a time was dragged there
    ghost = null, // {project, minutes, at}: place a job of this length; `at` is the start picked so far
    onpick = () => {} // (project, start in ms)
  } = $props();
  // Ids inside the SVG must be unique on the page: there can be two timelines.
  const uid = $props.id();
  const SNAP = 15 * 60000;

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
    drag = { project: row.id, slot: bar.slot, at: bar.at, startX: e.clientX, dx: 0, moved: false, tz: row.tz, bar };
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
    if (!d.moved) return onselect(d.project, d.slot, d.bar);
    onmove(d.project, d.slot, timeOfDay(d.tz, d.at + (d.dx / track) * span), d.bar);
  }
  // Only the dragged bar moves: one day of a slot can be changed on its own.
  const shift = (row, bar) => (drag && drag.project === row.id && drag.slot === bar.slot && drag.at === bar.at ? drag.dx : 0);
  function key(e, row, bar) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onselect(row.id, bar.slot, bar);
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
      if (ghost) {
        if (p.row?.id === ghost.project) {
          const t = Math.round(timeAt(p.x0) / SNAP) * SNAP;
          if (t >= now + 60000) onpick(p.row.id, t);
        }
        return;
      }
      if (!p.row?.editable) return;
      const t = timeAt(p.x0);
      const c = wallClock(p.row.tz, t);
      onadd(p.row.id, timeOfDay(p.row.tz, t), DAYS[(new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay() + 6) % 7], t);
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

  // ---- placing a job (ghost mode) ----
  let hoverT = $state(null); // snapped start under the pointer, in the ghost's row
  function hover(e, row) {
    if (!ghost || row?.id !== ghost.project || pick) return;
    hoverT = Math.round(timeAt(e.clientX) / SNAP) * SNAP;
  }
  const ghostOk = $derived(hoverT != null && hoverT >= now + 60000);
  // Dragging the picked bar: where it would start now.
  let placeDrag = $state(null); // {startX, at, t}
  const snapAt = (clientX) => Math.round(timeAt(clientX) / SNAP) * SNAP;
  function grabPlaced(e) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    placeDrag = { startX: e.clientX, at: ghost.at, t: ghost.at };
  }
  function pullPlaced(e) {
    if (!placeDrag) return;
    placeDrag.t = Math.round((placeDrag.at + ((e.clientX - placeDrag.startX) / track) * span) / SNAP) * SNAP;
  }
  function dropPlaced() {
    if (!placeDrag) return;
    const t = placeDrag.t;
    placeDrag = null;
    if (t >= now + 60000) onpick(ghost.project, t);
  }
  const placedAt = $derived(placeDrag ? placeDrag.t : ghost?.at ?? null);
  // Entering placing mode: the hover card of a job would hide the row.
  $effect(() => {
    if (ghost) tip = null;
  });

  // ---- backlog jobs: hover card and click ----
  let tip = $state(null); // {row, job, left, top}
  let wrapEl = $state();
  function showTip(e, row, job) {
    const r = wrapEl.getBoundingClientRect();
    tip = { row, job, left: Math.max(0, Math.min(e.clientX - r.left + 12, r.width - 280)), top: e.clientY - r.top + 14 };
  }
  const JOB_STATE = { set: 'set for', running: 'running since', done: 'ran', missed: 'missed, was set for' };

  // ---- moving a job that is set for a time ----
  // Only a job that still waits for its time moves; one that runs, ran or was missed stays.
  const movable = (job) => !!onjobmove && !ghost && job.state === 'set';
  let jobDrag = $state(null); // {project, id, start, startX, t, ok, moved, keys}
  let dragged = false; // the click that ends a drag is not a click on the job
  const dragOf = (row, job) => (jobDrag && jobDrag.project === row.id && jobDrag.id === job.id && (jobDrag.moved || jobDrag.keys) ? jobDrag : null);
  function grabJob(e, row, job) {
    e.stopPropagation();
    if (e.button !== 0 || !movable(job)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    jobDrag = { project: row.id, id: job.id, start: job.start, startX: e.clientX, t: job.start, ok: false, moved: false, keys: false };
  }
  function pullJob(e, row, job) {
    if (!jobDrag || jobDrag.keys) return showTip(e, row, job);
    const dx = e.clientX - jobDrag.startX;
    if (Math.abs(dx) > 4) jobDrag.moved = true;
    if (!jobDrag.moved) return;
    tip = null;
    Object.assign(jobDrag, draggedStart(jobDrag.start, (dx / track) * span, now, SNAP));
  }
  function dropJob(row, job) {
    const d = jobDrag;
    if (!d || d.keys) return;
    jobDrag = null;
    if (!d.moved) return; // a press without movement: the click opens the job
    dragged = true;
    setTimeout(() => (dragged = false), 0);
    if (d.ok) onjobmove(row.id, job, d.t);
  }
  function clickJob(row, job) {
    if (dragged) return;
    onjob?.(row.id, job);
  }
  function jobKey(e, row, job) {
    const step = e.key === 'ArrowLeft' ? -SNAP : e.key === 'ArrowRight' ? SNAP : 0;
    if (step && movable(job)) {
      e.preventDefault();
      const from = dragOf(row, job)?.t ?? job.start;
      jobDrag = { project: row.id, id: job.id, start: job.start, startX: 0, moved: false, keys: true, ...draggedStart(from, step, now, SNAP) };
      tip = null;
      return;
    }
    const pending = dragOf(row, job);
    if (e.key === 'Escape' && pending) {
      e.preventDefault();
      jobDrag = null;
      return;
    }
    if (e.key === 'Enter' && pending?.keys) {
      e.preventDefault();
      jobDrag = null;
      if (pending.ok) onjobmove(row.id, job, pending.t);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && onjob) {
      e.preventDefault();
      onjob(row.id, job);
    }
  }

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

<div class="wrap" bind:clientWidth={width} bind:this={wrapEl}>
  <svg bind:this={svg} {width} {height} role="group" aria-label="Cycle timeline" use:wheel class:placing={!!ghost}>
    <defs>
      <pattern id="{uid}-limit" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="3" height="6" fill="var(--critical)" opacity="0.55" />
      </pattern>
      <pattern id="{uid}-paused" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="2" height="8" fill="var(--ink-2)" opacity="0.35" />
      </pattern>
      <linearGradient id="{uid}-fade" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0.85" stop-color="white" stop-opacity="1" />
        <stop offset="1" stop-color="white" stop-opacity="0" />
      </linearGradient>
      <mask id="{uid}-fademask" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#{uid}-fade)" /></mask>
      <pattern id="{uid}-job" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <rect width="7" height="7" fill="var(--accent)" opacity="0.32" />
        <rect width="3" height="7" fill="var(--accent)" opacity="0.75" />
      </pattern>
      <clipPath id="{uid}-track"><rect x={LABEL} y="0" width={track} {height} /></clipPath>
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
        <rect
          class="lane zoomable"
          class:editable={row.editable && !ghost}
          class:placing={ghost?.project === row.id}
          x={LABEL}
          y={y + 2}
          width={track}
          height={ROW - 4}
          onpointerdown={(e) => press(e, row)}
          onpointermove={(e) => (sweep(e), hover(e, row))}
          onpointerleave={() => (hoverT = null)}
          onpointerup={release}
          onpointercancel={() => (pick = null)}
        >
          <title>{ghost?.project === row.id ? 'Click to start the job here' : row.editable && !ghost ? 'Click to add a start time here. Drag to zoom in.' : 'Drag to zoom in.'}</title>
        </rect>

        <g clip-path="url(#{uid}-track)">
          <!-- focus mode (#93): the stretch it covers, behind everything else on the row -->
          {#if row.focusSpan && visible(row.focusSpan.from, row.focusSpan.to)}
            {@const f = row.focusSpan}
            <!-- the label starts after the "now" line when it crosses the band, so the line does not cut the words -->
            {@const lx = Math.max(x(f.from), LABEL, now > f.from && now < f.to ? x(now) : 0)}
            <g class="band {f.kind}" class:about={f.end === 'about'} mask={f.end === 'open' ? `url(#${uid}-fademask)` : null}>
              <rect class="fill" x={x(f.from)} y={y + 2} width={Math.max(4, x(f.to) - x(f.from))} height={ROW - 2} rx="5" fill={f.kind === 'paused' ? `url(#${uid}-paused)` : null} />
              <!-- the label sits in a strip under the bars, where nothing is drawn over it; too narrow for words: the tooltip says it -->
              {#if x(f.to) - lx >= 110}<text class="bandlabel" x={lx + 6} y={y + ROW - 1.5}>
                {f.kind === 'paused' ? `Paused for ${f.for}'s focus` : f.end === 'set' ? `Focus until ${clockText(f.to)}` : f.end === 'about' ? `Focus · ${f.done} of ${f.cycles} cycles · ends about ${clockText(f.to)}` : 'Focus · until switched off'}
              </text>{/if}
              <title>{f.kind === 'paused' ? `${row.name} is paused while ${f.for} is in focus, until ${clockText(f.to)} at the latest. Its start times are skipped; planned jobs and one-time cycles still run.` : `${row.name} in focus from ${clockText(f.from)}${f.end === 'set' ? ` to ${clockText(f.to)}` : f.end === 'about' ? `, about to ${clockText(f.to)}` : ', until switched off'}: cycles back to back, at most ${f.perDay} a day. Planned jobs run first, in order, right away.`}</title>
            </g>
          {/if}
          {#each row.past as c (c.start)}
            {#if visible(c.start, c.end)}
              <rect class="past" x={x(c.start)} y={y + 10} width={Math.max(3, x(c.end) - x(c.start))} height={ROW - 20} rx="3">
                <title>{row.name}: ran {clockText(c.start)} to {clockText(c.end)} ({lengthText(c.end - c.start)}){c.limited ? ', hit a usage limit' : ''}{c.halted ? ', halted' : ''}</title>
              </rect>
              {#if c.limited}<rect class="limited" fill="url(#{uid}-limit)" x={x(c.start)} y={y + 10} width={Math.max(3, x(c.end) - x(c.start))} height={ROW - 20} rx="3" />{/if}
            {/if}
          {/each}

          {#if row.running && visible(row.running.start, now)}
            <rect class="running" class:stalled={!!row.stalled} x={x(row.running.start)} y={y + 10} width={Math.max(4, x(now) - x(row.running.start))} height={ROW - 20} rx="3">
              <title>{row.name}: a cycle is running since {clockText(row.running.start)}{row.stalled ? `. ${stallText(row.stalled, now)}` : ''}</title>
            </rect>
            {#if row.stalled?.reason === 'usage-limit'}<rect class="limited" fill="url(#{uid}-limit)" x={x(row.running.start)} y={y + 10} width={Math.max(4, x(now) - x(row.running.start))} height={ROW - 20} rx="3" />{/if}
          {/if}

          {#each row.log as l (l.at + l.slot)}
            {#if l.what !== 'started' && inside(l.at)}
              <text class="skip" x={x(l.at) - 4} y={y + ROW - 6}>×<title>{clockText(l.at)}: {l.what}</title></text>
            {/if}
          {/each}

          {#each row.planned as bar (bar.at + bar.id)}
            <!-- A start that has passed is not drawn, unless the owner has just placed or moved it there
                 (bar.fresh): then it is drawn faint, since it will not run today. -->
            {#if (bar.at >= now || bar.fresh) && visible(bar.at, bar.end)}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <g
                class="slot"
                class:editable={row.editable}
                class:sel={selected && selected.project === row.id && selected.slot === bar.slot}
                class:passed={bar.at < now}
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
                <title>{row.name}: starts {clockText(bar.at)}, typical length {lengthText(bar.end - bar.at)}{bar.flags.includes('overlap') ? '. Likely overlaps another team' : ''}{bar.flags.includes('quiet') ? '. In your quiet hours' : ''}{bar.at < now ? '. This time has already passed today: it does not run' : ''}{row.editable ? '. Drag to move, click to change' : ''}</title>
              </g>
            {/if}
          {/each}

          <!-- a start that is skipped for that one day: shown, struck through -->
          {#each row.skipped || [] as bar (bar.at + bar.id)}
            {#if visible(bar.at, bar.end)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <g class="skipped" onpointerdown={(e) => e.stopPropagation()}>
                <rect x={x(bar.at)} y={y + 8} width={Math.max(6, x(bar.end) - x(bar.at))} height={ROW - 16} rx="4" />
                <line x1={x(bar.at)} x2={Math.max(x(bar.at) + 6, x(bar.end))} y1={y + ROW - 8} y2={y + 8} />
                <title>{row.name}: the {clockText(bar.at)} start is skipped on this day only</title>
              </g>
            {/if}
          {/each}

          {#each row.jobs || [] as job (job.id)}
            {@const end = job.state === 'done' ? job.end : job.state === 'running' ? Math.max(now, job.start) : job.start}
            {@const mv = dragOf(row, job)}
            {@const late = job.state === 'set' && !mv ? row.expected?.[job.id] ?? null : null}
            {#if late && visible(late, late + job.minutes * 60000)}
              <!-- where it is likely to start: the team is busy, or it waits for the job it builds on -->
              <g class="expect">
                <rect x={x(late)} y={y + 6} width={Math.max(6, x(late + job.minutes * 60000) - x(late))} height={ROW - 12} rx="4" />
                <text x={x(late) + 4} y={y + ROW - 8}>~{clockText(late)}</text>
              </g>
            {/if}
            {#if visible(job.start, Math.max(job.estEnd, end, late ?? 0)) || mv}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <g
                class="job {job.state}"
                class:plan={job.kind === 'plan'}
                class:once={job.kind === 'once'}
                class:late={!!late || !!job.wait}
                class:stopped={!!job.stopped}
                class:clickable={!!onjob}
                class:movable={movable(job)}
                class:moving={!!mv}
                class:bad={!!mv && !mv.ok}
                transform="translate({mv ? x(mv.t) - x(job.start) : 0} 0)"
                role={onjob ? 'button' : 'img'}
                tabindex={onjob ? 0 : -1}
                aria-label="{job.kind === 'plan' ? 'Planning cycle' : job.kind === 'once' ? 'One-time cycle' : `Planned job ${job.order ?? ''} ${job.title}`}, {JOB_STATE[job.state]} {clockText(job.start)}{movable(job) ? '. Arrow keys move it, Enter confirms' : ''}"
                onpointerdown={(e) => grabJob(e, row, job)}
                onpointerenter={(e) => showTip(e, row, job)}
                onpointermove={(e) => pullJob(e, row, job)}
                onpointerup={() => dropJob(row, job)}
                onpointercancel={() => (jobDrag = null)}
                onpointerleave={() => (tip = null)}
                onblur={() => jobDrag?.keys && (jobDrag = null)}
                onclick={() => clickJob(row, job)}
                onkeydown={(e) => jobKey(e, row, job)}
              >
                <rect class="est" x={x(job.start)} y={y + 6} width={Math.max(6, x(job.estEnd) - x(job.start))} height={ROW - 12} rx="4" />
                {#if end > job.start}
                  <rect class="did" fill="url(#{uid}-job)" x={x(job.start)} y={y + 10} width={Math.max(3, x(end) - x(job.start))} height={ROW - 20} rx="3" />
                {/if}
                {#if end > job.estEnd && job.state !== 'set'}
                  <!-- past its estimate: the part beyond it, in the warning colour -->
                  <rect class="over" x={x(job.estEnd)} y={y + 10} width={Math.max(3, x(end) - x(job.estEnd))} height={ROW - 20} rx="3" />
                {/if}
                {#if inside(job.start)}
                  <line class="start" x1={x(job.start)} x2={x(job.start)} y1={y + 3} y2={y + ROW - 3} />
                  <text class="mark" x={x(job.start) + 5} y={y + 19}>◆{job.order != null ? ` ${job.order}` : ''}</text>
                {/if}
                {#if mv}
                  <!-- where it would start and end (estimate), while it is dragged -->
                  <text class="moveto" x={x(job.start) + 4} y={y + ROW - 8}>{mv.t < now + 60000 ? 'not in the past' : `${clockText(mv.t)} to ${clockText(mv.t + job.minutes * 60000)}`}</text>
                {/if}
              </g>
            {/if}
          {/each}

          {#if ghost && ghost.project === row.id && placedAt != null}
            {@const ok = placedAt >= now + 60000}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g class="ghost placed" class:bad={!ok} class:moving={!!placeDrag} onpointerdown={grabPlaced} onpointermove={pullPlaced} onpointerup={dropPlaced} onpointercancel={() => (placeDrag = null)}>
              <rect x={x(placedAt)} y={y + 6} width={Math.max(6, x(placedAt + ghost.minutes * 60000) - x(placedAt))} height={ROW - 12} rx="4">
                <title>Drag to move, or click elsewhere in the row</title>
              </rect>
              <line x1={x(placedAt)} x2={x(placedAt)} y1={y + 3} y2={y + ROW - 3} />
              <text x={x(placedAt) + 4} y={y + ROW - 8}>{ok ? clockText(placedAt) : 'not in the past'}</text>
            </g>
          {/if}
          {#if ghost && ghost.project === row.id && hoverT != null && !placeDrag && hoverT !== ghost.at}
            <g class="ghost hover" class:bad={!ghostOk}>
              <rect x={x(hoverT)} y={y + 6} width={Math.max(6, x(hoverT + ghost.minutes * 60000) - x(hoverT))} height={ROW - 12} rx="4" />
              <line x1={x(hoverT)} x2={x(hoverT)} y1={y + 3} y2={y + ROW - 3} />
              <text x={x(hoverT) + 4} y={y + ROW - 8}>{ghostOk ? clockText(hoverT) : 'not in the past'}</text>
            </g>
          {/if}
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
  {#if tip}
    <div class="tip panel lit" style="left: {tip.left}px; top: {tip.top}px" role="tooltip">
      <div class="tt">
        {#if tip.job.kind === 'plan'}Planning cycle{:else if tip.job.kind === 'once'}One-time cycle{tip.job.pastCap ? ', even past the daily cap' : ''}{:else}{tip.job.order != null ? `#${tip.job.order} · ` : ''}{tip.job.title}{/if}
      </div>
      <div class="small dim">
        {tip.row.name} · {JOB_STATE[tip.job.state]} {clockText(tip.job.start)}{tip.job.state === 'done' ? ` to ${clockText(tip.job.end)}` : ''}{tip.job.state === 'running' && tip.row.stalled ? ` · ${stallText(tip.row.stalled, now)}` : ''}
      </div>
      <div class="small">
        est {lengthText(tip.job.estEnd - tip.job.start)}{tip.job.cost != null ? ` · $${tip.job.cost.toFixed(2)}` : ''}{tip.job.state === 'done' ? ` · took ${lengthText(tip.job.end - tip.job.start)}` : ''}
      </div>
      {#if tip.job.state === 'running' && now > tip.job.estEnd}
        <div class="small warnline">{lengthText(now - tip.job.estEnd)} past its estimate{tip.job.noBrake ? ' (no time limit)' : ''}</div>
      {/if}
      {#if tip.job.stopped}<div class="small warnline">stopped: it ran to twice its estimate</div>{/if}
      {#if tip.job.state === 'set' && tip.row.expected?.[tip.job.id]}
        <div class="small warnline">expected about {clockText(tip.row.expected[tip.job.id])} instead of {clockText(tip.job.start)}</div>
      {/if}
      {#if tip.job.wait}<div class="small warnline">{waitText(tip.job.wait)}</div>{/if}
      {#if tip.job.state === 'set' && tip.row.focusSpan?.kind === 'focus' && tip.job.start <= tip.row.focusSpan.to && tip.job.start > now}
        <div class="small">runs earlier: the team is in focus, and planned jobs go first</div>
      {/if}
      {#if onjob}<div class="small dim">Click for details{movable(tip.job) ? '. Drag to move it' : ''}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
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
    pointer-events: none;
  }
  /* Backlog jobs: the estimate dashed in the accent colour, what ran hatched. */
  .job .est {
    fill: rgba(var(--glow), 0.08);
    stroke: var(--accent);
    stroke-width: 1.4;
    stroke-dasharray: 3 3;
  }
  .job.missed .est {
    stroke: var(--critical);
    fill: rgba(248, 113, 113, 0.08);
  }
  .job.done .est {
    stroke-opacity: 0.6;
  }
  .job .over {
    fill: var(--warn);
    fill-opacity: 0.55;
    pointer-events: none;
  }
  .job.running .over {
    animation: pulse 1.6s ease-in-out infinite;
  }
  .job.late .est {
    stroke: var(--warn);
  }
  .job.stopped .est {
    stroke: var(--critical);
    stroke-opacity: 1;
  }
  .expect {
    pointer-events: none;
  }
  .expect rect {
    fill: none;
    stroke: var(--warn);
    stroke-width: 1.2;
    stroke-dasharray: 2 4;
  }
  .expect text {
    fill: var(--warn);
    font-size: 11px;
    font-family: var(--mono, monospace);
  }
  .warnline {
    color: var(--warn);
  }
  .job.running .did {
    animation: pulse 1.6s ease-in-out infinite;
  }
  .job .start {
    stroke: var(--accent);
    stroke-width: 3;
  }
  .job .mark {
    fill: var(--ink-strong);
    font-size: 10px;
    font-weight: 700;
    pointer-events: none;
  }
  .job.plan .est {
    stroke: var(--ink-2);
  }
  /* a one-time cycle (kit 0.26): a cycle at one time, drawn in the team's colour */
  .job.once .est {
    stroke: var(--row);
    stroke-dasharray: none;
  }
  .job.clickable {
    cursor: pointer;
  }
  .job.movable {
    cursor: grab;
  }
  .job.moving {
    cursor: grabbing;
  }
  .job.moving .est {
    stroke-width: 2.2;
    stroke-dasharray: none;
    fill-opacity: 0.3;
  }
  .job.moving.bad .est {
    stroke: var(--critical);
  }
  .job .moveto {
    fill: var(--ink-strong);
    font-size: 11px;
    font-family: var(--mono, monospace);
    pointer-events: none;
  }
  .job:focus-visible {
    outline: none;
  }
  .job:focus-visible .est,
  .job:hover .est {
    stroke-width: 2.2;
    stroke-dasharray: none;
  }
  .lane.placing {
    cursor: crosshair;
  }
  .ghost {
    pointer-events: none;
  }
  /* While a job is placed or moved, other bars let the pointer through to the
     row: a click on a planned start, a past cycle or a job picks the time. */
  svg.placing .past,
  svg.placing .running,
  svg.placing .slot,
  svg.placing .job,
  svg.placing .skip {
    pointer-events: none;
  }
  .ghost.hover rect {
    fill: rgba(var(--glow), 0.12);
    stroke-dasharray: 4 3;
  }
  .ghost.placed {
    pointer-events: all;
    cursor: grab;
  }
  .ghost.placed.moving {
    cursor: grabbing;
  }
  .ghost rect {
    fill: rgba(var(--glow), 0.3);
    stroke: var(--accent);
    stroke-width: 2;
  }
  .ghost line {
    stroke: var(--ink-strong);
    stroke-width: 2;
  }
  .ghost text {
    fill: var(--ink-strong);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .ghost.bad rect {
    fill: rgba(248, 113, 113, 0.18);
    stroke: var(--critical);
  }
  .tip {
    position: absolute;
    z-index: 20;
    width: 270px;
    padding: 8px 10px;
    pointer-events: none;
    background: var(--panel-solid);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tt {
    font-weight: 600;
    font-size: 13px;
  }
  .running {
    fill: var(--row);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .band {
    pointer-events: none;
  }
  .band .fill {
    fill: var(--row);
    fill-opacity: 0.12;
    stroke: var(--row);
    stroke-opacity: 0.55;
    stroke-width: 1;
  }
  .band.about .fill {
    stroke-dasharray: 5 4;
  }
  .band.paused .fill {
    fill-opacity: 1;
    stroke: var(--ink-2);
    stroke-opacity: 0.35;
  }
  .bandlabel {
    fill: var(--row);
    font-size: 8.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .band.paused .bandlabel {
    fill: var(--ink-2);
  }
  .running.stalled {
    fill: var(--warn);
    animation: none;
    opacity: 0.6;
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
  .skipped rect {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1;
    stroke-dasharray: 2 4;
  }
  .skipped line {
    stroke: var(--muted);
    stroke-width: 1.2;
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
  .slot.passed {
    opacity: 0.45;
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
