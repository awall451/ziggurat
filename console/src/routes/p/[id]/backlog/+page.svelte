<script>
  // The backlog: the owner asks the lead to find what to do next (a planning
  // cycle, no code), reviews the proposals with their estimates, talks them
  // over with the lead, and runs an approved item now or at a set time.
  // Everything shown from the lead was written by an agent and checked on the
  // server; text is rendered through the sanitising markdown helper.
  import { invalidateAll } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ago, usd } from '$lib/format.js';
  import { instantOf, wallClock, clockLabel, zoneLabel } from '$lib/schedule.js';
  import Popover from '$lib/components/Popover.svelte';
  import ProposalCard from '$lib/components/ProposalCard.svelte';
  import PlaceModal from '$lib/components/PlaceModal.svelte';
  import PlanChat from '$lib/components/PlanChat.svelte';

  let { data } = $props();
  const p = $derived(data.project);
  const base = $derived(`/p/${p.id}`);
  const plans = $derived(data.backlog.plans);
  const newest = $derived(plans.find((x) => x.newest) || null);
  const earlier = $derived(plans.filter((x) => !x.newest));
  // The chat is only for talking a finished plan over.
  const chatPlan = $derived(newest?.done ? newest : null);
  const chatClosed = $derived(
    newest?.running
      ? 'The lead is planning… The chat opens when the proposals are in.'
      : newest?.scheduledFor && !newest.done && !newest.cancelled
        ? `A planning cycle is set for ${whenText(newest.scheduledFor)}. The chat opens when its proposals are in.`
        : 'This chat is for talking a plan over with the lead. Start a planning cycle first: the chat opens when its proposals are in.'
  );
  const lead = 'the lead';

  let busy = $state('');
  let flash = $state(null); // {ok, text}
  let focus = $state('');
  let maxProposals = $state('');
  let planAt = $state('');
  let planLater = $state(false); // the "Later…" pop-over of the planning form
  let chatText = $state('');
  let atFor = $state(null); // pid whose time picker is open
  let atValue = $state('');
  let atMode = $state('menu'); // the Schedule pop-over: 'menu', then 'time'
  let placing = $state(null); // {pid | null (a planning cycle), title, minutes, builds}
  // Per item: the owner switched the time limit off for its job (kit 0.18).
  let noLimit = $state({});
  let openPlan = $state(null);
  let chat = $state(null); // the chat box (PlanChat)
  let chatCol = $state(null);

  // Wide window: the chat box ends at the bottom of the window, wherever it
  // starts (under the project's header at first, under the top bar once the
  // page has scrolled). Narrow: the height comes from the stylesheet.
  function fitChat() {
    if (!chatCol) return;
    const wide = window.matchMedia('(min-width: 1000px)').matches;
    chatCol.style.height = wide ? `${Math.max(280, window.innerHeight - chatCol.getBoundingClientRect().top - 24)}px` : '';
  }
  $effect(() => {
    chatCol;
    flash;
    plans;
    fitChat();
  });

  const STATE_WORD = { new: 'New', approved: 'Approved', rejected: 'Rejected', revised: 'Revised: decide again' };
  // A chat turn does not block a cycle or a job (kit 0.10.1); a cycle does.
  const busyTeam = $derived(data.busy?.state === 'running' || !!data.busy?.oneshot);
  const waiting = $derived(plans.some((x) => x.waiting || x.running) || !!data.busy?.chat);

  // While the lead works or answers, look again every 10 seconds.
  onMount(() => {
    const t = setInterval(() => {
      if (waiting && document.visibilityState === 'visible') post({ action: 'sync' }, '', { quiet: true });
    }, 10_000);
    return () => clearInterval(t);
  });

  // The newest plan's chat is on this page: answers shown here are read. The
  // mark lives on the console, so the count on the tab and the project card clears.
  let seenSent = '';
  $effect(() => {
    const last = newest?.chat.findLast((c) => c.reply)?.id;
    if (!last || !p.waiting?.chat || seenSent === last) return;
    seenSent = last;
    post({ action: 'chat-seen', plan: newest.id }, '', { quiet: true });
  });

  async function post(body, key, { quiet = false } = {}) {
    if (busy && !quiet) return null;
    if (!quiet) {
      busy = key;
      flash = null;
    }
    try {
      const r = await fetch(`${base}/backlog/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (!quiet) flash = { ok: false, text: out.message || 'That did not work' };
        return null;
      }
      if (!quiet && out.detail) flash = { ok: out.started !== false && out.scheduled !== false && out.delivered !== false, text: out.detail };
      await invalidateAll();
      return out;
    } finally {
      if (!quiet) busy = '';
    }
  }

  /** "2026-11-21T09:30" in the owner's time zone, as epoch seconds. */
  function epochOf(local) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || '');
    if (!m) return null;
    const ms = instantOf(data.timezone, ...m.slice(1).map(Number));
    return ms == null ? null : Math.round(ms / 1000);
  }
  function whenText(epoch) {
    const c = wallClock(data.timezone, epoch * 1000);
    const day = new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    return `${day}, ${clockLabel(`${String(c.H).padStart(2, '0')}:${String(c.M).padStart(2, '0')}`, data.clock)} (${zoneLabel(data.timezone)})`;
  }

  function startPlan(later = false) {
    let at = null;
    if (later) {
      at = epochOf(planAt);
      if (!at) return (flash = { ok: false, text: 'Pick a date and time that exists in your time zone' });
    }
    post({ action: 'plan', focus, at, maxProposals }, 'plan').then((out) => {
      if (out) {
        focus = '';
        planAt = '';
        planLater = false;
      }
    });
  }

  function runAt(pid, epoch = null, skip = null, noBrake = !!noLimit[pid]) {
    const at = epoch ?? epochOf(atValue);
    if (!at) return (flash = { ok: false, text: 'Pick a date and time' });
    post({ action: 'run-at', pid, at, skip, noBrake }, `at-${pid}`).then((out) => {
      if (out) {
        atFor = null;
        placing = null;
      }
    });
  }
  function openSchedule(pid) {
    atMode = 'menu';
    atValue = '';
    atFor = atFor === pid ? null : pid;
  }
  function place(prop) {
    atFor = null;
    placing = { pid: prop.pid, title: prop.title, minutes: prop.minutes, builds: prop.depends };
  }
  function placed(epoch, skip = null, opts = {}) {
    if (placing?.pid) return runAt(placing.pid, epoch, skip, !!opts.noBrake || !!noLimit[placing.pid]);
    post({ action: 'plan', focus, at: epoch, skip, maxProposals }, 'plan').then((out) => {
      if (out) {
        focus = '';
        placing = null;
        planLater = false;
      }
    });
  }

  function edit(prop) {
    chatText = `About "${prop.title}" (${prop.pid}): `;
    chat?.focus();
  }

  function sendChat() {
    if (!newest) return;
    post({ action: 'chat', plan: newest.id, text: chatText }, 'chat').then((out) => {
      if (out) chatText = '';
    });
  }

  const totals = (props) => props.filter((x) => x.state !== 'rejected').reduce((s, x) => ({ min: s.min + x.minutes, usd: s.usd + x.cost }), { min: 0, usd: 0 });
  const title = (plans, pid) => plans.flatMap((x) => x.proposals).find((x) => x.pid === pid)?.title || pid;
  const timedJob = (id) => data.atJobs.find((j) => j.id === id) || null;
</script>

<svelte:head><title>Planning · {p.name}</title></svelte:head>
<svelte:window onscroll={fitChat} onresize={fitChat} />

{#if !data.ready}
  <section class="panel block">
    <h2>Planning</h2>
    {#if data.kitVersion}
      <p>Planning needs kit 0.10.0 on this team's VM (it has {data.kitVersion}).</p>
    {:else}
      <p class="dim">The VM is not reachable right now.</p>
    {/if}
  </section>
{:else}
  {#if flash}<div class="flash small" class:bad={!flash.ok}>{flash.text}</div>{/if}

  <div class="cols">
  <div class="top">
  <section class="panel block ask">
    <h2>Find what to do next</h2>
    <p class="small dim">
      One planning cycle: {lead} reads its notes and the code, writes <b>no code</b>, and proposes jobs of at most 90 minutes each, with an estimate of time
      and cost. The team's normal cycles carry on as before. Not while a cycle runs.
    </p>
    <textarea class="field" rows="3" placeholder="Optional: what to focus on (a feature, a part of the game, a problem)" bind:value={focus}></textarea>
    <div class="actions">
      <label class="small dim cap">
        At most
        <select class="field" bind:value={maxProposals}>
          <option value="">3–8</option>
          {#each [1, 2, 3, 4, 5, 6, 7, 8] as n (n)}<option value={n}>{n}</option>{/each}
        </select>
        proposals
      </label>
      {#if busyTeam}<span class="small dim">The team is busy: {data.busy.oneshot?.plan ? 'a planning cycle is running' : 'a cycle is running'}.</span>{/if}
      <span class="spacer"></span>
      <Popover open={planLater} onclose={() => (planLater = false)}>
        {#snippet trigger()}
          <button class="btn quiet" disabled={!!busy} onclick={() => (planLater = !planLater)}>Later…</button>
        {/snippet}
        <button class="btn sm" onclick={() => ((planLater = false), (placing = { pid: null, title: 'planning cycle', minutes: data.planMinutes || 5 }))}>On the timeline…</button>
        <label class="fieldrow small">
          <span class="dim">Or at a time ({zoneLabel(data.timezone)})</span>
          <input class="field" type="datetime-local" bind:value={planAt} />
        </label>
        <div class="actions end">
          <button class="btn quiet sm" onclick={() => (planLater = false)}>Cancel</button>
          <button class="btn primary sm" disabled={!!busy || !planAt} onclick={() => startPlan(true)}>Set</button>
        </div>
      </Popover>
      <button class="btn primary" disabled={!!busy || busyTeam} onclick={() => startPlan()}>Start planning now</button>
    </div>
    {#each data.atJobs.filter((j) => j.plan) as j (j.id)}
      <div class="actions small">
        <span>Planning cycle set for {whenText(j.at)}</span>
        <button class="btn quiet sm" disabled={!!busy} onclick={() => post({ action: 'cancel-at', id: j.id }, 'cancel')}>Cancel it</button>
      </div>
    {/each}
  </section>

  {#if !plans.length}
    <p class="dim">No planning cycles yet.</p>
  {/if}

  {#if newest}{@render planPanel(newest)}{/if}
  </div>

  <div class="chatcol" class:empty={!chatPlan} bind:this={chatCol}>
    <PlanChat
      bind:this={chat}
      bind:text={chatText}
      plan={chatPlan}
      closed={chatClosed}
      {lead}
      now={p.now}
      {busy}
      chatBusy={!!data.busy?.chat}
      jobRunning={!!data.busy?.oneshot && !data.busy.oneshot.plan}
      onsend={sendChat}
      onresend={(text) => post({ action: 'chat', plan: newest.id, text }, 'chat')}
      onend={() => post({ action: 'chat-end', plan: newest.id }, 'end')}
    />
  </div>

  <div class="rest">
    {#each earlier as plan (plan.id)}{@render planPanel(plan)}{/each}
  </div>
  </div>

  {#snippet planPanel(plan)}
    {@const t = totals(plan.proposals)}
    <section class="panel block plan" class:old={!plan.newest}>
      <header class="row">
        <h2 class="grow">
          {#if plan.newest}Latest plan{:else}Earlier plan{/if}
          <span class="small dim">· asked {ago(plan.askedAt, p.now)} by {plan.by}</span>
        </h2>
        {#if plan.running}<span class="pill s-waiting">planning…</span>
        {:else if plan.scheduledFor && !plan.done && !plan.cancelled}<span class="pill">set for {whenText(plan.scheduledFor)}</span>
        {:else if plan.error && !plan.done}<span class="pill s-failed" title={plan.error}>not started</span>{/if}
        {#if plan.cost != null}<span class="small dim">planning: {plan.minutes} min, {usd(plan.cost)}{#if plan.chatCost}, chat {usd(plan.chatCost)}{/if}</span>{/if}
        {#if !plan.newest}<button class="btn quiet sm" onclick={() => (openPlan = openPlan === plan.id ? null : plan.id)}>{openPlan === plan.id ? 'Hide' : 'Show'}</button>{/if}
      </header>
      {#if plan.focus}<p class="small"><span class="dim">Focus:</span> {plan.focus}</p>{/if}
      {#if plan.touchedCode}
        <div class="flash bad small">The kit saw a change in the workspace during this planning session. Planning should not touch code: check the team's branches.</div>
      {/if}

      {#if plan.newest || openPlan === plan.id}
        {#if plan.proposals.length}
          <p class="small dim">{plan.proposals.length} proposal{plan.proposals.length > 1 ? 's' : ''} · {t.min} min · {usd(t.usd)} in all (rejected left out)</p>
        {:else if plan.done}
          <p class="small dim">No proposals came back from this planning cycle.</p>
        {/if}
        <div class="cards">
          {#each plan.proposals as prop (prop.pid)}
            {@const job = prop.run ? timedJob(prop.run.jobId) : null}
            <ProposalCard
              {prop}
              stateText={prop.taken ? 'Taken by a cycle' : STATE_WORD[prop.state] || prop.state}
              after={prop.depends.map((d) => title(plans, d)).join(', ')}
            >
              {#snippet actions()}
                {#if prop.state !== 'rejected' && !prop.taken}
                  <button class="btn quiet sm" disabled={!!busy} onclick={() => post({ action: 'decide', pid: prop.pid, status: 'rejected' }, prop.pid)}>Reject</button>
                {/if}
                {#if plan.newest && !plan.ended}<button class="btn quiet sm" onclick={() => edit(prop)}>Change…</button>{/if}
                <span class="spacer"></span>
                {#if prop.state !== 'approved'}
                  <button class="btn primary sm" disabled={!!busy} onclick={() => post({ action: 'decide', pid: prop.pid, status: 'approved' }, prop.pid)}>Approve</button>
                {:else if prop.taken}
                  <span class="small dim">A normal cycle took it.</span>
                {:else if job}
                  <span class="small">Set for {whenText(job.at)}</span>
                  <button class="btn quiet sm" disabled={!!busy} onclick={() => post({ action: 'cancel-at', id: job.id }, 'cancel')}>Cancel it</button>
                {:else if prop.run && prop.run.rev === prop.rev && !prop.run.cancelled && !prop.run.missed}
                  {#if prop.run.stopped != null}<span class="small s-failed" title="The time limit: a job is stopped at twice its estimate. What it had not submitted is still on its branches.">Stopped after {prop.run.stopped} min (estimate {prop.minutes})</span>{/if}
                  <a class="small" href="{base}/inbox">Job sent {ago(prop.run.at, p.now)}: see the Inbox</a>
                {:else}
                  {#if prop.run?.missed}<span class="small s-failed" title="The team was busy for hours after the set time">Missed</span>{/if}
                  <Popover open={atFor === prop.pid} onclose={() => (atFor = null)}>
                    {#snippet trigger()}
                      <button class="btn quiet sm" disabled={!!busy} onclick={() => openSchedule(prop.pid)}>Schedule ▾</button>
                    {/snippet}
                    {#if atMode === 'menu'}
                      <button class="btn sm" onclick={() => place(prop)}>On the timeline…</button>
                      <button class="btn quiet sm" onclick={() => (atMode = 'time')}>At a time…</button>
                    {:else}
                      <label class="fieldrow small">
                        <span class="dim">Start at ({zoneLabel(data.timezone)})</span>
                        <input class="field" type="datetime-local" bind:value={atValue} />
                      </label>
                      <div class="actions end">
                        <button class="btn quiet sm" onclick={() => (atFor = null)}>Cancel</button>
                        <button class="btn primary sm" disabled={!!busy || !atValue} onclick={() => runAt(prop.pid)}>Set</button>
                      </div>
                    {/if}
                  </Popover>
                  {#if data.canBrake}
                    <label class="small dim nolimit" title="Without this, the lead is told to wrap up at one and a half times the estimate, and the job is stopped at twice the estimate (never sooner than the estimate plus 20 minutes).">
                      <input type="checkbox" bind:checked={noLimit[prop.pid]} /> No time limit
                    </label>
                  {/if}
                  <button class="btn primary sm" disabled={!!busy || busyTeam} onclick={() => post({ action: 'run', pid: prop.pid, noBrake: !!noLimit[prop.pid] }, `run-${prop.pid}`)}>Run now</button>
                {/if}
              {/snippet}
            </ProposalCard>
          {/each}
        </div>

      {/if}
    </section>
  {/snippet}
{/if}

{#if placing}
  <PlaceModal project={p.id} title={placing.title} minutes={placing.minutes} builds={placing.builds || []} canBrake={data.canBrake && !!placing.pid} busy={!!busy} onclose={() => (placing = null)} onset={placed} />
{/if}

<style>
  .nolimit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .cap {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .block {
    padding: 18px;
    margin-bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .top,
  .rest {
    min-width: 0;
  }
  /* Narrow: the chat sits under the latest plan, with a fixed height. */
  .chatcol {
    height: min(70vh, 560px);
    margin-bottom: 14px;
  }
  .chatcol.empty {
    height: auto;
  }
  @media (min-width: 1000px) {
    .cols {
      grid-template-columns: minmax(0, 1fr) 400px;
      grid-template-rows: auto 1fr;
      grid-template-areas: 'top chat' 'rest chat';
      column-gap: 16px;
      align-items: start;
    }
    .top {
      grid-area: top;
    }
    .rest {
      grid-area: rest;
    }
    /* As high as the window, and it stays in view while the plans scroll. */
    .chatcol,
    .chatcol.empty {
      grid-area: chat;
      position: sticky;
      top: 72px;
      height: calc(100vh - 96px);
      margin-bottom: 0;
    }
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  h2 {
    margin: 0;
  }
  .ask textarea {
    width: 100%;
    margin: 8px 0;
    box-sizing: border-box;
    /* A long request scrolls inside the box. */
    max-height: 50vh;
    overflow: auto;
  }
  .flash {
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    margin-bottom: 10px;
  }
  .flash.bad {
    border-color: var(--bad, #c55);
  }
  .plan.old {
    opacity: 0.85;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
</style>
