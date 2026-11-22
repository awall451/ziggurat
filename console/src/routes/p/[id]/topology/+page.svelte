<script>
  import { goto } from '$app/navigation';
  import { num, usd, dur, between, when } from '$lib/format.js';
  import Graph from '$lib/components/Graph.svelte';
  import NodeDrawer from '$lib/components/NodeDrawer.svelte';

  let { data } = $props();
  const p = $derived(data.project);
  const tree = $derived(data.tree);
  const session = $derived(data.sessions.find((s) => s.id === data.picked) || null);

  let selectedId = $state('lead');
  const selected = $derived(tree?.nodes.find((n) => n.id === selectedId) || null);

  function pickSession(e) {
    const v = e.currentTarget.value;
    selectedId = 'lead';
    goto(v === 'follow' ? `/p/${p.id}/topology` : `/p/${p.id}/topology?s=${v}`, { keepFocus: true, noScroll: true });
  }

  const label = (s) =>
    `Cycle ${s.number} · ${s.live ? 'live' : s.state} · ${when(s.started)} · ${s.agents + 1} agents${s.costUsd != null ? ` · ${usd(s.costUsd)}` : ''}`;

  // The details panel can be made wider or narrower by dragging the bar
  // between it and the map. The width is remembered in this browser.
  const MIN_SIDE = 320;
  const MIN_MAP = 320;
  let sideW = $state(420);
  let splitEl = $state(null);
  let dragging = $state(false);
  try {
    const saved = Number(localStorage.getItem('topology.sideW'));
    if (saved >= MIN_SIDE && saved <= 4000) sideW = saved;
  } catch {
    /* no storage: the default width */
  }
  function clampW(w) {
    const total = splitEl?.getBoundingClientRect().width || 1400;
    return Math.round(Math.max(MIN_SIDE, Math.min(w, total - MIN_MAP - 12)));
  }
  function keep() {
    try {
      localStorage.setItem('topology.sideW', String(sideW));
    } catch {
      /* not kept */
    }
  }
  function dragStart(e) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging = true;
  }
  function dragMove(e) {
    if (!dragging || !splitEl) return;
    sideW = clampW(splitEl.getBoundingClientRect().right - e.clientX);
  }
  function dragEnd() {
    if (!dragging) return;
    dragging = false;
    keep();
  }
  function gutterKey(e) {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === 'ArrowLeft') sideW = clampW(sideW + step);
    else if (e.key === 'ArrowRight') sideW = clampW(sideW - step);
    else return;
    e.preventDefault();
    keep();
  }

  const counts = $derived(tree?.session.total.byStatus || {});
  const LEGEND = [
    ['running', 'Running'],
    ['waiting', 'Waiting on agents'],
    ['done', 'Done'],
    ['queued', 'Queued'],
    ['ending', 'Ending (outcome not pulled yet)'],
    ['interrupted', 'Interrupted'],
    ['failed', 'Failed']
  ];
</script>

{#if !tree}
  <div class="panel empty">
    <h2>No cycles recorded yet</h2>
    <p class="dim">The agent tree appears here once the {p.tiers[0]} has run a cycle and its transcripts have been pulled.</p>
  </div>
{:else}
  <div class="split" class:open={!!selected} class:dragging bind:this={splitEl} style:--side-w="{sideW}px">
    <section class="canvas panel">
      <div class="over top">
        <label class="picker">
          <span class="dim small">Cycle</span>
          <select class="field" onchange={pickSession} value={data.following ? 'follow' : data.picked}>
            <option value="follow">Latest{session && data.following ? `: ${label(session)}` : ''}</option>
            {#each data.sessions as s (s.id)}
              <option value={s.id}>{label(s)}</option>
            {/each}
          </select>
        </label>
      </div>

      <Graph nodes={tree.nodes} tiers={p.tiers} selected={selectedId} onselect={(id) => (selectedId = id)} fitKey={data.picked} />

      <div class="over bottom">
        <div class="legend small">
          {#each LEGEND as [k, word] (k)}
            {#if counts[k]}
              <span class="s-{k}"><span class="dot"></span>{counts[k]} {word.toLowerCase()}</span>
            {/if}
          {/each}
        </div>
        <div class="small dim mono">
          {tree.session.agents} agents · {num(tree.session.total.toolCalls)} tool calls · {usd(tree.session.total.costUsd)} estimate
          {#if tree.session.ended}· {dur(between(tree.session.started, tree.session.ended))}{/if}
          {#if tree.session.claudeVersion}· Claude Code {tree.session.claudeVersion}{/if}
          {#if tree.session.chat}· <a href="/p/{p.id}/backlog">{tree.session.chat.turns} chat turn{tree.session.chat.turns > 1 ? 's' : ''} since, {usd(tree.session.chat.costUsd)}</a>{/if}
        </div>
      </div>
    </section>

    {#if selected}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="gutter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to resize the details panel"
        aria-valuenow={sideW}
        tabindex="0"
        title="Drag to resize. Double-click for the default width."
        onpointerdown={dragStart}
        onpointermove={dragMove}
        onpointerup={dragEnd}
        onpointercancel={dragEnd}
        ondblclick={() => ((sideW = 420), keep())}
        onkeydown={gutterKey}
      ></div>
      <div class="side">
        <NodeDrawer
          node={selected}
          nodes={tree.nodes}
          tiers={p.tiers}
          live={tree.session.live}
          chat={tree.session.chat}
          chatHref="/p/{p.id}/backlog"
          onselect={(id) => (selectedId = id)}
          onclose={() => (selectedId = null)}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  .empty {
    padding: 32px;
  }
  .split {
    /* A fixed height, so the graph and the drawer scroll inside their own boxes. */
    flex: none;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    gap: 2px;
    height: calc(100vh - 56px - 196px);
    min-height: 480px;
  }
  .split.open {
    grid-template-columns: minmax(0, 1fr) 12px var(--side-w, 420px);
  }
  .split.dragging {
    user-select: none;
    cursor: col-resize;
  }
  .gutter {
    cursor: col-resize;
    position: relative;
    touch-action: none;
  }
  .gutter::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 4px;
    width: 4px;
    height: 48px;
    transform: translateY(-50%);
    border-radius: 2px;
    background: var(--line);
  }
  .gutter:hover::after,
  .gutter:focus-visible::after,
  .split.dragging .gutter::after {
    background: var(--accent);
    height: 96px;
  }
  .canvas {
    position: relative;
    overflow: hidden;
    background: rgba(6, 16, 31, 0.8);
    min-height: 0;
  }
  .side {
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }
  .over {
    position: absolute;
    left: 14px;
    right: 60px;
    z-index: 5;
    pointer-events: none;
  }
  .over > * {
    pointer-events: auto;
  }
  .over.top {
    top: 12px;
  }
  .over.bottom {
    bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .picker {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
  }
  .picker select {
    max-width: min(560px, 70vw);
  }
  .legend {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }
  @media (max-width: 1000px) {
    .split,
    .split.open {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto;
      height: auto;
    }
    .gutter {
      display: none;
    }
    .canvas {
      height: 60vh;
    }
    .side {
      height: auto;
    }
  }
</style>
