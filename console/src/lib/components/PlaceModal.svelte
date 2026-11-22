<script>
  // Place a backlog job (or a planning cycle) on the timeline: one day of
  // every team, the job's estimate follows the pointer in its own team's
  // row, a click picks the start, Set confirms. Other rows are there to see
  // what else runs then.
  import { onMount } from 'svelte';
  import Modal from '$lib/components/Modal.svelte';
  import Timeline from '$lib/components/Timeline.svelte';
  import ConflictChoice from '$lib/components/ConflictChoice.svelte';
  import { plan, quietIntervals, wallClock, clockLabel, zoneLabel, validTimeZone, conflictsAt, placeAfter, dateString, gapNote, expectedStarts } from '$lib/schedule.js';

  // builds: proposal ids this job builds on. canBrake: the VM's kit can limit a job's time (0.18).
  let { project, title, minutes, builds = [], canBrake = false, busy = false, onclose = () => {}, onset = () => {} } = $props();
  let noBrake = $state(false);

  let tl = $state(null);
  let error = $state('');
  let picked = $state(null); // ms
  let hit = $state(null); // what the picked time runs into, when Set found something
  async function load(date = null) {
    error = '';
    try {
      const r = await fetch(`/api/schedule?view=day${date ? `&date=${date}` : ''}`);
      if (!r.ok) throw new Error(`the timeline did not load (${r.status})`);
      tl = await r.json();
    } catch (e) {
      error = e.message;
    }
  }
  onMount(() => load());

  const settings = $derived(tl?.settings);
  const range = $derived(tl?.range);
  const rows = $derived.by(() => {
    if (!tl) return [];
    const planning = plan(
      tl.projects.map((p) => ({ id: p.id, name: p.name, schedule: p.schedule, typicalSecs: p.typicalSecs, cap: p.cap })),
      settings,
      range.from,
      range.to
    );
    // This team first: it is the row the job goes in.
    const ordered = [...tl.projects].sort((a, b) => (a.id === project ? -1 : b.id === project ? 1 : 0));
    return ordered.map((p) => ({
      id: p.id,
      name: p.name,
      accent: p.accent,
      tz: p.schedule?.tz && validTimeZone(p.schedule.tz) ? p.schedule.tz : settings.timezone,
      editable: false,
      draft: false,
      note: p.id === project ? 'click to place' : p.schedule ? `${p.schedule.slots.length} start times` : 'back to back',
      past: p.past,
      running: p.running,
      planned: planning.planned[p.id] || [],
      jobs: p.jobs || [],
      expected: expectedStarts(p.jobs || [], tl.now, p.running ? Math.max(p.running.start + (p.typicalSecs || 3600) * 1000, tl.now) : null),
      log: p.log
    }));
  });
  // The jobs of the items this one builds on, and a note when it is placed too close behind one.
  const afterIds = $derived((mine?.jobs || []).filter((j) => j.pid && builds.includes(j.pid)).map((j) => j.id));
  const note = $derived(picked && !hit ? gapNote(mine?.jobs, picked, minutes, { after: afterIds, now: tl.now }) : null);
  const quiet = $derived(tl ? quietIntervals(settings, range.from, range.to) : []);
  const mine = $derived(rows.find((r) => r.id === project) || null);
  const team = $derived(tl?.projects.find((x) => x.id === project) || null);
  const clockAt = (ms) => {
    const c = wallClock(settings.timezone, ms);
    return clockLabel(`${String(c.H).padStart(2, '0')}:${String(c.M).padStart(2, '0')}`, settings.clock);
  };
  // Set: first look at what the job would run into on its row.
  function set() {
    const found = conflictsAt(mine?.planned, mine?.jobs, picked, minutes, null, tl.now);
    if (found.length) return (hit = found);
    onset(Math.round(picked / 1000), null, { noBrake });
  }
  function after() {
    picked = placeAfter(mine?.planned, mine?.jobs, picked, minutes, null, tl.now);
    hit = null;
  }
  // Skip that one cycle: only when the job runs into one planned cycle and nothing else.
  const canSkip = $derived(!!hit && hit.length === 1 && hit[0].kind === 'cycle' && !!team?.schedule?.tz);
  function skip() {
    const c = hit[0];
    onset(Math.round(picked / 1000), { slot: c.slot, date: dateString(wallClock(team.schedule.tz, c.at)) }, { noBrake });
  }
  const two = (n) => String(n).padStart(2, '0');
  function when(ms) {
    const c = wallClock(settings.timezone, ms);
    const day = new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    return `${day}, ${clockLabel(`${two(c.H)}:${two(c.M)}`, settings.clock)}`;
  }
  const dayTitle = $derived(range ? new Date(`${range.date}T12:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }) : '');
</script>

<Modal title="Place on the timeline: {title}" wide {onclose}>
  {#if error}
    <p class="s-failed small">{error}</p>
  {:else if !tl}
    <p class="dim small">Loading the day…</p>
  {:else}
    <div class="actions">
      <b>{dayTitle}</b>
      <span class="small dim">Times in {zoneLabel(settings.timezone)}. The job's estimate is {minutes} min.</span>
      <span class="spacer"></span>
      <div class="seg">
        <button class="btn quiet sm icon" onclick={() => load(range.prev)} aria-label="The day before">‹</button>
        <button class="btn quiet sm" onclick={() => load(null)}>Today</button>
        <button class="btn quiet sm icon" onclick={() => load(range.next)} aria-label="The day after">›</button>
      </div>
    </div>
    <div class="panel tlbox">
      <Timeline {rows} {range} tz={settings.timezone} clock={settings.clock} {quiet} now={tl.now} ghost={{ project, minutes, at: picked }} onpick={(_, ms) => ((picked = ms), (hit = null))} onzoom={() => {}} onpan={() => {}} />
    </div>
    {#if hit}
      <ConflictChoice conflicts={hit} team={team?.name} {clockAt} {busy} onafter={after} onskip={canSkip ? skip : null} oncancel={() => (hit = null)} />
    {/if}
    {#if note}
      <div class="actions gapnote small">
        <span>
          {#if note.kind === 'builds'}It builds on {note.order != null ? `#${note.order} ` : ''}“{note.title}”, which would not be merged by then: it would wait.{:else}That is close behind {note.order != null ? `#${note.order} ` : ''}“{note.title}”. Jobs run over, and the gate needs a few minutes to merge.{/if}
          Leaving room: <b>{when(note.at)}</b>.
        </span>
        <span class="spacer"></span>
        <button class="btn sm" onclick={() => (picked = note.at)} disabled={busy}>Place it there</button>
      </div>
    {/if}
    {#if canBrake}
      <label class="small limit" title="Without this, the lead is told to wrap up at one and a half times the estimate, and the job is stopped at twice the estimate (never sooner than the estimate plus 20 minutes).">
        <input type="checkbox" bind:checked={noBrake} /> No time limit for this job
      </label>
    {/if}
    <div class="actions">
      {#if picked}
        <span>Starts <b>{when(picked)}</b>, ends about <b>{when(picked + minutes * 60000)}</b> (estimate {minutes} min). <span class="dim small">Drag the bar, or click elsewhere in the row, to change it.</span></span>
      {:else}
        <span class="small dim">Click in the first row to pick the start. It snaps to the quarter hour.</span>
      {/if}
      <span class="spacer"></span>
      <button class="btn quiet" onclick={onclose}>Cancel</button>
      <button class="btn primary" disabled={!picked || busy || !!hit} onclick={set}>Set</button>
    </div>
  {/if}
</Modal>

<style>
  .tlbox {
    padding: 8px 4px;
  }
  .gapnote {
    padding: 8px 12px;
    border: 1px solid var(--warn);
    border-radius: 10px;
    background: rgba(251, 191, 36, 0.08);
  }
  .limit {
    display: flex;
    align-items: center;
    gap: 6px;
  }
</style>
