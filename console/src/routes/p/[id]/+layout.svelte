<script>
  import { page } from '$app/state';
  import { invalidateAll } from '$app/navigation';
  import { num, usd, dur, between, ago, idleText, waitingParts, stallText, pillState } from '$lib/format.js';
  import Icon from '$lib/components/Icon.svelte';
  import Popover from '$lib/components/Popover.svelte';
  import RunCycle from '$lib/components/RunCycle.svelte';
  import FocusDialog from '$lib/components/FocusDialog.svelte';

  let focusOpen = $state(false);
  const fwhen = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  // How a focus that has ended in the last day ended.
  const focusEnded = $derived(p.status.focus?.ended && !p.status.focus?.on && p.now / 1000 - p.status.focus.ended.at < 86400 ? p.status.focus.ended : null);

  let { data, children } = $props();
  const p = $derived(data.project);
  const base = $derived(`/p/${p.id}`);

  const TABS = [
    ['topology', 'Topology'],
    ['progress', 'Progress'],
    ['inbox', 'Inbox'],
    ['notes', 'Notes'],
    ['issues', 'Issues'],
    ['backlog', 'Planning'],
    ['gallery', 'Gallery'],
    ['briefs', 'Briefs'],
    ['usage', 'Usage'],
    ['controls', 'Controls']
  ];
  // What needs the owner: the lead's questions, escalations in the repo, package
  // requests and changes to the checks that the gate holds.
  const wait = $derived(waitingParts(p.waiting));
  const waiting = $derived(wait.total);
  const waitingText = $derived(wait.text);
  const current = $derived(page.url.pathname.split('/')[3] || 'topology');
  // The number on a tab: what waits there.
  const countOf = (slug) => (slug === 'inbox' ? wait.inbox : slug === 'issues' ? p.issues : slug === 'backlog' ? wait.backlog : 0) || 0;
  const currentLabel = $derived(TABS.find(([slug]) => slug === current)?.[1] || 'Menu');
  // Tabs that are not open and have something waiting: shown on the phone menu's button.
  const elsewhere = $derived(TABS.reduce((t, [slug]) => t + (slug === current ? 0 : countOf(slug)), 0));

  // Phone width: the tabs are in a menu. It closes when the page changes.
  let tabMenu = $state(false);
  $effect(() => {
    page.url.pathname;
    tabMenu = false;
  });

  const STATE_WORD = { running: 'Running', stalled: 'Stalled', idle: 'Idle', halted: 'Halted', unreachable: 'Unreachable', checking: 'Checking' };

  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    try {
      await fetch(`${base}/refresh`, { method: 'POST' });
      await invalidateAll();
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="head">
  <div class="strip">
    <div class="stat panel">
      <span class="k">State</span>
      <span class="v">
        <span class="pill {pillState(p.status)}" title={stallText(p.status.stalled, p.now) || null}>{STATE_WORD[pillState(p.status)] || p.status.state}</span>
        {#if p.status.leadActive && p.cycle}
          <span class="mono small dim">cycle {p.cycle.number} · {dur(between(p.cycle.started, new Date(p.now).toISOString()))}</span>
        {:else if p.runCycle?.can}
          <RunCycle id={p.id} name={p.name} rc={p.runCycle} quietNow={data.quietNow} small />
        {/if}
        {#if p.status.focus?.on}
          <span class="pill running" title="Cycles back to back">Focus</span>
        {:else if p.canFocus && p.status.state !== 'halted' && !p.status.focus?.paused && !data.focusNow}
          <button class="btn quiet sm" onclick={() => (focusOpen = true)} title="Cycles back to back for a while">◎ Focus…</button>
        {/if}
      </span>
    </div>
    <div class="stat panel">
      <span class="k">Gate main</span>
      <span class="v mono" title={p.status.main?.subject || ''}>{p.status.main?.sha || '–'}</span>
    </div>
    <div class="stat panel">
      <span class="k">Tests</span>
      <span class="v mono">{num(p.summary.testsNow)}</span>
    </div>
    <div class="stat panel">
      <span class="k">Last 24 h, estimate</span>
      <span class="v mono">{usd(p.summary.last24.costUsd)} <span class="dim small">· {p.summary.last24.cycles} cycles</span></span>
    </div>
    <div class="stat panel">
      <span class="k">Merged / failed, 24 h</span>
      <span class="v mono"><span class="s-done">{p.summary.last24.merged}</span> / <span class:s-failed={p.summary.last24.failed > 0}>{p.summary.last24.failed}</span></span>
    </div>
    <a class="stat panel" class:attn={waiting > 0} href="{base}/inbox">
      <span class="k">Waiting on you</span>
      <span class="v">{waitingText}</span>
    </a>
  </div>

  {#if p.status.focus?.on}
    {@const f = p.status.focus.on}
    <div class="note s-running">
      In focus: cycles back to back{f.until ? ` until ${fwhen(f.until)}` : f.cycles ? `, ${f.done} of ${f.cycles} cycles done` : ' until you switch it off'}, at most {f.perDay} a day. Stop it in the bar at the top.
    </div>
  {:else if p.status.focus?.paused}
    <div class="note dim">Paused while {p.status.focus.paused.for} is in focus, until {fwhen(p.status.focus.paused.until)} at the latest. Jobs and one-time cycles set for a time still run.</div>
  {:else if focusEnded}
    <div class="note dim">Focus ended {ago(new Date(focusEnded.at * 1000).toISOString(), p.now)}: {focusEnded.reason}.</div>
  {/if}
  {#if p.status.stalled && p.status.state !== 'unreachable'}
    <div class="note s-stalled" role="status">{stallText(p.status.stalled, p.now)}{p.status.stalled.chat ? ' (chat turn)' : ''}. The {p.status.stalled.reason === 'usage-limit' ? 'cycle carries on by itself once the window resets' : 'cycle may still recover; you can halt it under Controls'}.</div>
  {/if}
  {#if p.publish.blocked}
    <div class="note s-failed">Publish refused: {p.publish.blocked.reason} <a href="/p/{p.id}/controls#publishing">Publishing</a></div>
  {/if}
  {#if p.status.vmMismatch || p.status.vmShared}
    <div class="note s-failed" role="alert">
      <b>Not this project's VM.</b> {p.status.error} Every control and pull for {p.name} is stopped. Remove or fix this project in <a href="/settings">Settings</a>.
    </div>
  {:else if p.status.state === 'unreachable'}
    <div class="note s-failed">VM not reachable{p.status.error ? ` (${p.status.error})` : ''}. Showing the last pulled data.</div>
  {:else if p.status.state === 'halted'}
    <div class="note dim">Halted: <span class="mono">{p.status.control}</span></div>
  {:else if p.status.haltAfter}
    <div class="note dim">
      {p.status.leadActive ? 'Halting when this cycle ends' : 'The cycle is over: halting once the gate has run'}{p.status.haltAfter.wrapUp ? ' (wrap-up asked for)' : ''}. Cancel it under Controls.
    </div>
  {:else if p.status.oneshot}
    <div class="note dim">
      {p.status.oneshot.free ? 'A cycle you started is in progress.' : 'One-shot job in progress.'} {p.status.oneshot.runsOn ? 'The team goes back to running when this cycle ends.' : 'The team halts again when this cycle ends.'}
    </div>
  {:else if p.status.state === 'idle' && !p.status.focus?.on && idleText(p.status.idle, p.now)}
    <div class="note dim">{idleText(p.status.idle, p.now)}</div>
  {/if}

  {#if focusOpen}
    <FocusDialog id={p.id} name={p.name} cap={p.status.cap ?? null} typical={p.runCycle?.typical} onclose={() => (focusOpen = false)} ondone={() => (focusOpen = false)} />
  {/if}

  <div class="tabs">
    <span class="tabmenu">
      <Popover open={tabMenu} onclose={() => (tabMenu = false)} align="start">
        {#snippet trigger()}
          <button class="btn quiet" aria-label="Tabs: {currentLabel}" aria-haspopup="true" aria-expanded={tabMenu} onclick={() => (tabMenu = !tabMenu)}>
            {currentLabel}{#if elsewhere}<span class="count">{elsewhere}</span>{/if} ▾
          </button>
        {/snippet}
        {#each TABS as [slug, label] (slug)}
          <a class="menuitem" class:on={current === slug} href="{base}/{slug}" aria-current={current === slug ? 'page' : null}>
            {label}{#if countOf(slug)}<span class="count">{countOf(slug)}</span>{/if}
          </a>
        {/each}
      </Popover>
    </span>
    {#each TABS as [slug, label] (slug)}
      <a class="tab" class:on={current === slug} href="{base}/{slug}" aria-current={current === slug ? 'page' : null}>
        {label}{#if countOf(slug)}<span class="count">{countOf(slug)}</span>{/if}
      </a>
    {/each}
    <span class="grow"></span>
    <span class="small dim mono sync">
      {#if p.pull.pulling || refreshing}pulling…{:else if p.pull.pulledAt}data pulled {ago(p.pull.pulledAt, p.now)}{:else}not pulled yet{/if}
    </span>
    <button class="btn quiet icon" onclick={refresh} disabled={refreshing} aria-label="Pull fresh data now"><Icon name="refresh" size={16} /></button>
  </div>
  {#if p.pull.error}
    <div class="note s-failed small">Last pull had a problem: {p.pull.error}</div>
  {/if}
</div>

<div class="body">
  {@render children()}
</div>

<style>
  .head {
    padding: 12px 24px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 14px;
    border-radius: 10px;
    min-width: 0;
  }
  .stat.attn {
    border-color: var(--warn);
  }
  .stat.attn .v {
    color: var(--warn);
  }
  .k {
    font-size: 12px;
    color: var(--ink-2);
  }
  .v {
    font-size: 16px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    white-space: nowrap;
    overflow: hidden;
    /* the state with its buttons (Run a cycle, Focus) may need two lines */
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .note {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .tab {
    padding: 10px 16px;
    color: var(--ink-2);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover {
    color: var(--ink);
  }
  .count {
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent);
    color: #050b17;
    font-size: 12px;
    font-weight: 600;
  }
  a.stat {
    color: var(--ink);
  }
  .tab.on {
    color: #dff6ff;
    font-weight: 600;
    border-bottom-color: var(--accent);
  }
  .grow {
    flex: 1;
  }
  .sync {
    padding-right: 8px;
  }
  .body {
    flex: 1;
    min-height: 0;
    padding: 16px 24px 24px;
    display: flex;
    flex-direction: column;
  }
  .tabmenu {
    display: none;
  }
  /* Phone width: one button names the open tab and opens the list of tabs. */
  @media (max-width: 700px) {
    .head {
      padding: 12px 12px 0;
    }
    .body {
      padding: 12px 12px 16px;
    }
    .strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .tab {
      display: none;
    }
    .tabmenu {
      display: inline-flex;
    }
    .tabs {
      flex-wrap: nowrap;
      gap: 8px;
      padding-bottom: 8px;
    }
    .sync {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 0;
    }
  }
</style>
