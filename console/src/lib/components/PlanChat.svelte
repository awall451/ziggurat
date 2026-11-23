<script>
  // The chat about one plan with the lead, as a box with its own scroll: a
  // title row, the messages (they scroll alone), and the message box at the
  // bottom. The parent gives the box its height. With no plan to talk over,
  // the box shows `closed` and no message box. Text from the lead was written
  // by an agent: it is rendered through the sanitising markdown helper.
  import { ago, usd } from '$lib/format.js';
  import { md } from '$lib/md.js';

  let {
    plan = null, // {id, chat, ended, running} or null: no plan to talk over
    closed = '', // what to say when there is no plan
    lead = 'the lead',
    now,
    busy = false, // another action of the page is under way
    chatBusy = false, // the lead is answering
    jobRunning = false,
    text = $bindable(''),
    onsend,
    onresend,
    onend
  } = $props();

  let root = $state(null);
  let list = $state(null);
  let inner = $state(null);
  let box = $state(null);
  // Follow the newest message, unless the owner scrolled up to read.
  let follow = true;

  export function focus() {
    root?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    box?.focus({ preventScroll: true });
  }

  function scrolled() {
    follow = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  // Whenever the messages grow (a new one, an answer, fonts arriving).
  $effect(() => {
    if (!inner || !list) return;
    const ro = new ResizeObserver(() => {
      if (follow) list.scrollTop = list.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(list);
    return () => ro.disconnect();
  });
</script>

<aside class="panel chatbox" bind:this={root}>
  <header class="actions">
    <h2 class="grow">Talk it over with {lead}</h2>
    {#if plan && !plan.ended}<button class="btn quiet sm" disabled={!!busy} onclick={() => onend?.()}>End chat</button>{/if}
  </header>

  {#if !plan}
    <p class="closed small dim">{closed}</p>
  {:else}
    <div class="msgs" bind:this={list} onscroll={scrolled}>
      <div class="inner" bind:this={inner}>
      {#if !plan.chat.length}<p class="small dim">No messages yet.</p>{/if}
      {#each plan.chat as c (c.id)}
        <div class="msg me small"><span class="dim">{c.by}, {ago(c.at, now)}</span><div class="pre">{c.text}</div></div>
        {#if c.reply}
          <div class="msg lead small" class:bad={c.reply.status === 'error'}>
            <span class="dim">{lead}{#if c.cost != null}, {usd(c.cost)}{/if}</span>
            {#if c.reply.text}
              <div class="md">{@html md(c.reply.text)}</div>
            {:else}
              <div class="dim">No answer came back.</div>
            {/if}
            {#if c.reply.status === 'error' && !plan.ended}
              <div class="actions end">
                <button class="btn sm" disabled={!!busy || chatBusy || plan.running} onclick={() => onresend?.(c.text)}>Send again</button>
              </div>
            {/if}
          </div>
        {:else if c.delivered}
          <div class="msg lead small dim">{lead} is answering…</div>
        {:else}
          <div class="msg small s-failed">Not sent{c.error ? `: ${c.error}` : ''}</div>
        {/if}
      {/each}
      </div>
    </div>

    {#if plan.ended}
      <p class="small dim">This chat is ended. Start a new planning cycle to plan again.</p>
    {:else}
      <textarea class="field" rows="3" bind:this={box} bind:value={text} placeholder="Ask about a proposal, or ask {lead} to change, split or drop one"></textarea>
      <div class="actions">
        <span class="small dim grow">
          Each message counts as usage, not as a cycle.
          {#if jobRunning}The chat stays open while a job runs; {lead} is told what is running.{/if}
        </span>
        <button class="btn primary" disabled={!!busy || chatBusy || plan.running || !text.trim()} onclick={() => onsend?.()}>Send</button>
      </div>
    {/if}
  {/if}
</aside>

<style>
  .chatbox {
    height: 100%;
    min-height: 0;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  header {
    flex: none;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .grow {
    flex: 1;
  }
  p {
    margin: 0;
  }
  .closed {
    margin: auto;
    padding: 24px 12px;
    max-width: 34ch;
    text-align: center;
  }
  .msgs {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .inner {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 6px;
  }
  .msg {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 10px;
    max-width: 92%;
    overflow-wrap: anywhere;
  }
  .msg.me {
    align-self: flex-end;
    background: rgba(var(--glow), 0.08);
  }
  .msg.bad {
    border-color: var(--bad, #c55);
  }
  textarea {
    flex: none;
    width: 100%;
    margin: 0;
    box-sizing: border-box;
    resize: none;
  }
  .actions {
    flex: none;
    flex-wrap: nowrap;
  }
</style>
