<script>
  import { goto } from '$app/navigation';
  import { md } from '$lib/md.js';
  import { usd, dur, STATUS_WORD } from '$lib/format.js';

  let { data } = $props();
  const p = $derived(data.project);
  const current = $derived(data.cycles.find((c) => c.id === data.picked) || null);

  const at = (iso) =>
    iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const label = (c) =>
    `Cycle ${c.number} · ${at(c.started)} · ${c.live ? 'running' : STATUS_WORD[c.state] || c.state}${c.costUsd != null ? ` · ${usd(c.costUsd)}` : ''}${!c.live && !c.brief ? ' · no brief yet' : ''}`;

  function pick(id) {
    goto(`?s=${id}`, { keepFocus: true, noScroll: true });
  }
</script>

{#if !current}
  <div class="panel block">
    <h2>No cycles yet</h2>
    <p class="dim">A brief appears here for every cycle {p.tiers[0]} finishes.</p>
  </div>
{:else}
  <div class="bar">
    <label>
      <span class="dim small">Cycle</span>
      <select class="field" value={current.id} onchange={(e) => pick(e.currentTarget.value)}>
        {#each data.cycles as c (c.id)}<option value={c.id}>{label(c)}</option>{/each}
      </select>
    </label>
    {#if current.mp3}
      {#key current.id}
        <audio controls preload="none" src="/p/{p.id}/media/briefs/{current.id}.mp3"></audio>
      {/key}
    {:else if current.brief}
      <span class="dim small">No spoken version for this cycle.</span>
    {/if}
  </div>

  <article class="panel block">
    <header>
      <h2>Cycle {current.number}</h2>
      <div class="small dim">
        {at(current.started)}{#if current.ended}{' to '}{at(current.ended)}{/if}
        {#if current.secs} · {dur(current.secs)}{/if}
        {#if current.costUsd != null} · {usd(current.costUsd)} API-equivalent{/if}
        · {current.agents + 1} agents ·
        <a href="/p/{p.id}/topology?s={current.id}">Open in Topology</a>
      </div>
    </header>
    {#if current.live}
      <p class="dim">This cycle is still running. Its brief is written about 20 minutes after it ends, once the gate has judged its work.</p>
    {:else if data.brief}
      <!-- sanitised by md(): the brief is written from agent output -->
      <div class="md">{@html md(data.brief)}</div>
    {:else}
      <p class="dim small">
        No brief for this cycle yet: it is written about 20 minutes after a cycle ends, by the workstation's brief job. Until then, here is {p.tiers[0]}'s
        own final report.
      </p>
      {#if data.report}
        <div class="md report">{@html md(data.report)}</div>
      {:else}
        <p class="dim">No final report in the pulled transcript.</p>
      {/if}
    {/if}
  </article>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .bar label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  select {
    max-width: min(560px, 100%);
  }
  audio {
    height: 36px;
    max-width: 100%;
  }
  .block {
    padding: 20px 24px;
    max-width: 900px;
  }
  header {
    margin-bottom: 12px;
  }
  h2 {
    margin: 0 0 4px;
  }
  .report {
    border-left: 2px solid var(--line);
    padding-left: 12px;
  }
</style>
