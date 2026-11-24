<script>
  // The messages of a conversation in the Chat tab: the owner's, and the
  // lead's answers with the steps it took (collapsed), live while it works.
  // Text from the lead was written by an agent: it is rendered through the
  // sanitising markdown helper.
  import { ago, usd } from '$lib/format.js';
  import { md } from '$lib/md.js';

  let { messages = [], lead = 'the lead', now, running = false, canResend = true, onresend } = $props();

  let list = $state(null);
  let inner = $state(null);
  let follow = true;
  let open = $state({}); // message id -> steps shown

  function scrolled() {
    follow = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }
  $effect(() => {
    if (!inner || !list) return;
    const ro = new ResizeObserver(() => {
      if (follow) list.scrollTop = list.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(list);
    return () => ro.disconnect();
  });
  const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
</script>

<div class="msgs" bind:this={list} onscroll={scrolled}>
  <div class="inner" bind:this={inner}>
    {#if !messages.length}<p class="small dim empty">Ask {lead} anything about the project: what the team is doing, why, what is next. Talk only: {lead} reads, it does not change anything.</p>{/if}
    {#each messages as m, i (m.id)}
      {@const live = !m.reply && m.delivered && running && i === messages.length - 1}
      <div class="msg me small">
        <span class="dim">{m.by}, {ago(m.at, now)}{#if m.model || m.effort}{` · ${[m.model, m.effort].filter(Boolean).join(', ')}`}{/if}</span>
        <div class="pre">{m.text}</div>
        {#if m.files.length}<div class="dim files">{#each m.files as f (f.name)}<span>{f.name} ({kb(f.size)})</span>{/each}</div>{/if}
      </div>
      {#if m.reply || live || m.steps.length}
        <div class="msg lead small" class:bad={m.reply?.status === 'error'}>
          <span class="dim">{lead}{#if m.ranModel}{` · ${m.ranModel}`}{/if}{#if m.cost != null}, {usd(m.cost)}{/if}{#if m.reply?.date}, {ago(m.reply.date, now)}{/if}</span>
          {#if m.steps.length}
            <button class="steps-toggle dim" onclick={() => (open = { ...open, [m.id]: !(open[m.id] ?? live) })}>
              {(open[m.id] ?? live) ? '▾' : '▸'} {m.steps.length} step{m.steps.length > 1 ? 's' : ''}{live ? '…' : ''}
            </button>
            {#if open[m.id] ?? live}
              <ol class="steps mono">
                {#each m.steps as s, k (k)}
                  <li class:fail={s.ok === false}><b>{s.tool}</b> {s.text}{#if s.ok === null && live && k === m.steps.length - 1}<span class="dim"> …</span>{/if}</li>
                {/each}
              </ol>
            {/if}
          {/if}
          {#if m.reply?.text}
            <div class="md">{@html md(m.reply.text)}</div>
          {:else if m.reply}
            <div class="dim">No answer came back.</div>
          {:else if m.said}
            <div class="md partial">{@html md(m.said)}</div>
          {:else if live}
            <div class="dim">{lead} is working on it…</div>
          {/if}
          {#if m.reply?.status === 'error' && canResend}
            <div class="actions end">
              <button class="btn sm" disabled={running} onclick={() => onresend?.(m)}>Send again</button>
            </div>
          {/if}
        </div>
      {:else if m.delivered}
        <div class="msg lead small dim">{lead} is answering…</div>
      {:else}
        <div class="msg small s-failed">Not sent{m.error ? `: ${m.error}` : ''}</div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .msgs {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .inner {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-right: 6px;
  }
  .empty {
    margin: 24px auto;
    max-width: 44ch;
    text-align: center;
  }
  .msg {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    max-width: 88%;
    overflow-wrap: anywhere;
  }
  .msg.me {
    align-self: flex-end;
    background: rgba(var(--glow), 0.08);
  }
  .msg.lead {
    align-self: flex-start;
  }
  .msg.bad {
    border-color: var(--critical);
  }
  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }
  .steps-toggle {
    display: block;
    background: none;
    border: 0;
    padding: 4px 0;
    cursor: pointer;
    font: inherit;
  }
  .steps {
    margin: 0 0 6px;
    padding: 6px 8px 6px 26px;
    background: var(--well);
    border-radius: 6px;
    font-size: 11.5px;
    max-height: 220px;
    overflow-y: auto;
  }
  .steps li {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .steps li.fail {
    color: var(--critical);
  }
  .partial {
    opacity: 0.8;
  }
</style>
