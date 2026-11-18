<script>
  import { md } from '$lib/md.js';

  let { data } = $props();
  const p = $derived(data.project);
  let date = $state(null);
  const current = $derived(data.digests.find((d) => d.date === date) || data.digests[0] || null);
</script>

{#if !current}
  <div class="panel block">
    <h2>No digest yet</h2>
    <p class="dim">The morning digest is written once a day by the workstation's digest job.</p>
  </div>
{:else}
  <div class="bar">
    <label>
      <span class="dim small">Day</span>
      <select class="field" value={current.date} onchange={(e) => (date = e.currentTarget.value)}>
        {#each data.digests as d (d.date)}<option value={d.date}>{d.date}</option>{/each}
      </select>
    </label>
    {#if current.mp3}
      {#key current.date}
        <audio controls preload="none" src="/p/{p.id}/media/digests/{current.date}.mp3"></audio>
      {/key}
    {:else}
      <span class="dim small">No spoken version for this day.</span>
    {/if}
  </div>
  <article class="panel block">
    <!-- sanitised by md(): the digest is written from agent output -->
    <div class="md">{@html md(current.md)}</div>
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
  audio {
    height: 36px;
    max-width: 100%;
  }
  .block {
    padding: 20px 24px;
    max-width: 900px;
  }
  .block p {
    margin: 8px 0 0;
  }
</style>
