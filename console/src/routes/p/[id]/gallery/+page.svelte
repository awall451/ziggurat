<script>
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';
  import MarkupEditor from '$lib/components/MarkupEditor.svelte';

  let { data } = $props();
  const p = $derived(data.project);

  let setKey = $state(null);
  let buildIdx = $state(0);
  let other = $state('');
  let big = $state(null);
  let showAll = $state(false);

  // Tile width, like a file manager's thumbnail size. Kept per browser.
  const SIZES = { min: 200, max: 1000, step: 50, start: 300 };
  const stored = () => {
    try {
      const n = Number(localStorage.getItem('gallery-tile'));
      return n >= SIZES.min && n <= SIZES.max ? n : SIZES.start;
    } catch {
      return SIZES.start;
    }
  };
  let tile = $state(stored());
  function resize(n) {
    tile = n;
    try {
      localStorage.setItem('gallery-tile', String(n));
    } catch {
      // private window: the size lasts for this visit only
    }
  }

  const cycles = $derived(data.sets.filter((x) => x.kind !== 'day'));
  const days = $derived(data.sets.filter((x) => x.kind === 'day'));
  const set = $derived(data.sets.find((x) => x.key === setKey) || data.sets[0] || null);
  const current = $derived(set ? set.builds[Math.min(buildIdx, set.builds.length - 1)] : null);
  const compareSet = $derived(data.sets.find((x) => x.key === other) || null);
  const compare = $derived(compareSet ? compareSet.builds[0] : null);
  // A cycle shows what it made or changed; the older day folders have no such record.
  const why = $derived(new Map((current?.fresh || []).map((x) => [x.file, x.why])));
  const partial = $derived(!!current?.fresh && current.fresh.length < current.files.length);
  const shown = $derived(!current ? [] : partial && !showAll ? current.files.filter((f) => why.has(f)) : current.files);
  const src = (folder, file) => `/p/${p.id}/media/shots/${folder}/${encodeURIComponent(file)}`;
  const title = (file) => file.replace(/\.png$/, '').replace(/^\d+-/, '').replace(/[-_]/g, ' ');

  const at = (iso) =>
    iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const KIND = { plan: 'planning', oneshot: 'one-shot job', normal: '' };
  const label = (x) => {
    if (x.kind === 'day') return x.date;
    if (x.kind === 'setup') return 'Setup (before the first cycle)';
    const bits = [x.number != null ? `Cycle ${x.number}` : 'Cycle', at(x.start)];
    if (KIND[x.kind]) bits.push(KIND[x.kind]);
    if (x.live) bits.push('running');
    bits.push(`${x.builds.length} build${x.builds.length > 1 ? 's' : ''}`);
    return bits.join(' · ');
  };
  const buildLabel = (b, i) => `${i === 0 ? 'Newest · ' : ''}${at(b.at)} · ${b.topic || 'build'} · ${b.sha.slice(0, 7)}`;

  function pickSet(key) {
    setKey = key;
    buildIdx = 0;
    showAll = false;
    if (other === key) other = '';
  }

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
      body: JSON.stringify({ title: t, body, kind, markup, markupPng, date: current.folder, file })
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
    <p class="dim">The gate's screenshots of every merged build appear here, grouped by the cycle that made them.</p>
  </div>
{:else}
  <div class="bar">
    <label>
      <span class="dim small">Cycle</span>
      <select class="field" value={set.key} onchange={(e) => pickSet(e.currentTarget.value)}>
        {#if cycles.length}
          <optgroup label="Cycles">
            {#each cycles as x (x.key)}<option value={x.key}>{label(x)}</option>{/each}
          </optgroup>
        {/if}
        {#if days.length}
          <optgroup label="Older, by day">
            {#each days as x (x.key)}<option value={x.key}>{label(x)}</option>{/each}
          </optgroup>
        {/if}
      </select>
    </label>
    {#if set.builds.length > 1}
      <label>
        <span class="dim small">Build</span>
        <select class="field" value={buildIdx} onchange={(e) => (buildIdx = Number(e.currentTarget.value))}>
          {#each set.builds as b, i (b.folder)}<option value={i}>{buildLabel(b, i)}</option>{/each}
        </select>
      </label>
    {/if}
    <label>
      <span class="dim small">Compare with</span>
      <select class="field" bind:value={other}>
        <option value="">Nothing</option>
        {#each data.sets.filter((x) => x.key !== set.key) as x (x.key)}<option value={x.key}>{label(x)}</option>{/each}
      </select>
    </label>
    {#if partial}
      <button class="btn quiet" onclick={() => (showAll = !showAll)} aria-pressed={showAll}>{showAll ? 'Show only new and changed' : `Show all ${current.files.length}`}</button>
    {/if}
    <span class="dim small">
      {#if current.sha}
        {current.fresh ? `${current.fresh.length} new or changed of ` : ''}{current.files.length} screenshots of {current.topic || 'a build'} ({current.sha.slice(0, 7)}), merged {at(current.at)}{#if current.removed}
          · {current.removed} removed{/if}
      {:else}
        {current.files.length} screenshots from the newest passing build on {current.folder}
      {/if}
    </span>
    <label class="size">
      <span class="dim small">Size</span>
      <input type="range" min={SIZES.min} max={SIZES.max} step={SIZES.step} value={tile} oninput={(e) => resize(Number(e.currentTarget.value))} aria-label="Screenshot size" />
    </label>
    {#if flash}<span class="small s-done">{flash} <a href="/p/{p.id}/issues">Open Issues</a></span>{/if}
  </div>

  {#if !shown.length}
    <div class="panel empty">
      <h2>Nothing new in this cycle</h2>
      <p class="dim">
        All {current.files.length} screenshots are the same as in the build before.
        <button class="link" onclick={() => (showAll = true)}>Show all</button>
      </p>
    </div>
  {/if}

  <div class="shots" style="--tile: {tile}px">
    {#each shown as f (f)}
      <figure class="panel">
        <div class="pair" class:two={compare}>
          {#if compare}
            {#if compare.files.includes(f)}
              <button onclick={() => (big = src(compare.folder, f))} aria-label="Enlarge {title(f)} from {label(compareSet)}">
                <img src={src(compare.folder, f)} alt="{title(f)}, {label(compareSet)}" loading="lazy" />
              </button>
            {:else}
              <div class="none small dim">not in {label(compareSet)}</div>
            {/if}
          {/if}
          <button onclick={() => (big = src(current.folder, f))} aria-label="Enlarge {title(f)}">
            <img src={src(current.folder, f)} alt={title(f)} loading="lazy" />
          </button>
        </div>
        <figcaption class="small">
          <span class="opts">
            <button class="ham" aria-label="Options for {title(f)}" aria-haspopup="menu" aria-expanded={menu === f} onclick={(e) => { e.stopPropagation(); menu = menu === f ? null : f; }}>☰</button>
            {#if menu === f}
              <div class="menu panel lit" role="menu">
                <button role="menuitem" onclick={() => { menu = null; noting = f; }}>Leave a note…</button>
                {#if dot(f)}<a role="menuitem" href="/p/{p.id}/issues">View issues ({dot(f).text})</a>{/if}
                <button role="menuitem" onclick={() => { menu = null; big = src(current.folder, f); }}>Open full size</button>
              </div>
            {/if}
          </span>
          <span class="name">{title(f)}</span>
          {#if partial && why.has(f)}<span class="why {why.get(f)}">{why.get(f)}</span>{/if}
          {#if dot(f)}<span class="dot {dot(f).cls}" title={dot(f).text} aria-label={dot(f).text}></span>{/if}
        </figcaption>
      </figure>
    {/each}
  </div>
{/if}

{#if noting}
  <MarkupEditor src={src(current.folder, noting)} name={title(noting)} onsave={(d) => raise(noting, d)} oncancel={() => (noting = null)} />
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
  .size {
    margin-left: auto;
  }
  .size input {
    width: 140px;
    accent-color: var(--ink);
  }
  .shots {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(var(--tile, 300px), 100%), 1fr));
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
  .why {
    padding: 1px 7px;
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    font-size: 11px;
    color: var(--ink);
  }
  .why.changed {
    border-color: var(--warn);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
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
