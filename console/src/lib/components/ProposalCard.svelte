<script>
  // One backlog proposal: title, estimate, areas, risk, what it comes after,
  // and its text (agent-written, checked on the server, rendered through the
  // sanitising markdown helper). The parent gives the action row.
  import { usd } from '$lib/format.js';
  import { md } from '$lib/md.js';
  let { prop, stateText = '', after = '', bare = false, actions } = $props();
</script>

<article class="card {prop.state || ''}" class:panel={!bare}>
  <header>
    {#if prop.order != null}<span class="mono dim">{prop.order}.</span>{/if}
    <h3>{prop.title}</h3>
    {#if stateText}<span class="pill st">{stateText}</span>{/if}
  </header>
  <div class="est small">
    <span><b>{prop.minutes}</b> min</span>
    {#if prop.cost != null}<span><b>{usd(prop.cost)}</b></span>{/if}
    {#if prop.confidence}<span class="conf {prop.confidence}">{prop.confidence} confidence</span>{/if}
    {#if prop.rev > 1}<span class="dim">revision {prop.rev}</span>{/if}
  </div>
  {#if prop.areas}<div class="small"><span class="dim">Areas:</span> {prop.areas}</div>{/if}
  {#if prop.risk}<div class="small"><span class="dim">Risk:</span> {prop.risk}</div>{/if}
  {#if after}<div class="small"><span class="dim">After:</span> {after}</div>{/if}
  {#if prop.text}<div class="md small">{@html md(prop.text)}</div>{/if}
  {#if actions}<div class="actions foot">{@render actions()}</div>{/if}
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    border-radius: 10px;
  }
  .card.rejected {
    opacity: 0.55;
  }
  .card.approved {
    border-color: var(--accent);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h3 {
    margin: 0;
    flex: 1;
    font-size: 14px;
  }
  .est {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .conf.low {
    color: var(--warn);
  }
  .foot {
    margin-top: auto;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
</style>
