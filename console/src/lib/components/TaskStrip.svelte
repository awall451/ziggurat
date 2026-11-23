<script>
  // "Task at hand": what the picked cycle is (or was) for, and, when no cycle
  // runs, why and what comes next. Built by lib/server/task.js. Every text here
  // that an agent wrote arrives as one short plain line and is shown as text.
  import { usd, dur, ago, when, clock, stallText } from '$lib/format.js';

  let { task, base } = $props();
  const run = $derived(task?.run || null);
  const team = $derived(task?.team || null);

  // "So far" figures move on between two refreshes of the page's data.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const KIND = { job: 'Planned job', fix: 'Fix now', plan: 'Planning', oneshot: 'One-shot job' };
  const STATE = { done: 'Done', failed: 'Failed', interrupted: 'Interrupted', ending: 'Ending', running: 'Live', waiting: 'Live', queued: 'Queued' };
  const ISSUE = { new: 'new', in_progress: 'in progress', done: 'done', wontfix: "won't fix" };

  const kindOf = (r) => KIND[r.kind] || `${r.slot ? 'Scheduled cycle' : 'Cycle'}${r.number != null ? ` ${r.number}` : ''}`;
  const hm = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? '–' : new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const issueHref = (i) => `${base}/issues?issue=${i.id}`;
  const issueWords = (i) => [i.kind === 'planned' ? null : i.kind, i.kind === 'planned' ? null : i.priority, ISSUE[i.status] || i.status].filter(Boolean).join(' · ');
  const estimate = (item) => [item?.minutes ? `about ${item.minutes} min` : null, item?.cost != null ? usd(item.cost, 0) : null].filter(Boolean).join(', ');

  const secs = $derived.by(() => {
    if (!run?.started) return null;
    const a = Date.parse(run.started);
    const b = run.live ? now : Date.parse(run.ended);
    return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, (b - a) / 1000);
  });
  const mins = $derived(secs == null ? null : Math.round(secs / 60));
  const est = $derived(run?.item?.minutes || null);
  const saidBy = $derived(
    !run?.said ? null : run.said.label === 'summary' ? 'Cycle summary' : run.said.label === 'latest' ? `Lead, ${ago(run.said.at, now)}` : `Lead's last word, ${hm(run.said.at)}`
  );

  // Why an idle team is idle, in a few words (the long form is on Overview).
  const idleWords = $derived.by(() => {
    const i = team?.idle;
    if (!i) return [];
    const counted = i.cap != null && i.today != null ? `${i.today} of ${i.cap} cycles today` : null;
    if (i.reason === 'cap') return ['Daily cycle cap used up', counted, clock(i.dayEndsAt, now) ? `resets at ${clock(i.dayEndsAt, now)}` : null];
    if (i.reason === 'timer-off') return ['The lead timer is off: no cycle starts on its own'];
    if (i.reason === 'halt-after') return ['A halt is pending'];
    return ['Between cycles', clock(i.nextAt, now) ? `next cycle ${clock(i.nextAt, now)}` : null, counted];
  });
</script>

{#snippet what(r, big)}
  {#if r.kind === 'job' && r.item}
    <a class="key" href="{base}/backlog">Job{r.item.order != null ? ` ${r.item.order}` : ''}</a>
    <a class="what" class:big href="{base}/backlog" title={r.item.title}>{r.item.title}</a>
    {#if r.issue}
      <span class="dim small">tracked by</span>
      <a class="key" href={issueHref(r.issue)}>#{r.issue.number ?? '?'}</a>
      <span class="dim small">{issueWords(r.issue)}</span>
    {/if}
  {:else if r.kind === 'fix' && r.issue}
    <a class="key" href={issueHref(r.issue)}>#{r.issue.number ?? '?'}</a>
    <a class="what" class:big href={issueHref(r.issue)} title={r.issue.title}>{r.issue.title}</a>
    <span class="dim small">{issueWords(r.issue)}</span>
  {:else if r.kind === 'plan'}
    <a class="key" href="{base}/backlog">Plan</a>
    <a class="what" class:big href="{base}/backlog" title={r.plan?.focus || ''}>{r.plan?.focus || 'Planning cycle: the lead proposes what to do next'}</a>
  {:else if r.kind === 'oneshot'}
    <span class="what" class:big title={r.text || ''}>{r.text || 'A one-shot job for one owner message'}</span>
  {/if}
{/snippet}

{#if task}
  <section class="panel strip" aria-label="Task at hand">
    {#if team}
      <div class="r1">
        <span class="cap">Task at hand</span>
        <span class="pill {team.state}"><span class="dot"></span>{team.state === 'halted' ? 'Halted' : 'Idle'}</span>
        {#if team.state === 'halted'}
          <span class="kind">No cycle starts until you resume</span>
          <span class="grow"></span>
          <a class="small" href="{base}/controls">Controls</a>
        {:else}
          <span class="kind">{idleWords[0] || 'No cycle is running'}</span>
          {#each idleWords.slice(1).filter(Boolean) as w (w)}<span class="dim small">{w}</span>{/each}
        {/if}
      </div>
      {#if team.next}
        <div class="r2">
          <span class="dim small">Next job, set for {clock(team.next.at / 1000, now)}</span>
          {@render what(team.next, true)}
          {#if estimate(team.next.item)}<span class="dim small">{estimate(team.next.item)}</span>{/if}
        </div>
      {/if}
      {#if run}
        <div class="r3">
          <span class="who">Last: {kindOf(run).toLowerCase()}, {(STATE[run.state] || run.state || 'ended').toLowerCase()} {when(run.ended)}</span>
          {#if run.kind === 'cycle'}
            {#if run.said}<span class="say" title={run.said.text}>{run.said.text}</span>{/if}
          {:else}
            {@render what(run, false)}
          {/if}
        </div>
      {/if}
    {:else if run}
      <div class="r1">
        <span class="cap">Task at hand</span>
        <span class="pill {run.live ? (run.stalled ? 'stalled' : 'running') : run.state}" title={run.stalled ? stallText(run.stalled, now) : null}><span class="dot"></span>{run.live ? (run.stalled ? 'Stalled' : 'Live') : STATE[run.state] || run.state}</span>
        <span class="kind">{kindOf(run)}</span>
        {#if run.slot}<span class="dim small mono" title="The schedule slot that started this cycle, in the schedule's time zone">{run.slot}</span>{/if}
        <span class="dim small">{run.live ? `started ${when(run.started)}` : `${when(run.started)} to ${hm(run.ended)}`}</span>
        <span class="grow"></span>
        {#if est && mins != null}
          {#if run.live}
            <span class="bar" class:over={mins > est} role="img" aria-label="{mins} of {est} minutes"><span style:width="{Math.min(100, (mins / est) * 100)}%"></span></span>
          {/if}
          <span class="small mono">{mins} of {est} min</span>
        {:else if secs != null}
          <span class="small mono">{dur(secs)}{run.live ? ' so far' : ''}</span>
        {/if}
        {#if run.costUsd != null}
          <span class="dim small mono">{usd(run.costUsd)}{run.live ? ' so far' : ''}{run.item?.cost != null ? `, about ${usd(run.item.cost, 0)} estimated` : ''}</span>
        {/if}
      </div>
      {#if run.kind === 'cycle'}
        <div class="r2">
          {#if run.said}
            <span class="who">{saidBy}</span>
            <span class="what big" title={run.said.text}>{run.said.text}</span>
          {:else}
            <span class="what big dim">{run.live ? 'The lead has not written anything yet' : 'The lead wrote nothing in this cycle'}</span>
          {/if}
        </div>
        <div class="r3 dim">The lead picks the work in this cycle: no issue or planned job is tied to it.</div>
      {:else}
        <div class="r2">{@render what(run, true)}</div>
        {#if run.said}
          <div class="r3">
            <span class="who">{saidBy}</span>
            <span class="say" title={run.said.text}>{run.said.text}</span>
          </div>
        {/if}
      {/if}
    {/if}
  </section>
{/if}

<style>
  .strip {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
  .r1,
  .r2 {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .r2 {
    align-items: baseline;
  }
  .r3 {
    display: flex;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
  }
  .cap {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-2);
    font-weight: 600;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .kind {
    font-weight: 600;
    color: var(--ink-strong);
  }
  .grow {
    flex: 1;
  }
  .bar {
    width: 120px;
    height: 6px;
    border-radius: 3px;
    background: var(--panel-solid);
    border: 1px solid var(--line);
    overflow: hidden;
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--cyan);
  }
  .bar.over > span {
    background: var(--warn);
  }
  .key {
    flex: none;
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid var(--line-strong);
    background: rgba(var(--glow), 0.1);
  }
  .what {
    color: var(--ink);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .what.big {
    font-family: var(--font-head);
    font-size: 18px;
    font-weight: 600;
    color: var(--ink-strong);
  }
  .what.big.dim {
    color: var(--ink-2);
    font-weight: 500;
  }
  a.what:hover {
    color: var(--cyan-soft);
  }
  /* Long lines of the lead stay at two lines; the whole line is in the tooltip. */
  .what.big,
  .say {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .who {
    flex: none;
    font-size: 12px;
    color: var(--ink-2);
  }
  .say {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
