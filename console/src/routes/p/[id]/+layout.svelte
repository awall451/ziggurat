<script>
  import { page } from '$app/state';
  import { invalidateAll } from '$app/navigation';
  import { num, usd, dur, between, ago } from '$lib/format.js';
  import Icon from '$lib/components/Icon.svelte';

  let { data, children } = $props();
  const p = $derived(data.project);
  const base = $derived(`/p/${p.id}`);

  const TABS = [
    ['topology', 'Topology'],
    ['progress', 'Progress'],
    ['inbox', 'Inbox'],
    ['notes', 'Notes'],
    ['gallery', 'Gallery'],
    ['digest', 'Digest'],
    ['usage', 'Usage'],
    ['controls', 'Controls']
  ];
  // What needs the owner: questions from the lead plus escalations in the repo.
  const waiting = $derived(p.asks + p.summary.escalations);
  const waitingText = $derived(
    [p.asks ? `${p.asks} question${p.asks > 1 ? 's' : ''}` : '', p.summary.escalations ? `${p.summary.escalations} escalation${p.summary.escalations > 1 ? 's' : ''}` : '']
      .filter(Boolean)
      .join(' · ') || 'Nothing'
  );
  const current = $derived(page.url.pathname.split('/')[3] || 'topology');

  const STATE_WORD = { running: 'Running', idle: 'Idle', halted: 'Halted', unreachable: 'Unreachable', checking: 'Checking' };

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
        <span class="pill {p.status.state === 'checking' ? 'idle' : p.status.state}">{STATE_WORD[p.status.state] || p.status.state}</span>
        {#if p.status.leadActive && p.cycle}
          <span class="mono small dim">cycle {p.cycle.number} · {dur(between(p.cycle.started, new Date(p.now).toISOString()))}</span>
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

  {#if p.status.state === 'unreachable'}
    <div class="note s-failed">VM not reachable{p.status.error ? ` (${p.status.error})` : ''}. Showing the last pulled data.</div>
  {:else if p.status.state === 'halted'}
    <div class="note dim">Halted: <span class="mono">{p.status.control}</span></div>
  {/if}

  <div class="tabs">
    {#each TABS as [slug, label] (slug)}
      <a class="tab" class:on={current === slug} href="{base}/{slug}" aria-current={current === slug ? 'page' : null}>
        {label}{#if slug === 'inbox' && p.asks}<span class="count">{p.asks}</span>{/if}
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
  .icon {
    min-height: 32px;
    width: 32px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .body {
    flex: 1;
    min-height: 0;
    padding: 16px 24px 24px;
    display: flex;
    flex-direction: column;
  }
</style>
