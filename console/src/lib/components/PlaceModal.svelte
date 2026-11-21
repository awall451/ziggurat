<script>
  // Place a backlog job (or a planning cycle) on the timeline: one day of
  // every team, the job's estimate follows the pointer in its own team's
  // row, a click picks the start, Set confirms. Other rows are there to see
  // what else runs then.
  import { onMount } from 'svelte';
  import Modal from '$lib/components/Modal.svelte';
  import Timeline from '$lib/components/Timeline.svelte';
  import { plan, quietIntervals, wallClock, clockLabel, zoneLabel, validTimeZone } from '$lib/schedule.js';

  let { project, title, minutes, busy = false, onclose = () => {}, onset = () => {} } = $props();

  let tl = $state(null);
  let error = $state('');
  let picked = $state(null); // ms
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
      log: p.log
    }));
  });
  const quiet = $derived(tl ? quietIntervals(settings, range.from, range.to) : []);
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
      <Timeline {rows} {range} tz={settings.timezone} clock={settings.clock} {quiet} now={tl.now} ghost={{ project, minutes }} onpick={(_, ms) => (picked = ms)} onzoom={() => {}} onpan={() => {}} />
    </div>
    <div class="actions">
      {#if picked}
        <span>Starts <b>{when(picked)}</b>, ends about <b>{when(picked + minutes * 60000)}</b> (estimate {minutes} min).</span>
      {:else}
        <span class="small dim">Click in the first row to pick the start. It snaps to the quarter hour.</span>
      {/if}
      <span class="spacer"></span>
      <button class="btn quiet" onclick={onclose}>Cancel</button>
      <button class="btn primary" disabled={!picked || busy} onclick={() => onset(Math.round(picked / 1000))}>Set</button>
    </div>
  {/if}
</Modal>

<style>
  .tlbox {
    padding: 8px 4px;
  }
</style>
