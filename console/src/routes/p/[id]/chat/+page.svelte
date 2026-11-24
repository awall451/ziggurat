<script>
  // The Chat tab (issue 71): conversations with the lead that are not about a
  // plan. On the left the conversations, in the middle the open one with the
  // lead's steps while it works, on the right what the conversation holds:
  // its size against the model's context window, cost, model and effort,
  // how long the cache stays warm, the files the lead read.
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { ago, usd } from '$lib/format.js';
  import ChatThread from '$lib/components/ChatThread.svelte';
  import ChatComposer from '$lib/components/ChatComposer.svelte';

  let { data } = $props();
  const p = $derived(data.project);
  const base = $derived(`/p/${p.id}`);
  const lead = $derived(p.tiers?.[0] || 'the lead');
  const conv = $derived(data.open);
  const want = $derived(page.url.searchParams.get('c') || '');
  const chatBusy = $derived(!!data.busy?.chat);
  const running = $derived(!!conv && data.busy?.chat?.talk === conv.id);
  const waiting = $derived(chatBusy || data.conversations.some((c) => c.waiting));

  let showArchived = $state(false);
  const shown = $derived(data.conversations.filter((c) => c.archived === showArchived));
  const archivedCount = $derived(data.conversations.filter((c) => c.archived).length);

  let text = $state('');
  let files = $state([]);
  let model = $state('');
  let effort = $state('');
  let busy = $state('');
  let flash = $state(null);
  let composer = $state(null);
  let cols = $state(null);

  // The model and effort of the open conversation, as chosen last.
  let modelFor = '';
  $effect(() => {
    const id = conv?.id || '';
    if (id === modelFor) return;
    modelFor = id;
    model = conv?.model || '';
    effort = conv?.effort || '';
    files = [];
    flash = null;
  });

  // Wide window: the columns end at the bottom of the window.
  function fit() {
    if (!cols) return;
    const wide = window.matchMedia('(min-width: 1000px)').matches;
    cols.style.height = wide ? `${Math.max(360, window.innerHeight - cols.getBoundingClientRect().top - 20)}px` : '';
  }
  $effect(() => {
    cols;
    flash;
    fit();
  });

  // While the lead answers, look every 2 seconds (its steps come in); otherwise every 15.
  onMount(() => {
    let last = 0;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const every = waiting ? 2000 : 15000;
      if (Date.now() - last < every) return;
      last = Date.now();
      post({ action: 'sync' }, '', { quiet: true });
    }, 1000);
    return () => clearInterval(t);
  });

  // Answers shown here are read: the mark clears the tab's count.
  let seenSent = '';
  $effect(() => {
    if (!conv) return;
    const last = conv.messages.findLast((m) => m.reply)?.id;
    const unread = data.conversations.find((c) => c.id === conv.id)?.unread;
    if (!last || !unread || seenSent === last) return;
    seenSent = last;
    post({ action: 'seen', conv: conv.id }, '', { quiet: true });
  });

  async function post(body, key, { quiet = false } = {}) {
    if (busy && !quiet) return null;
    if (!quiet) {
      busy = key;
      flash = null;
    }
    try {
      const r = await fetch(`${base}/chat/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (!quiet) flash = { ok: false, text: out.message || 'That did not work' };
        return null;
      }
      if (!quiet && out.delivered === false) flash = { ok: false, text: out.detail };
      await invalidateAll();
      return out;
    } finally {
      if (!quiet) busy = '';
    }
  }

  async function upload(list) {
    for (const f of list) {
      if (files.length >= 8) {
        flash = { ok: false, text: 'At most 8 files with a message.' };
        break;
      }
      if (f.size > 20 * 1024 * 1024) {
        flash = { ok: false, text: `${f.name} is over 20 MB.` };
        continue;
      }
      const res = await fetch(`${base}/inbox/attach?name=${encodeURIComponent(f.name || 'pasted.png')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      if (res.ok) files = [...files, await res.json()];
      else flash = { ok: false, text: `Could not upload ${f.name}.` };
    }
  }

  async function send(again = null) {
    const body = again ? again.text : text;
    const out = await post({ action: 'say', conv: conv?.id || '', text: body, model, effort, attachments: again ? [] : files.map((f) => f.token) }, 'say');
    if (!out) return;
    if (!again) {
      text = '';
      files = [];
    }
    if (!conv || conv.id !== out.conv) await goto(`${base}/chat?c=${out.conv}`, { keepFocus: true, noScroll: true });
  }

  function newConversation() {
    text = '';
    files = [];
    goto(`${base}/chat`, { noScroll: true }).then(() => composer?.focus());
  }
  async function renameConv() {
    const t = window.prompt('Name of this conversation', conv.title);
    if (t && t.trim() && t.trim() !== conv.title) await post({ action: 'rename', conv: conv.id, title: t }, 'rename');
  }
  async function archive(archived) {
    await post({ action: 'archive', conv: conv.id, archived }, 'archive');
    if (archived) goto(`${base}/chat`, { noScroll: true });
  }

  const pct = $derived(conv?.context.tokens != null ? Math.min(100, Math.round((conv.context.tokens / conv.context.window) * 100)) : null);
  const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const switching = $derived(!!conv && !!conv.context.model && !!model && !conv.context.model.includes(model) && conv.context.warmMinutes > 0);
  const hint = $derived(
    chatBusy && !running
      ? `${lead} is answering another chat; send when it is done.`
      : switching
        ? 'A different model re-reads the whole conversation at the full price.'
        : 'Each message counts as usage, not as a cycle. Ctrl+Enter sends.'
  );
</script>

<svelte:window onscroll={fit} onresize={fit} />

{#if !data.ready}
  <section class="panel block">
    <h2>Chat with {lead}</h2>
    <p class="dim small">
      {data.kitVersion ? `The Chat tab needs kit 0.33 on ${p.name}'s VM (it has ${data.kitVersion}). Upgrade the kit to talk with ${lead} here; the plan chat on Planning still works.` : `${p.name}'s VM is not reachable right now.`}
    </p>
  </section>
{/if}

{#if flash}<div class="note" class:s-failed={!flash.ok} role="status">{flash.text}</div>{/if}

<div class="cols" bind:this={cols}>
  <aside class="panel list">
    <button class="btn primary new" onclick={newConversation} disabled={!data.ready}>New conversation</button>
    <nav aria-label="Conversations">
      {#each shown as c (c.id)}
        <a class="item" class:on={conv?.id === c.id} href="{base}/chat?c={c.id}" data-sveltekit-noscroll>
          <span class="ttl">{c.title}</span>
          {#if c.running}<span class="dot live" title="{lead} is answering"></span>{:else if c.unread}<span class="count">{c.unread}</span>{/if}
          <span class="small dim sub">{c.last || 'No messages'}</span>
          <span class="small dim when">{ago(c.lastAt, p.now)}</span>
        </a>
      {:else}
        <p class="small dim pad">{showArchived ? 'Nothing archived.' : 'No conversations yet.'}</p>
      {/each}
    </nav>
    {#if archivedCount || showArchived}
      <button class="btn quiet sm" onclick={() => (showArchived = !showArchived)}>{showArchived ? 'Back to conversations' : `Archived (${archivedCount})`}</button>
    {/if}
  </aside>

  <section class="panel main">
    <header class="hd">
      <h2 class="grow">{conv ? conv.title : want ? 'No such conversation' : 'New conversation'}</h2>
      {#if conv}
        <button class="btn quiet sm" onclick={renameConv} disabled={!!busy}>Rename</button>
        <button class="btn quiet sm" onclick={() => archive(!conv.archived)} disabled={!!busy}>{conv.archived ? 'Unarchive' : 'Archive'}</button>
      {/if}
    </header>
    <ChatThread messages={conv?.messages || []} {lead} now={p.now} {running} canResend={!chatBusy} onresend={(m) => send(m)} stepUrl={conv ? (msg, i) => `${base}/chat/step?c=${conv.id}&m=${msg}&i=${i}` : null} />
    {#if !conv?.archived}
      <ChatComposer
        bind:this={composer}
        bind:text
        bind:files
        bind:model
        bind:effort
        placeholder={conv ? `Reply to ${lead}` : `Ask ${lead} anything about ${p.name}`}
        disabled={!data.ready || chatBusy}
        sending={busy === 'say'}
        onupload={upload}
        showModel
        teamModel={data.teamModel || ''}
        teamEffort={data.teamEffort || ''}
        {hint}
        onsend={() => send()}
      />
    {/if}
  </section>

  <aside class="panel side">
    <h3>Context</h3>
    {#if conv && conv.context.turns}
      <div class="meter" title="{conv.context.tokens ?? 0} of {conv.context.window} tokens">
        <div class="bar"><span style="width: {pct ?? 0}%"></span></div>
        <div class="small"><b>{conv.context.tokens != null ? k(conv.context.tokens) : '–'}</b> <span class="dim">/ {k(conv.context.window)} tokens ({pct ?? 0}%)</span></div>
      </div>
      <dl class="small">
        <dt>Cost</dt>
        <dd>
          {#if conv.context.costPending === conv.context.turns}<span class="dim">known after the next pull</span>
          {:else}{usd(conv.context.cost)} <span class="dim">over {conv.context.turns - conv.context.costPending} answer{conv.context.turns - conv.context.costPending > 1 ? 's' : ''}{#if conv.context.costPending}, {conv.context.costPending} more to come{/if}</span>{/if}
        </dd>
        <dt>Model</dt><dd>{conv.context.model || '–'}{#if conv.context.effort}<span class="dim">, {conv.context.effort} effort</span>{/if}</dd>
        <dt>Cache</dt>
        <dd>
          {#if conv.context.warmMinutes > 0}warm for {conv.context.warmMinutes} min{:else}<span class="dim">cold: the next answer starts a new session from the conversation so far</span>{/if}
        </dd>
      </dl>
      {#if conv.context.files.length}
        <h3>Files read</h3>
        <ul class="files small mono">
          {#each conv.context.files as f (f)}<li title={f}>{f}</li>{/each}
        </ul>
      {/if}
    {:else}
      <p class="small dim">Size, cost, model and cache of the conversation show here once {lead} has answered.</p>
    {/if}
    <h3>The team now</h3>
    <p class="small">
      {#if data.busy?.oneshot}A one-shot job is running.{:else if data.busy?.state === 'running'}A cycle is running.{:else if data.busy}The team is {data.busy.state}.{:else}<span class="dim">Unknown.</span>{/if}
      <span class="dim">{lead} is told what runs with every message.</span>
    </p>
  </aside>
</div>

<style>
  .cols {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr) 260px;
    gap: 14px;
    min-height: 360px;
  }
  .panel {
    min-height: 0;
    padding: 14px;
  }
  .block {
    margin-bottom: 14px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }
  .list nav {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .new {
    width: 100%;
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 8px;
    padding: 8px 10px;
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
    border: 1px solid transparent;
  }
  .item:hover {
    background: rgba(var(--glow), 0.06);
  }
  .item.on {
    background: rgba(var(--glow), 0.1);
    border-color: var(--line);
  }
  .ttl {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    grid-column: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .when {
    grid-column: 2;
    grid-row: 2;
    text-align: right;
  }
  .count {
    justify-self: end;
    background: var(--accent);
    color: var(--bg);
    border-radius: 999px;
    font-size: 11px;
    padding: 0 7px;
    align-self: center;
  }
  .dot.live {
    justify-self: end;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--good);
    align-self: center;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .pad {
    padding: 8px 4px;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hd {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .grow {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .side {
    overflow-y: auto;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-2);
  }
  h3:not(:first-child) {
    margin-top: 16px;
  }
  .meter {
    margin-bottom: 12px;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--well);
    overflow: hidden;
    margin-bottom: 4px;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 10px;
    margin: 0;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .files {
    margin: 0;
    padding-left: 16px;
  }
  .files li {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  p {
    margin: 0;
  }
  .note {
    margin-bottom: 10px;
  }
  @media (max-width: 999px) {
    .cols {
      grid-template-columns: 1fr;
    }
    .list {
      max-height: 220px;
    }
    .main {
      height: 70vh;
    }
  }
</style>
