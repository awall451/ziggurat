<script>
  // Focus mode (#93, kit 0.27): one team works in cycles back to back for a
  // while; the other teams keep their schedules or are paused. Each VM ends its
  // focus or pause by itself; the team also stops early when it is blocked on
  // the owner.
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import Modal from '$lib/components/Modal.svelte';
  import { usd } from '$lib/format.js';
  import { focusEstimate } from '$lib/focus.js';

  let { id, name, cap = null, typical = null, onclose, ondone } = $props();

  const pad = (n) => String(n).padStart(2, '0');
  const localInput = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  // Default end: Monday 06:00 after the coming weekend, if today is Fri to Sun; otherwise tomorrow 06:00.
  function defaultEnd() {
    const d = new Date();
    const add = d.getDay() === 5 ? 3 : d.getDay() === 6 ? 2 : d.getDay() === 0 ? 1 : 1;
    d.setDate(d.getDate() + add);
    d.setHours(6, 0, 0, 0);
    return localInput(d.getTime());
  }

  let mode = $state('until');
  let untilText = $state(defaultEnd());
  let cycles = $state(6);
  let perDay = $state(Math.max(cap || 6, 6));
  let others = $state('keep');
  let teams = $state([]);
  let busy = $state(false);
  let problem = $state('');

  onMount(async () => {
    try {
      const r = await fetch('/api/focus');
      teams = (await r.json()).teams || [];
    } catch {
      teams = [];
    }
  });

  const untilEpoch = $derived(Math.round(Date.parse(untilText) / 1000));
  const est = $derived(focusEstimate({ mode, until: untilEpoch, cycles: Number(cycles), perDay: Number(perDay) }, typical));
  const otherTeams = $derived(teams.filter((t) => t.id !== id));
  const inFocus = $derived(teams.find((t) => t.focus?.on));
  // Jobs and one-time cycles of the other teams set for a time inside the focus: they still run.
  const windowEnd = $derived(mode === 'until' && Number.isFinite(untilEpoch) ? untilEpoch : Date.now() / 1000 + 7 * 86400);
  const planned = $derived(
    otherTeams.flatMap((t) => t.atJobs.filter((j) => j.at >= Date.now() / 1000 && j.at <= windowEnd).map((j) => ({ ...j, team: t.name }))).sort((a, b) => a.at - b.at)
  );
  const KIND = { once: 'one-time cycle', plan: 'planning cycle', job: 'planned job' };
  const when = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const hoursText = (h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} h`);

  const why = $derived.by(() => {
    if (inFocus && inFocus.id !== id) return `${inFocus.name} is in focus already. Stop that focus first.`;
    if (!Number.isInteger(Number(perDay)) || perDay < 1 || perDay > 200) return 'Cycles a day: 1 to 200.';
    if (mode === 'until' && (!Number.isFinite(untilEpoch) || untilEpoch < Date.now() / 1000 + 60 || untilEpoch > Date.now() / 1000 + 31 * 86400)) return 'The end must be between a minute and 31 days from now.';
    if (mode === 'cycles' && (!Number.isInteger(Number(cycles)) || cycles < 1 || cycles > 500)) return 'Cycles: 1 to 500.';
    return null;
  });

  async function start() {
    busy = true;
    problem = '';
    try {
      const res = await fetch('/api/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', project: id, mode, until: mode === 'until' ? untilEpoch : null, cycles: mode === 'cycles' ? Number(cycles) : null, perDay: Number(perDay), pauseOthers: others === 'pause' })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'That did not work');
      ondone?.(out.detail);
      await invalidateAll();
    } catch (e) {
      problem = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Focus on {name}" {onclose}>
  <div class="grid">
    <p class="small">
      {name} runs normal cycles back to back: each ends, merges and reports as usual, then the next starts. Its start times are set aside meanwhile. Its planned jobs run first, right away and in order, without waiting for their set times;
      then cycles of the lead's own choosing. Jobs set after the focus ends keep their times. Afterwards everything is as it was.
    </p>

    <div class="stack">
      <span class="small dim">Until</span>
      <label class="opt"><input type="radio" bind:group={mode} value="until" /> A time <input class="field mono" type="datetime-local" bind:value={untilText} disabled={mode !== 'until'} aria-label="Focus ends at" /></label>
      <label class="opt"><input type="radio" bind:group={mode} value="cycles" /> A number of cycles <input class="field mono num" type="number" min="1" max="500" bind:value={cycles} disabled={mode !== 'cycles'} aria-label="Number of cycles" /></label>
      <label class="opt"><input type="radio" bind:group={mode} value="open" /> Until I switch it off</label>
    </div>

    <label class="opt">
      <span class="small dim">At most</span>
      <input class="field mono num" type="number" min="1" max="200" bind:value={perDay} aria-label="Cycles a day" />
      <span class="small dim">cycles a day{cap != null ? ` (its daily cap is ${cap}; this one is for the focus only)` : ''}</span>
    </label>

    {#if otherTeams.length}
      <div class="stack">
        <span class="small dim">The other teams ({otherTeams.map((t) => t.name).join(', ')})</span>
        <label class="opt"><input type="radio" bind:group={others} value="keep" /> Keep their schedules</label>
        <label class="opt"><input type="radio" bind:group={others} value="pause" /> Pause them: all usage goes to {name}</label>
      </div>
      {#if others === 'pause' && planned.length}
        <div class="small">
          Set for a time in that stretch, these still run:
          <ul>
            {#each planned as j (j.id)}<li>{j.team}: {KIND[j.kind]}, {when(j.at)}</li>{/each}
          </ul>
          Move or cancel them on the Schedule if they should wait.
        </div>
      {/if}
    {/if}

    <div class="est panel">
      <div class="small">
        <b>Likely:</b>
        about {est.cycles} cycle{est.cycles === 1 ? '' : 's'}{est.perDay ? ' a day' : ''}, about {hoursText(est.hours)} of work{est.costUsd != null ? `, about ${usd(est.costUsd)} of usage` : ''}, over about {est.windows}
        five-hour usage window{est.windows === 1 ? '' : 's'}{est.perDay ? ' a day' : ''}.
      </div>
      <div class="small dim">
        {typical?.n ? `From ${name}'s typical cycle (median of its last ${typical.n}).` : 'No finished cycles yet: an hour a cycle is assumed.'}
        {est.limitedByLength ? ` Back to back, ${name} fits fewer cycles a day than ${perDay}.` : ''}
        If the usage limit is reached, the cycle waits for the window to reset; it is shown as Stalled, and the wait is not counted as a cycle.
      </div>
    </div>

    <p class="small dim">The focus ends early, by itself, when {name} is blocked on you: its lead says so, or two cycles in a row change only its notes.</p>
    {#if problem}<p class="small s-failed" role="alert">{problem}</p>{:else if why}<p class="small s-interrupted">{why}</p>{/if}
  </div>
  <div class="actions">
    <span class="spacer"></span>
    <button class="btn quiet" onclick={onclose} disabled={busy}>Cancel</button>
    <button class="btn primary" onclick={start} disabled={busy || !!why}>{busy ? 'Starting…' : 'Start focus'}</button>
  </div>
</Modal>

<style>
  .grid {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 560px;
  }
  .opt {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .num {
    width: 5.5em;
  }
  .est {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  ul {
    margin: 4px 0;
    padding-left: 18px;
  }
  p {
    margin: 0;
  }
</style>
