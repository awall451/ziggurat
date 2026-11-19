<script>
  // The working fleet as a stepped tree: lead on top, area leads below,
  // builders and scouts below them. Pan by dragging, zoom with the wheel.
  import { layoutTree } from '$lib/layout.js';
  import { modelShort, STATUS_WORD } from '$lib/format.js';
  import Icon from './Icon.svelte';

  let { nodes, tiers = [], selected = null, onselect = () => {}, fitKey = '' } = $props();

  const tree = $derived(layoutTree(nodes));

  let view = $state({ x: 0, y: 0, k: 1 });
  let box;
  let drag = null;
  let lastFit = null;

  function fit() {
    if (!box || !tree.width) return;
    const r = box.getBoundingClientRect();
    const k = Math.min(1.15, (r.width - 32) / tree.width, (r.height - 32) / tree.height);
    // A very wide cycle would shrink to unreadable: stop at a legible size and
    // keep the lead in the middle; the rest is reached by dragging.
    const kk = Math.max(0.6, k);
    const lead = tree.nodes.find((n) => n.depth === 0);
    const x = tree.width * kk <= r.width - 32 || !lead ? (r.width - tree.width * kk) / 2 : r.width / 2 - lead.x * kk;
    view = { k: kk, x, y: Math.max(12, (r.height - tree.height * kk) / 2) };
  }

  // Fit once per cycle shown, not on every refresh: the user's own pan and zoom
  // stay. Until the user moves the view, also refit when the box changes size.
  let touched = false;
  $effect(() => {
    if (box && tree.width && fitKey !== lastFit) {
      lastFit = fitKey;
      touched = false;
      fit();
    }
  });
  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver(() => {
      if (!touched) fit();
    });
    ro.observe(box);
    return () => ro.disconnect();
  });

  function zoom(factor, cx, cy) {
    touched = true;
    const k = Math.min(2.5, Math.max(0.25, view.k * factor));
    const f = k / view.k;
    view = { k, x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f };
  }

  function wheel(e) {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }

  function down(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    box.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!drag) return;
    touched = true;
    view = { ...view, x: e.clientX - drag.x, y: e.clientY - drag.y };
  }
  function up() {
    drag = null;
  }

  function zoomButton(factor) {
    const r = box.getBoundingClientRect();
    zoom(factor, r.width / 2, r.height / 2);
  }

  const active = (s) => s === 'running' || s === 'waiting';
</script>

<div
  class="graph"
  bind:this={box}
  onwheel={wheel}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  role="group"
  aria-label="Agent tree"
>
  <div class="world" style="width:{tree.width}px; height:{tree.height}px; transform: translate({view.x}px, {view.y}px) scale({view.k})">
    {#each tree.bands as b (b.depth)}
      <div class="band" style="left:{b.x}px; top:{b.y}px; width:{b.w}px; height:{b.h}px">
        <span class="band-name mono">{tiers[Math.min(b.depth, 2)] || ''}</span>
      </div>
    {/each}

    <svg class="links" width={tree.width} height={tree.height} aria-hidden="true">
      {#each tree.edges as e (e.id)}
        <path d={e.d} class="link l-{e.status}" />
        {#if active(e.status)}
          <circle r="3.5" class="pulse">
            <animateMotion dur="2.4s" repeatCount="indefinite" path={e.d} />
          </circle>
        {/if}
        <circle cx={e.x1} cy={e.y1} r="3.5" class="port" />
        <circle cx={e.x2} cy={e.y2} r="3" class="port" />
      {/each}
    </svg>

    {#each tree.nodes as n (n.id)}
      {#if n.depth >= 2}
        <button
          class="node circle n-{n.status}"
          class:selected={selected === n.id}
          style="left:{n.x - n.w / 2}px; top:{n.y}px; width:{n.w}px; height:{n.h}px"
          onclick={() => onselect(n.id)}
          aria-label="{n.label}: {n.description || ''}, {STATUS_WORD[n.status]}"
          title={n.description || n.label}
        >
          <Icon name={n.kind} size={24} />
        </button>
        <div class="caption" style="left:{n.x - 52}px; top:{n.y + n.h + 6}px">
          <span class="cap-name">{n.label}</span>
          <span class="cap-sub">{modelShort(n.model || n.requestedModel)} · <span class="s-{n.status}">{n.status}</span></span>
        </div>
      {:else}
        <button
          class="node tile t{n.depth} n-{n.status}"
          class:selected={selected === n.id}
          style="left:{n.x - n.w / 2}px; top:{n.y}px; width:{n.w}px; height:{n.h}px"
          onclick={() => onselect(n.id)}
        >
          {#if n.depth === 0}<span class="lead-icon"><Icon name="ziggurat" size={34} /></span>{/if}
          <span class="tile-text">
            <span class="tile-name">{n.label}</span>
            <span class="tile-desc">{n.depth === 0 ? `lead · ${modelShort(n.model)}` : n.description || n.rawType}</span>
            <span class="tile-sub">
              <span class="s-{n.status}">{STATUS_WORD[n.status]}</span>{#if n.depth > 0}&nbsp;· {modelShort(n.model || n.requestedModel)}{/if}
            </span>
          </span>
        </button>
      {/if}
      {#if n.status === 'done'}
        <span class="badge good" style="left:{n.x + n.w / 2 - 12}px; top:{n.y - 8}px"><Icon name="check" size={12} /></span>
      {:else if n.status === 'failed'}
        <span class="badge bad" style="left:{n.x + n.w / 2 - 12}px; top:{n.y - 8}px"><Icon name="x" size={12} /></span>
      {/if}
    {/each}
  </div>

  <div class="tools">
    <button class="tool" onclick={() => zoomButton(1.2)} aria-label="Zoom in"><Icon name="plus" size={16} /></button>
    <button class="tool" onclick={() => zoomButton(1 / 1.2)} aria-label="Zoom out"><Icon name="minus" size={16} /></button>
    <button class="tool" onclick={() => { touched = false; fit(); }} aria-label="Fit to view"><Icon name="fit" size={16} /></button>
  </div>
</div>

<style>
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 420px;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .graph:active {
    cursor: grabbing;
  }
  .world {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }
  .band {
    position: absolute;
    background: rgba(60, 140, 240, 0.06);
    border: 1px solid rgba(var(--glow), 0.14);
    border-top: 1px solid rgba(var(--glow), 0.55);
    box-shadow: 0 -1px 18px rgba(var(--glow), 0.12);
  }
  .band-name {
    position: absolute;
    left: 12px;
    top: 6px;
    font-size: 12px;
    color: var(--ink-2);
  }
  .links {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
  }
  .link {
    fill: none;
    stroke: #2a6ea8;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .link.l-running,
  .link.l-waiting {
    stroke: var(--cyan);
    stroke-width: 2;
    filter: drop-shadow(0 0 5px var(--cyan));
  }
  .link.l-queued {
    stroke-dasharray: 5 6;
  }
  .link.l-interrupted {
    stroke: #8a6a1c;
  }
  .link.l-failed {
    stroke: #8f3b3b;
  }
  .pulse {
    fill: #dff6ff;
    filter: drop-shadow(0 0 6px var(--cyan));
  }
  .port {
    fill: var(--cyan-soft);
  }

  .node {
    position: absolute;
    cursor: pointer;
    color: var(--ink);
    text-align: left;
    padding: 0;
    transition: box-shadow 0.2s, border-color 0.2s;
  }
  .node.selected {
    outline: 2px solid #dff6ff;
    outline-offset: 4px;
  }
  .tile {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 12px;
    background: rgba(11, 37, 72, 0.9);
    border: 1.5px solid var(--line-strong);
    backdrop-filter: blur(6px);
  }
  .tile.t0 {
    border-radius: 14px;
    padding: 10px 16px;
    background: rgba(12, 34, 68, 0.94);
    border-color: var(--accent);
    box-shadow: 0 0 34px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .lead-icon {
    color: #dff6ff;
    display: flex;
  }
  .tile-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-2);
  }
  .tile-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t0 .tile-name {
    font-family: var(--font-head);
    font-size: 19px;
  }
  .tile-desc,
  .tile-sub {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .circle {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(10, 29, 58, 0.92);
    border: 1.5px solid var(--line-strong);
    color: var(--cyan-soft);
  }

  /* Status: colour plus a word in the label, never colour alone. */
  .n-running,
  .n-waiting {
    border-color: var(--cyan);
    box-shadow: 0 0 22px rgba(var(--glow), 0.55);
  }
  .tile.t0.n-running,
  .tile.t0.n-waiting {
    border-color: var(--accent);
  }
  .n-running {
    animation: breathe 2.6s ease-in-out infinite;
  }
  .n-done {
    border-color: #2f7d5a;
  }
  .n-failed {
    border-color: var(--critical);
  }
  .n-interrupted {
    border-color: #a07a1e;
  }
  .n-queued {
    border-style: dashed;
    border-color: #2a6ea8;
  }
  @keyframes breathe {
    0%,
    100% {
      box-shadow: 0 0 14px rgba(var(--glow), 0.4);
    }
    50% {
      box-shadow: 0 0 30px rgba(var(--glow), 0.8);
    }
  }

  .caption {
    position: absolute;
    width: 104px;
    text-align: center;
    font-size: 12px;
    line-height: 1.35;
    color: var(--ink-2);
    pointer-events: none;
    display: flex;
    flex-direction: column;
  }
  .cap-name {
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    position: absolute;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #04130b;
    pointer-events: none;
  }
  .badge.good {
    background: var(--good);
  }
  .badge.bad {
    background: var(--critical);
  }

  .tools {
    position: absolute;
    right: 12px;
    top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tool {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--panel-solid);
    color: var(--ink-2);
    cursor: pointer;
  }
  .tool:hover {
    color: var(--ink);
    border-color: var(--line-strong);
  }
</style>
