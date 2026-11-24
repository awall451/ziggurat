<script>
  // Focus mode (#93, kit 0.27): a team works in cycles back to back for a
  // while; the teams not in focus keep their schedules or are paused. Several
  // teams can be in focus at once (#115): they share the usage window, shown
  // here before the next one starts. Each VM ends its focus or pause by
  // itself; the team also stops early when it is blocked on the owner.
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import Modal from '$lib/components/Modal.svelte';
  import { usd } from '$lib/format.js';
  import { focusEstimate, focusLeft } from '$lib/focus.js';

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
  let endPause = $state(false);
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
  // Other teams in focus now: they share the usage window with this one (#115).
  const inFocus = $derived(otherTeams.filter((t) => t.focus?.on).map((t) => ({ ...t, left: focusLeft(t.focus.on, t.typical) })));
  // The teams a pause would reach: not in focus themselves.
  const pausable = $derived(otherTeams.filter((t) => !t.focus?.on));
  const me = $derived(teams.find((t) => t.id === id));
  const pausedFor = $derived(me?.focus?.paused?.for ? teams.find((t) => t.id === me.focus.paused.for)?.name || me.focus.paused.for : null);
  const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const total = $derived.by(() => {
    const all = [...inFocus.map((t) => t.left), est].filter(Boolean);
    const costs = all.map((e) => e.costUsd);
    return { hours: sum(all, (e) => e.hours), costUsd: costs.every(Number.isFinite) ? sum(all, (e) => e.costUsd) : null, perDay: all.some((e) => e.perDay) };
  });
  // Jobs and one-time cycles of the other teams set for a time inside the focus: they still run.
  const windowEnd = $derived(mode === 'until' && Number.isFinite(untilEpoch) ? untilEpoch : Date.now() / 1000 + 7 * 86400);
  const planned = $derived(
    pausable.flatMap((t) => t.atJobs.filter((j) => j.at >= Date.now() / 1000 && j.at <= windowEnd).map((j) => ({ ...j, team: t.name }))).sort((a, b) => a.at - b.at)
  );
  const KIND = { once: 'one-time cycle', plan: 'planning cycle', job: 'planned job' };
  const when = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const hoursText = (h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} h`);
  const line = (e) => (e ? `about ${e.cycles} cycle${e.cycles === 1 ? '' : 's'}${e.perDay ? ' a day' : ' left'}, ${hoursText(e.hours)}${e.costUsd != null ? `, ${usd(e.costUsd)}` : ''}` : '');

  const why = $derived.by(() => {
    if (me?.focus?.on) return `${name} is in focus already.`;
    if (pausedFor && !endPause) return `${name} is paused for ${pausedFor}'s focus: tick the box above to end that pause and start.`;
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
        body: JSON.stringify({ action: 'start', project: id, mode, until: mode === 'until' ? untilEpoch : null, cycles: mode === 'cycles' ? Number(cycles) : null, perDay: Number(perDay), pauseOthers: others === 'pause', endPause: !!pausedFor && endPause })
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
      {name} runs normal cycles back to back: each ends, merges and reports as usual, then the next starts. Its start times are set aside meanwhile. The order of work:
      first its planned jobs set for a time before the focus ends, right away and in order; then its open issues, in progress before new (approved proposals included);
      then work of the lead's own choosing. Afterwards everything is as it was.
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

    {#if pausedFor}
      <label class="opt panel paused">
        <input type="checkbox" bind:checked={endPause} />
        <span class="small">{name} is paused for {pausedFor}'s focus. End its pause and start this focus; {pausedFor}'s focus goes on, and the two share the usage window.</span>
      </label>
    {/if}

    {#if pausable.length}
      <div class="stack">
        <span class="small dim">The teams not in focus ({pausable.map((t) => t.name).join(', ')})</span>
        <label class="opt"><input type="radio" bind:group={others} value="keep" /> Keep their schedules</label>
        <label class="opt"><input type="radio" bind:group={others} value="pause" /> Pause them: all usage goes to the teams in focus</label>
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

    {#if inFocus.length}
      <div class="est panel shared">
        <div class="small"><b>Sharing the usage window</b> with {inFocus.length === 1 ? 'the team' : `the ${inFocus.length} teams`} in focus now. Every team draws on the same subscription:</div>
        <table class="small">
          <tbody>
            {#each inFocus as t (t.id)}
              <tr>
                <td>{t.name}</td>
                <td class="dim">{line(t.left)}</td>
              </tr>
            {/each}
            <tr>
              <td>{name} <span class="dim">(new)</span></td>
              <td class="dim">{line(est)}</td>
            </tr>
            <tr class="sum">
              <td>Together</td>
              <td>about {hoursText(total.hours)} of work{total.perDay ? ' (a day for those until switched off)' : ''}{total.costUsd != null ? `, about ${usd(total.costUsd)} of usage` : ''}</td>
            </tr>
          </tbody>
        </table>
        {#if inFocus.length >= 2}
          <div class="small s-interrupted">{inFocus.length + 1} teams in focus will compete for the same usage limit: each gets fewer cycles than it would alone.</div>
        {/if}
      </div>
    {/if}

    <p class="small dim">The focus ends early, by itself, when {name} is blocked on you: its lead says so, or two cycles in a row change only its notes.</p>
    {#if problem}<p class="small s-failed" role="alert">{problem}</p>{:else if why}<p class="small s-interrupted">{why}</p>{/if}
  </div>
  <div class="actions">
    <span class="spacer"></span>
    <button class="btn quiet" onclick={onclose} disabled={busy}>Cancel</button>
    <button class="btn primary" onclick={start} disabled={busy || !!why}>{busy ? 'Starting…' : inFocus.length ? `Start, shared with ${inFocus.length}` : 'Start focus'}</button>
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
  .paused {
    padding: 8px 12px;
    align-items: flex-start;
    flex-wrap: nowrap;
  }
  table {
    border-collapse: collapse;
  }
  td {
    padding: 2px 12px 2px 0;
    vertical-align: top;
  }
  .sum td {
    border-top: 1px solid var(--line);
    padding-top: 4px;
  }
  ul {
    margin: 4px 0;
    padding-left: 18px;
  }
  p {
    margin: 0;
  }
</style>
