<script>
  import { num, usd, dur, between, ago } from '$lib/format.js';
  import Icon from '$lib/components/Icon.svelte';

  let { data } = $props();

  let showHidden = $state(false);
  try {
    showHidden = localStorage.getItem('zc.showHidden') === '1';
  } catch {
    /* storage may be unavailable */
  }
  function toggle(e) {
    showHidden = e.currentTarget.checked;
    try {
      localStorage.setItem('zc.showHidden', showHidden ? '1' : '0');
    } catch {
      /* fine without it */
    }
  }

  const shown = $derived(data.projects.filter((p) => showHidden || !p.hidden));
  const count = (state) => data.projects.filter((p) => !p.hidden && p.status.state === state).length;
  const hiddenCount = $derived(data.projects.filter((p) => p.hidden).length);

  const STATE_WORD = { running: 'Running', idle: 'Idle', halted: 'Halted', unreachable: 'Unreachable', checking: 'Checking' };
</script>

<div class="page">
  <div class="head">
    <h1>Your fleets</h1>
    <span class="dim small mono">{count('running')} running · {count('halted')} halted · {count('idle')} idle · {hiddenCount} hidden</span>
    <span class="grow"></span>
    {#if hiddenCount}
      <label class="check"><input type="checkbox" checked={showHidden} onchange={toggle} /> Show hidden</label>
    {/if}
    {#if data.deploy}<a class="btn new" href="/new">New project</a>{/if}
  </div>

  {#if !shown.length}
    <div class="panel empty">
      <h2>No projects yet</h2>
      <p class="dim">Add one under <a href="/settings">Settings</a>, or in <span class="mono">projects.json</span> in the console's config folder.</p>
    </div>
  {/if}

  <div class="cards">
    {#each shown as p (p.id)}
      <a class="card panel" class:hid={p.hidden} class:live={p.status.state === 'running'} href="/p/{p.id}/topology" style="--accent: {p.accent}">
        <div class="top">
          <span class="glyph"><Icon name="ziggurat" size={38} /></span>
          <div class="name">
            <h2>{p.name}</h2>
            <div class="small dim">{p.description}{p.description ? ' · ' : ''}{p.theme}</div>
          </div>
          {#if p.hidden}
            <span class="pill idle">Hidden</span>
          {:else}
            <span class="pill {p.status.state === 'checking' ? 'idle' : p.status.state}">{STATE_WORD[p.status.state] || p.status.state}</span>
          {/if}
        </div>

        <div class="tiers well">
          <div class="steps" aria-hidden="true">
            <span style="width:22%" class:on={p.status.leadActive}></span>
            <span style="width:58%" class:on={p.status.leadActive}></span>
            <span style="width:94%" class:on={p.status.leadActive}></span>
          </div>
          <div class="tier-names small mono dim">
            {#each p.tiers as t}<span>{t}</span>{/each}
          </div>
        </div>

        <dl>
          <div>
            <dt>{p.status.leadActive ? 'Cycle' : 'Last cycle'}</dt>
            <dd class="mono">
              {#if p.cycle}
                {p.cycle.number}
                {#if p.status.leadActive}· {dur(between(p.cycle.started, new Date(p.now).toISOString()))}{:else}· {p.cycle.state}{/if}
              {:else}–{/if}
            </dd>
          </div>
          <div>
            <dt>Gate main</dt>
            <dd class="mono">{p.status.main?.sha || '–'}</dd>
          </div>
          {#if p.publish.remote}
            <div>
              <dt>Published</dt>
              <dd class="mono">
                {#if p.publish.blocked}<span class="s-failed" title={p.publish.blocked.reason}>refused</span>{:else}{p.publish.sha ? p.publish.sha.slice(0, 7) : '–'}{/if}
              </dd>
            </div>
          {/if}
          <div>
            <dt>Tests</dt>
            <dd class="mono">{num(p.summary.testsNow)}</dd>
          </div>
          <div>
            <dt>Last 24 h, estimate</dt>
            <dd class="mono">{usd(p.summary.last24.costUsd)}</dd>
          </div>
          <div>
            <dt>Merged / failed</dt>
            <dd class="mono"><span class="s-done">{p.summary.last24.merged}</span> / <span class:s-failed={p.summary.last24.failed > 0}>{p.summary.last24.failed}</span></dd>
          </div>
          <div>
            <dt>Waiting on you</dt>
            <dd class:attn={p.asks + p.summary.escalations > 0}>
              {[p.asks ? `${p.asks} question${p.asks > 1 ? 's' : ''}` : '', p.summary.escalations ? `${p.summary.escalations} escalation${p.summary.escalations > 1 ? 's' : ''}` : '']
                .filter(Boolean)
                .join(' · ') || 'Nothing'}
            </dd>
          </div>
        </dl>

        {#if p.status.state === 'unreachable'}
          <div class="small s-failed">VM not reachable. Showing the last pulled data.</div>
        {:else if p.status.state === 'halted'}
          <div class="small dim clip" title={p.status.control}>{p.status.control}</div>
        {:else if p.summary.lastCycle?.end}
          <div class="small dim">Last cycle ended {ago(p.summary.lastCycle.end, p.now)}</div>
        {/if}
      </a>
    {/each}
  </div>
</div>

<style>
  .page {
    padding: 32px 24px;
    max-width: 1500px;
    width: 100%;
    margin: 0 auto;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .grow {
    flex: 1;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    color: var(--ink-2);
    font-size: 13px;
    cursor: pointer;
  }
  .check input {
    width: 16px;
    height: 16px;
    accent-color: var(--cyan);
  }
  .empty {
    padding: 32px;
  }
  .new {
    display: inline-flex;
    align-items: center;
    color: var(--ink);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 20px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    color: var(--ink);
    border: 1.5px solid color-mix(in srgb, var(--accent) 55%, var(--line));
    transition: box-shadow 0.2s, transform 0.2s;
  }
  .card:hover {
    color: var(--ink);
    box-shadow: 0 0 34px color-mix(in srgb, var(--accent) 40%, transparent);
    transform: translateY(-2px);
  }
  .card.live {
    border-color: var(--accent);
    box-shadow: 0 0 30px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .card.hid {
    border-style: dashed;
    border-color: var(--line);
    opacity: 0.75;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .glyph {
    color: var(--accent);
    display: flex;
    filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 60%, transparent));
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .name h2 {
    font-size: 20px;
  }
  .tiers {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    padding: 12px 14px;
  }
  .steps {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .steps span {
    height: 12px;
    background: #17385f;
  }
  .steps span.on:nth-child(1) {
    background: var(--accent);
  }
  .steps span.on:nth-child(2) {
    background: var(--cyan);
  }
  .steps span.on:nth-child(3) {
    background: #2a6ea8;
  }
  .tier-names {
    display: flex;
    flex-direction: column;
    gap: 0;
    line-height: 16px;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--ink-2);
    font-size: 12px;
  }
  dd {
    margin: 0;
  }
  .attn {
    color: var(--warn);
    font-weight: 500;
  }
  .clip {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
