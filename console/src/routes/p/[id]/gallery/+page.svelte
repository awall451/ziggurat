<script>
  import Icon from '$lib/components/Icon.svelte';

  let { data } = $props();
  const p = $derived(data.project);

  let day = $state(null);
  let other = $state('');
  let big = $state(null);

  const dates = $derived(data.days.map((d) => d.date));
  const current = $derived(data.days.find((d) => d.date === day) || data.days[0] || null);
  const compare = $derived(data.days.find((d) => d.date === other) || null);
  const src = (date, file) => `/p/${p.id}/media/shots/${date}/${encodeURIComponent(file)}`;
  const title = (file) => file.replace(/\.png$/, '').replace(/^\d+-/, '').replace(/[-_]/g, ' ');

  function key(e) {
    if (e.key === 'Escape') big = null;
  }
</script>

<svelte:window onkeydown={key} />

{#if !current}
  <div class="panel empty">
    <h2>No screenshots yet</h2>
    <p class="dim">Screenshots taken by the gate for the newest passing build are pulled here each day.</p>
  </div>
{:else}
  <div class="bar">
    <label>
      <span class="dim small">Day</span>
      <select class="field" value={current.date} onchange={(e) => (day = e.currentTarget.value)}>
        {#each dates as d (d)}<option value={d}>{d}</option>{/each}
      </select>
    </label>
    <label>
      <span class="dim small">Compare with</span>
      <select class="field" bind:value={other}>
        <option value="">Nothing</option>
        {#each dates.filter((d) => d !== current.date) as d (d)}<option value={d}>{d}</option>{/each}
      </select>
    </label>
    <span class="dim small">{current.files.length} screenshots from the newest passing build on {current.date}</span>
  </div>

  <div class="shots">
    {#each current.files as f (f)}
      <figure class="panel">
        <div class="pair" class:two={compare}>
          {#if compare}
            {#if compare.files.includes(f)}
              <button onclick={() => (big = src(compare.date, f))} aria-label="Enlarge {title(f)} from {compare.date}">
                <img src={src(compare.date, f)} alt="{title(f)}, {compare.date}" loading="lazy" />
              </button>
            {:else}
              <div class="none small dim">not in {compare.date}</div>
            {/if}
          {/if}
          <button onclick={() => (big = src(current.date, f))} aria-label="Enlarge {title(f)}">
            <img src={src(current.date, f)} alt={title(f)} loading="lazy" />
          </button>
        </div>
        <figcaption class="small">{title(f)}</figcaption>
      </figure>
    {/each}
  </div>
{/if}

{#if big}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot">
    <button class="shade" onclick={() => (big = null)} aria-label="Close"></button>
    <img src={big} alt="Enlarged screenshot" />
    <button class="close btn" onclick={() => (big = null)}><Icon name="x" size={14} /> Close</button>
  </div>
{/if}

<style>
  .empty {
    padding: 32px;
  }
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
  .shots {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 14px;
  }
  figure {
    margin: 0;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
  .pair.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .pair button {
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #000;
    cursor: zoom-in;
    overflow: hidden;
    display: flex;
  }
  img {
    width: 100%;
    height: auto;
    display: block;
    image-rendering: pixelated;
  }
  .none {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--line);
    border-radius: 6px;
    min-height: 80px;
  }
  figcaption {
    color: var(--ink-2);
    text-transform: capitalize;
  }
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }
  .shade {
    position: absolute;
    inset: 0;
    background: rgba(2, 6, 14, 0.88);
    border: 0;
    cursor: zoom-out;
  }
  .lightbox img {
    position: relative;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    min-width: min(960px, 90vw);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    box-shadow: 0 0 40px rgba(var(--glow), 0.3);
  }
  .close {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
</style>
