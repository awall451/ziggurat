<script>
  // Details of one agent: what it was asked, by whom, with which model, how
  // full its context is, which tools it used, and what it reported back.
  import { num, usd, dur, between, modelShort, STATUS_WORD } from '$lib/format.js';
  import { md } from '$lib/md.js';
  import Icon from './Icon.svelte';

  let { node, nodes, tiers = [], live = false, onselect = () => {}, onclose = () => {} } = $props();

  const parent = $derived(nodes.find((n) => n.id === node.parent) || null);
  const children = $derived(nodes.filter((n) => n.parent === node.id));
  const maxTool = $derived(Math.max(1, ...node.tools.map((t) => t.count)));
  const elapsed = $derived(between(node.started, node.ended));
  let fullBrief = $state(false);
  // Briefs are markdown. Rendered reads better in a narrow panel; Raw shows
  // the exact text the agent received. The choice is kept while you click around.
  let rawBrief = $state(false);
  const brief = $derived(node.brief || '');
  const longBrief = $derived(brief.length > 700);

  // Collapse the brief again when another agent is picked. Every data refresh
  // hands in a new `node` object for the same agent, which reruns this effect:
  // compare the id itself, so a refresh leaves an opened brief open (issue 13).
  let shownId = node.id;
  $effect(() => {
    if (node.id === shownId) return;
    shownId = node.id;
    fullBrief = false;
  });
</script>

<aside class="drawer panel lit" aria-label="Agent details">
  <header>
    <span class="kind"><Icon name={node.kind === 'lead' ? 'ziggurat' : node.kind} size={22} /></span>
    <div class="title">
      <h2>{node.label}</h2>
      <div class="small dim">
        {#if node.depth === 0}Lead of this cycle{:else}Spawned by {parent?.label || 'the lead'} · <span class="mono">{node.rawType}</span>{/if}
      </div>
    </div>
    <span class="pill {node.status}">{STATUS_WORD[node.status]}</span>
    <button class="close" onclick={onclose} aria-label="Close details"><Icon name="x" size={14} /></button>
  </header>

  <dl>
    {#if node.description}
      <dt>Task</dt>
      <dd>{node.description}</dd>
    {/if}
    <dt>Model</dt>
    <dd class="mono">
      {node.model || '–'}
      {#if node.requestedModel && !(node.model || '').includes(node.requestedModel)}<span class="dim"> · asked for {node.requestedModel}</span>{/if}
    </dd>
    <dt>Context</dt>
    <dd class="mono">{num(node.contextTokens)} tokens{#if node.peakTokens > node.contextTokens}<span class="dim"> · peak {num(node.peakTokens)}</span>{/if}</dd>
    <dt>Output</dt>
    <dd class="mono">{num(node.outputTokens)} tokens <span class="dim">· {num(node.turns)} turns</span></dd>
    <dt>Estimate</dt>
    <dd class="mono">{usd(node.costUsd)} <span class="dim">· API-equivalent</span></dd>
    <dt>Time</dt>
    <dd class="mono">{dur(elapsed)}{#if live && (node.status === 'running' || node.status === 'waiting')}<span class="dim">&nbsp;so far</span>{/if}</dd>
    {#if node.branch}
      <dt>Branch</dt>
      <dd class="mono clip" title={node.branch}>{node.branch}</dd>
    {/if}
    {#if node.worktree}
      <dt>Worktree</dt>
      <dd class="mono clip" title={node.worktree}>{node.worktree}</dd>
    {/if}
  </dl>

  {#if brief}
    <section>
      <div class="row">
        <h3>{parent ? `Brief from ${parent.label}` : 'Cycle prompt'}</h3>
        <span class="links">
          <button class="link" onclick={() => (rawBrief = !rawBrief)} aria-pressed={rawBrief}>{rawBrief ? 'Rendered' : 'Raw'}</button>
          {#if longBrief}
            <button class="link" onclick={() => (fullBrief = !fullBrief)}>{fullBrief ? 'Show less' : 'Show full brief'}</button>
          {/if}
        </span>
      </div>
      <div class="well text brief" class:clipped={longBrief && !fullBrief}>
        {#if rawBrief}
          <div class="pre mono rawtext">{brief}</div>
        {:else}
          <!-- sanitised by md(): a brief is written by an agent -->
          <div class="md">{@html md(brief)}</div>
        {/if}
      </div>
    </section>
  {/if}

  {#if node.tools.length}
    <section>
      <h3>Tools used <span class="dim small">· {num(node.toolCalls)} calls</span></h3>
      <div class="bars mono">
        {#each node.tools.slice(0, 10) as t (t.name)}
          <span class="dim clip" title={t.name}>{t.name}</span>
          <span class="track"><span class="fill" style="width:{(t.count / maxTool) * 100}%"></span></span>
          <span class="count">{t.count}</span>
        {/each}
      </div>
    </section>
  {/if}

  {#if children.length}
    <section>
      <h3>Spawned <span class="dim small">· {children.length}</span></h3>
      <div class="kids">
        {#each children as c (c.id)}
          <button class="kid well" onclick={() => onselect(c.id)}>
            <span class="clip">{c.description || c.label}</span>
            <span class="dim small">{c.label}</span>
            <span class="small s-{c.status}">{c.status}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if node.report}
    <section>
      <h3>Final report</h3>
      <!-- sanitised by md(): agent-written text is untrusted -->
      <div class="well md text">{@html md(node.report)}</div>
    </section>
  {/if}
</aside>

<style>
  .drawer {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 18px;
    height: 100%;
    overflow-y: auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .kind {
    color: var(--cyan-soft);
    display: flex;
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .close {
    width: 36px;
    height: 36px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }
  dl {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 6px 12px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--ink-2);
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  .clip {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .links {
    display: flex;
    gap: 14px;
  }
  .brief.clipped {
    max-height: 260px;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(#000 70%, transparent);
    mask-image: linear-gradient(#000 70%, transparent);
  }
  .rawtext {
    font-size: 12px;
  }
  .brief :global(.md > :first-child) {
    margin-top: 0;
  }
  .brief :global(.md > :last-child) {
    margin-bottom: 0;
  }
  .link {
    background: none;
    border: 0;
    color: var(--cyan);
    font-size: 12px;
    cursor: pointer;
    padding: 6px 0;
  }
  .text {
    padding: 12px;
    color: #c5d9ee;
    font-size: 13px;
  }
  .bars {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) 36px;
    gap: 6px 10px;
    align-items: center;
    font-size: 12px;
  }
  .track {
    height: 8px;
    border-radius: 4px;
    background: #10294d;
    display: block;
  }
  .fill {
    display: block;
    height: 8px;
    border-radius: 4px;
    background: var(--cyan);
    min-width: 2px;
  }
  .count {
    text-align: right;
  }
  .kids {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .kid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 10px;
    align-items: center;
    padding: 8px 12px;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    color: var(--ink);
  }
  .kid:hover {
    border-color: var(--line-strong);
  }
</style>
