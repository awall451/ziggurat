<script>
  // Add or change one start time of a team (#90), like a calendar's custom
  // recurrence: a start date and time, "Does not repeat" (a one-time cycle) or
  // "Repeats" (every N days or weeks, on which weekdays, ending never, on a
  // date or after N times). Done sends it to the team's VM at once.
  //
  // form: {date, time, repeat, unit: 'day'|'week', every, days: [mon..], ends: 'never'|'on'|'after', until, count, pastCap}
  import Modal from '$lib/components/Modal.svelte';
  import { DAYS, MAX_EVERY, MAX_COUNT, validDate } from '$lib/schedule.js';

  let {
    title,
    form = $bindable(),
    existing = false, // a start time or one-time cycle that is there already: Delete is offered
    canRepeatMore = true, // the VM knows every N, first and last dates (kit 0.26)
    canOnce = true, // the VM can run a one-time cycle (kit 0.26)
    zone = '', // the team's time zone, as text
    typical = '', // a typical cycle of the team, as text
    today, // YYYY-MM-DD in the team's zone
    busy = false,
    problem = '',
    ondone,
    ondelete,
    oncancel
  } = $props();

  // Sunday first, as calendars show them.
  const ROUND = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayOf = (ds) => DAYS[(Math.round(Date.parse(`${ds}T00:00:00Z`) / 86_400_000) + 3) % 7];

  function toggle(day) {
    const has = form.days.includes(day);
    if (has && form.days.length === 1) return;
    form.days = has ? form.days.filter((d) => d !== day) : DAYS.filter((d) => d === day || form.days.includes(d));
  }
  function setUnit(u) {
    form.unit = u;
    if (u === 'week' && !form.days.length) form.days = [dayOf(form.date)];
  }

  const why = $derived.by(() => {
    if (!validDate(form.date) || !/^\d{2}:\d{2}$/.test(form.time || '')) return 'Pick a date and a time.';
    if (!form.repeat) {
      if (!canOnce) return 'A one-time cycle needs kit 0.26 on this VM.';
      if (form.date < today) return 'That date has passed.';
      return null;
    }
    if (!Number.isInteger(form.every) || form.every < 1 || form.every > MAX_EVERY) return `Every 1 to ${MAX_EVERY}.`;
    if (form.unit === 'week' && !form.days.length) return 'Pick at least one day.';
    if (form.ends === 'on' && (!validDate(form.until) || form.until < form.date)) return 'The end date must be on or after the start.';
    if (form.ends === 'after' && (!Number.isInteger(form.count) || form.count < 1 || form.count > MAX_COUNT)) return `After 1 to ${MAX_COUNT} times.`;
    if (!canRepeatMore && (form.every > 1 || form.ends !== 'never' || form.date > today)) return 'Every N, a later start date and an end need kit 0.26 on this VM.';
    return null;
  });
</script>

<Modal {title} onclose={oncancel}>
  <div class="grid">
    <label class="stack">
      <span class="small dim">Start</span>
      <span class="row">
        <input class="field mono" type="date" bind:value={form.date} min={today} aria-label="Start date" />
        <input class="field mono" type="time" step="900" bind:value={form.time} aria-label="Start time" />
      </span>
    </label>

    <div class="stack">
      <span class="small dim">Repeat</span>
      <div class="seg" role="radiogroup" aria-label="Repeat">
        <button class="btn quiet sm" class:on={!form.repeat} role="radio" aria-checked={!form.repeat} onclick={() => (form.repeat = false)} disabled={!canOnce}>Does not repeat</button>
        <button class="btn quiet sm" class:on={form.repeat} role="radio" aria-checked={form.repeat} onclick={() => (form.repeat = true)}>Repeats</button>
      </div>
    </div>

    {#if form.repeat}
      <div class="stack">
        <span class="small dim">Repeat every</span>
        <span class="row">
          <input class="field mono num" type="number" min="1" max={MAX_EVERY} bind:value={form.every} aria-label="Every how many" disabled={!canRepeatMore} />
          <select class="field" value={form.unit} onchange={(e) => setUnit(e.currentTarget.value)} aria-label="Days or weeks">
            <option value="day">{form.every === 1 ? 'day' : 'days'}</option>
            <option value="week">{form.every === 1 ? 'week' : 'weeks'}</option>
          </select>
        </span>
      </div>
      {#if form.unit === 'week'}
        <div class="stack">
          <span class="small dim">On</span>
          <div class="round">
            {#each ROUND as day (day)}
              <button class="dayb" class:on={form.days.includes(day)} aria-pressed={form.days.includes(day)} aria-label={day} onclick={() => toggle(day)}>{day[0].toUpperCase()}</button>
            {/each}
          </div>
        </div>
      {/if}
      <div class="stack">
        <span class="small dim">Ends</span>
        <label class="opt"><input type="radio" bind:group={form.ends} value="never" /> Never</label>
        <label class="opt"
          ><input type="radio" bind:group={form.ends} value="on" disabled={!canRepeatMore} /> On
          <input class="field mono" type="date" bind:value={form.until} min={form.date} disabled={form.ends !== 'on'} aria-label="End date" /></label
        >
        <label class="opt"
          ><input type="radio" bind:group={form.ends} value="after" disabled={!canRepeatMore} /> After
          <input class="field mono num" type="number" min="1" max={MAX_COUNT} bind:value={form.count} disabled={form.ends !== 'after'} aria-label="Number of times" /> times</label
        >
      </div>
    {:else}
      <label class="opt">
        <input type="checkbox" bind:checked={form.pastCap} />
        <span>Run it even if the daily cap is reached by then</span>
      </label>
      <p class="small dim">One normal cycle at that time; the lead picks the work. Then the team goes back to how it was. Without the tick, it is dropped if the cap is reached.</p>
    {/if}

    <p class="small dim">Times in {zone}. {typical}{form.repeat ? ' If the previous cycle is still running at a start time, that start is skipped.' : ''}</p>
    {#if problem}<p class="small s-failed" role="alert">{problem}</p>{:else if why}<p class="small s-interrupted">{why}</p>{/if}
  </div>

  <div class="actions">
    {#if existing}<button class="btn danger" onclick={ondelete} disabled={busy}>Delete{form.repeat ? '…' : ''}</button>{/if}
    <span class="spacer"></span>
    <button class="btn quiet" onclick={oncancel} disabled={busy}>Cancel</button>
    <button class="btn primary" onclick={ondone} disabled={busy || !!why}>{busy ? 'Saving…' : 'Done'}</button>
  </div>
  <p class="small dim">Done sends it to the team's VM at once.</p>
</Modal>

<style>
  .grid {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: min(420px, 80vw);
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .seg {
    display: flex;
    gap: 6px;
  }
  .num {
    width: 5.5em;
  }
  .opt {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .round {
    display: flex;
    gap: 6px;
  }
  .dayb {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.15));
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .dayb.on {
    background: var(--cyan);
    color: var(--bg, #06101c);
    border-color: var(--cyan);
  }
  p {
    margin: 0;
  }
</style>
