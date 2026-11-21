<script>
  // The backlog: the owner asks the lead to find what to do next (a planning
  // cycle, no code), reviews the proposals with their estimates, talks them
  // over with the lead, and runs an approved item now or at a set time.
  // Everything shown from the lead was written by an agent and checked on the
  // server; text is rendered through the sanitising markdown helper.
  import { invalidateAll } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ago, usd } from '$lib/format.js';
  import { md } from '$lib/md.js';
  import { instantOf, wallClock, clockLabel, zoneLabel } from '$lib/schedule.js';

  let { data } = $props();
  const p = $derived(data.project);
  const base = $derived(`/p/${p.id}`);
  const plans = $derived(data.backlog.plans);
  const newest = $derived(plans.find((x) => x.newest) || null);
  const lead = 'the lead';

  let busy = $state('');
  let flash = $state(null); // {ok, text}
  let focus = $state('');
  let planAt = $state('');
  let chatText = $state('');
  let atFor = $state(null); // pid whose time picker is open
  let atValue = $state('');
  let openPlan = $state(null);
  let chatBox = $state(null);

  const STATE_WORD = { new: 'New', approved: 'Approved', rejected: 'Rejected', revised: 'Revised: decide again' };
  const busyTeam = $derived(data.busy?.state === 'running' || !!data.busy?.oneshot || !!data.busy?.chat);
  const waiting = $derived(plans.some((x) => x.waiting || x.running) || !!data.busy?.chat);

  // While the lead works or answers, look again every 10 seconds.
  onMount(() => {
    const t = setInterval(() => {
      if (waiting && document.visibilityState === 'visible') post({ action: 'sync' }, '', { quiet: true });
    }, 10_000);
    return () => clearInterval(t);
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

  function startPlan() {
    let at = null;
    if (planAt) {
      at = epochOf(planAt);
      if (!at) return (flash = { ok: false, text: 'That time does not exist in your time zone' });
    }
    post({ action: 'plan', focus, at }, 'plan').then((out) => {
      if (out) {
        focus = '';
        planAt = '';
      }
    });
  }

  function runAt(pid) {
    const at = epochOf(atValue);
    if (!at) return (flash = { ok: false, text: 'Pick a date and time' });
    post({ action: 'run-at', pid, at }, `at-${pid}`).then((out) => {
      if (out) atFor = null;
    });
  }

  function edit(prop) {
    chatText = `About "${prop.title}" (${prop.pid}): `;
    chatBox?.focus();
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

<svelte:head><title>Backlog · {p.name}</title></svelte:head>

{#if !data.ready}
  <section class="panel block">
    <h2>Backlog</h2>
    {#if data.kitVersion}
      <p>The backlog needs kit 0.10.0 on this team's VM (it has {data.kitVersion}).</p>
    {:else}
      <p class="dim">The VM is not reachable right now.</p>
    {/if}
  </section>
{:else}
  {#if flash}<div class="flash small" class:bad={!flash.ok}>{flash.text}</div>{/if}

  <section class="panel block ask">
    <h2>Find what to do next</h2>
    <p class="small dim">
      One planning cycle: {lead} reads its notes and the code, writes <b>no code</b>, and proposes jobs of at most 90 minutes each, with an estimate of time
      and cost. The team's normal cycles carry on as before. Not while a cycle runs.
    </p>
    <textarea class="field" rows="3" placeholder="Optional: what to focus on (a feature, a part of the game, a problem)" bind:value={focus}></textarea>
    <div class="row">
      <button class="btn primary" disabled={!!busy || busyTeam} onclick={startPlan}>{planAt ? 'Set for that time' : 'Start planning now'}</button>
      <label class="small dim">or at <input class="field" type="datetime-local" bind:value={planAt} /></label>
      {#if busyTeam}<span class="small dim">The team is busy: {data.busy.chat ? 'the lead is answering a chat message' : data.busy.oneshot?.plan ? 'a planning cycle is running' : 'a cycle is running'}.</span>{/if}
    </div>
    {#each data.atJobs.filter((j) => j.plan) as j (j.id)}
      <div class="small">Planning cycle set for {whenText(j.at)} <button class="btn quiet" disabled={!!busy} onclick={() => post({ action: 'cancel-at', id: j.id }, 'cancel')}>Cancel</button></div>
    {/each}
  </section>

  {#if !plans.length}
    <p class="dim">No planning cycles yet.</p>
  {/if}

  {#each plans as plan (plan.id)}
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
        {#if !plan.newest}<button class="btn quiet" onclick={() => (openPlan = openPlan === plan.id ? null : plan.id)}>{openPlan === plan.id ? 'Hide' : 'Show'}</button>{/if}
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
            <article class="panel card {prop.state}">
              <header class="row">
                {#if prop.order != null}<span class="mono dim">{prop.order}.</span>{/if}
                <h3 class="grow">{prop.title}</h3>
                <span class="pill st">{prop.taken ? 'Taken by a cycle' : STATE_WORD[prop.state] || prop.state}</span>
              </header>
              <div class="est small">
                <span><b>{prop.minutes}</b> min</span>
                <span><b>{usd(prop.cost)}</b></span>
                <span class="conf {prop.confidence}">{prop.confidence} confidence</span>
                {#if prop.rev > 1}<span class="dim">revision {prop.rev}</span>{/if}
              </div>
              {#if prop.areas}<div class="small"><span class="dim">Areas:</span> {prop.areas}</div>{/if}
              {#if prop.risk}<div class="small"><span class="dim">Risk:</span> {prop.risk}</div>{/if}
              {#if prop.depends.length}<div class="small"><span class="dim">After:</span> {prop.depends.map((d) => title(plans, d)).join(', ')}</div>{/if}
              <div class="md small">{@html md(prop.text)}</div>
              <div class="row actions">
                {#if prop.state !== 'approved'}
                  <button class="btn" disabled={!!busy} onclick={() => post({ action: 'decide', pid: prop.pid, status: 'approved' }, prop.pid)}>Approve</button>
                {/if}
                {#if prop.state !== 'rejected'}
                  <button class="btn quiet" disabled={!!busy} onclick={() => post({ action: 'decide', pid: prop.pid, status: 'rejected' }, prop.pid)}>Reject</button>
                {/if}
                {#if plan.newest && !plan.ended}<button class="btn quiet" onclick={() => edit(prop)}>Change…</button>{/if}
                {#if prop.state === 'approved' && !prop.taken}
                  <span class="grow"></span>
                  {#if job}
                    <span class="small">Set for {whenText(job.at)}</span>
                    <button class="btn quiet" disabled={!!busy} onclick={() => post({ action: 'cancel-at', id: job.id }, 'cancel')}>Cancel</button>
                  {:else if prop.run && prop.run.rev === prop.rev && !prop.run.cancelled}
                    <a class="small" href="{base}/inbox">Job sent {ago(prop.run.at, p.now)}: see the Inbox</a>
                  {:else}
                    <button class="btn primary" disabled={!!busy || busyTeam} onclick={() => post({ action: 'run', pid: prop.pid }, `run-${prop.pid}`)}>Run now</button>
                    <button class="btn" disabled={!!busy} onclick={() => ((atFor = atFor === prop.pid ? null : prop.pid), (atValue = ''))}>Schedule…</button>
                  {/if}
                {/if}
              </div>
              {#if atFor === prop.pid}
                <div class="row small">
                  <input class="field" type="datetime-local" bind:value={atValue} />
                  <span class="dim">{zoneLabel(data.timezone)}</span>
                  <button class="btn" disabled={!!busy} onclick={() => runAt(prop.pid)}>Set</button>
                </div>
              {/if}
            </article>
          {/each}
        </div>

        {#if plan.newest && plan.done}
          <div class="chat">
            <h3>Talk it over with {lead}</h3>
            {#each plan.chat as c (c.id)}
              <div class="msg me small"><span class="dim">{c.by}, {ago(c.at, p.now)}</span><div class="pre">{c.text}</div></div>
              {#if c.reply}
                <div class="msg lead small" class:bad={c.reply.status === 'error'}>
                  <span class="dim">{lead}{#if c.cost != null}, {usd(c.cost)}{/if}</span>
                  <div class="md">{@html md(c.reply.text)}</div>
                </div>
              {:else if c.delivered}
                <div class="msg lead small dim">{lead} is answering…</div>
              {:else}
                <div class="msg small s-failed">Not sent{c.error ? `: ${c.error}` : ''}</div>
              {/if}
            {/each}
            {#if plan.ended}
              <p class="small dim">This chat is ended. Start a new planning cycle to plan again.</p>
            {:else}
              <textarea class="field" rows="3" bind:this={chatBox} bind:value={chatText} placeholder="Ask about a proposal, or ask {lead} to change, split or drop one"></textarea>
              <div class="row">
                <button class="btn primary" disabled={!!busy || busyTeam || !chatText.trim()} onclick={sendChat}>Send</button>
                <span class="small dim">Each message resumes the planning session for one answer (counts as usage, not as a cycle).</span>
                <span class="grow"></span>
                <button class="btn quiet" disabled={!!busy} onclick={() => post({ action: 'chat-end', plan: plan.id }, 'end')}>End chat</button>
              </div>
            {/if}
          </div>
        {/if}
      {/if}
    </section>
  {/each}
{/if}

<style>
  .block {
    padding: 18px;
    margin-bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    padding: 12px 14px;
  }
  .ask textarea,
  .chat textarea {
    margin: 0;
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
  h2,
  h3 {
    margin: 0;
  }
  .ask textarea,
  .chat textarea {
    width: 100%;
    margin: 8px 0;
    box-sizing: border-box;
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
  .card {
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .card.rejected {
    opacity: 0.55;
  }
  .card.approved {
    border-color: var(--accent);
  }
  .est {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .conf.low {
    color: var(--warn, #d9a441);
  }
  .actions {
    margin-top: auto;
  }
  .chat {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 10px;
    max-width: 80ch;
  }
  .msg.me {
    align-self: flex-end;
  }
  .msg.bad {
    border-color: var(--bad, #c55);
  }
</style>
