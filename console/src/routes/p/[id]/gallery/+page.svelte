<script>
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';
  import MarkupEditor from '$lib/components/MarkupEditor.svelte';

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

  // Same rule as the server's screenKey(): a note belongs to the screen, not the file.
  const screen = (file) => file.replace(/\.png$/i, '').replace(/^\d+-/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const dot = (file) => {
    const s = data.issues?.[screen(file)];
    if (!s) return null;
    return s.open ? { cls: 'open', text: `${s.open} open issue${s.open > 1 ? 's' : ''}` } : { cls: 'resolved', text: `${s.resolved} resolved issue${s.resolved > 1 ? 's' : ''}` };
  };

  let menu = $state(null);
  let noting = $state(null);
  let flash = $state('');

  async function raise(file, { title: t, body, kind, markup, blob }) {
    let markupPng = null;
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      markupPng = btoa(bin);
    }
    const r = await fetch(`/p/${p.id}/gallery/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: t, body, kind, markup, markupPng, date: current.date, file })
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.message || 'Could not raise the issue');
    noting = null;
    flash = res.delivered ? 'Issue raised and sent to the lead.' : 'Issue raised. It will be sent when the VM is reachable (retry from the Issues tab).';
    await invalidateAll();
  }

  function key(e) {
    if (e.key === 'Escape') {
      big = null;
      menu = null;
    }
  }
</script>

<svelte:window onkeydown={key} onclick={() => (menu = null)} />

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
    {#if flash}<span class="small s-done">{flash} <a href="/p/{p.id}/issues">Open Issues</a></span>{/if}
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
        <figcaption class="small">
          <span class="opts">
            <button class="ham" aria-label="Options for {title(f)}" aria-haspopup="menu" aria-expanded={menu === f} onclick={(e) => { e.stopPropagation(); menu = menu === f ? null : f; }}>☰</button>
            {#if menu === f}
              <div class="menu panel lit" role="menu">
                <button role="menuitem" onclick={() => { menu = null; noting = f; }}>Leave a note…</button>
                {#if dot(f)}<a role="menuitem" href="/p/{p.id}/issues">View issues ({dot(f).text})</a>{/if}
                <button role="menuitem" onclick={() => { menu = null; big = src(current.date, f); }}>Open full size</button>
              </div>
            {/if}
          </span>
          <span class="name">{title(f)}</span>
          {#if dot(f)}<span class="dot {dot(f).cls}" title={dot(f).text} aria-label={dot(f).text}></span>{/if}
        </figcaption>
      </figure>
    {/each}
  </div>
{/if}

{#if noting}
  <MarkupEditor src={src(current.date, noting)} name={title(noting)} onsave={(d) => raise(noting, d)} oncancel={() => (noting = null)} />
{/if}

{#if big}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot">
    <button class="shade" onclick={() => (big = null)} aria-label="Close"></button>
    <img src={big} alt="Enlarged screenshot" />
    <button class="close btn quiet" onclick={() => (big = null)}><Icon name="x" size={14} /> Close</button>
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
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    text-transform: capitalize;
  }
  .opts {
    position: relative;
    display: flex;
  }
  .ham {
    width: 24px;
    height: 22px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    line-height: 1;
  }
  .ham:hover,
  .ham[aria-expanded='true'] {
    color: var(--ink);
    border-color: var(--line);
  }
  .menu {
    position: absolute;
    bottom: 26px;
    left: 0;
    z-index: 20;
    min-width: 180px;
    padding: 4px;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    background: var(--panel-solid);
  }
  .menu > * {
    text-align: left;
    padding: 7px 10px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    font: inherit;
  }
  .menu > *:hover {
    background: rgba(var(--glow), 0.14);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
  }
  .dot.open {
    background: var(--warn);
    box-shadow: 0 0 8px var(--warn);
  }
  .dot.resolved {
    background: var(--good);
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
