<script>
  import { invalidateAll } from '$app/navigation';
  import { when } from '$lib/format.js';
  import { md } from '$lib/md.js';
  import Icon from '$lib/components/Icon.svelte';

  let { data } = $props();
  const p = $derived(data.project);
  const lead = $derived(p.tiers[0]);
  const base = $derived(`/p/${p.id}/inbox`);

  const TIERS = [
    { id: 'note', name: 'Note', what: 'Read at the start of the next cycle. Weighed in planning, no change of schedule.' },
    { id: 'priority', name: 'Priority', what: 'Delivered mid-cycle. Current work is finished first, then this is planned in.' },
    { id: 'urgent', name: 'Urgent', what: 'Delivered at once. Working agents are told to wrap up and report so it is handled before new work.' }
  ];

  let tier = $state('note');
  let text = $state('');
  let files = $state([]); // {token, name, size} once uploaded
  let replyTo = $state(null); // an ask being answered
  let busy = $state(false);
  let problem = $state('');
  let dragging = $state(false);
  let showClosed = $state(false);
  let picker = $state();

  const messages = $derived(data.messages.filter((m) => showClosed || m.open || (m.error && !m.closed)));
  const hiddenCount = $derived(data.messages.length - messages.length);

  async function upload(list) {
    problem = '';
    for (const f of list) {
      if (files.length >= 8) {
        problem = 'At most 8 attachments per message.';
        break;
      }
      if (f.size > 20 * 1024 * 1024) {
        problem = `${f.name} is over 20 MB.`;
        continue;
      }
      const res = await fetch(`${base}/attach?name=${encodeURIComponent(f.name || 'pasted.png')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f
      });
      if (res.ok) files = [...files, await res.json()];
      else problem = `Could not upload ${f.name}.`;
    }
  }

  function paste(e) {
    const got = [...(e.clipboardData?.files || [])];
    if (got.length) {
      e.preventDefault();
      upload(got);
    }
  }
  function drop(e) {
    e.preventDefault();
    dragging = false;
    upload([...(e.dataTransfer?.files || [])]);
  }

  async function post(path, body) {
    const res = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || 'The request failed');
    return out;
  }

  async function send() {
    if (!text.trim() || busy) return;
    busy = true;
    problem = '';
    try {
      const out = await post('send', { tier, text, attachments: files.map((f) => f.token), inReplyTo: replyTo?.id || null });
      if (!out.delivered) problem = `Saved, but not delivered yet: ${out.error || 'the VM did not accept it'}. Use Retry on the message.`;
      text = '';
      files = [];
      replyTo = null;
      tier = 'note';
      await invalidateAll();
    } catch (e) {
      problem = e.message;
    } finally {
      busy = false;
    }
  }

  async function act(path, body) {
    problem = '';
    try {
      await post(path, body);
      await invalidateAll();
    } catch (e) {
      problem = e.message;
    }
  }

  // A one-shot job can be started again while it is open: one that was not
  // started, or whose cycle ended before the lead finished it. Starting spends
  // usage, so it is asked for and goes through the Controls action (audited).
  // The status shown can be a few seconds old. A job started a moment ago is
  // running, whatever that status still says.
  const justStarted = (m) => m.tier === 'oneshot' && !!m.startedAt && p.now - Date.parse(m.startedAt) < 90_000;
  const canStart = (m) =>
    m.tier === 'oneshot' &&
    p.canOneshot &&
    m.open &&
    (p.status.state === 'halted' || (p.status.state === 'idle' && p.canOneshotIdle && !p.status.haltAfter)) &&
    !p.status.oneshot &&
    !justStarted(m) &&
    !m.scheduledFor &&
    (m.delivered || m.error);
  async function startJob(m) {
    const ok = window.confirm(
      `Start this one-shot job on ${p.name}?\n\n${lead} runs one cycle for it, then the team is ${p.status.state === 'idle' ? 'back to running' : 'halted again'}. This spends subscription usage.`
    );
    if (!ok || busy) return;
    busy = true;
    problem = '';
    try {
      const res = await fetch(`/p/${p.id}/controls/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'oneshot-again', id: m.id })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The job could not be started');
      if (out.started === false) problem = out.detail;
      await invalidateAll();
    } catch (e) {
      problem = e.message;
    } finally {
      busy = false;
    }
  }

  function answer(ask) {
    replyTo = ask;
    tier = 'priority';
    document.getElementById('compose')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const isImage = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name);
  const REPLY_WORD = { done: 'Done', planned: 'Planned', declined: 'Declined' };

  function stateOf(m) {
    if (m.closed && !m.delivered) return ['idle', 'Closed by you'];
    if (m.scheduledFor && !m.closed) return ['queued', `Set for ${new Date(m.scheduledFor * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (from the Backlog)`];
    if (m.error) return ['failed', m.tier === 'oneshot' ? 'Not started' : 'Not delivered'];
    if (m.tier === 'oneshot' && !m.reply && !m.closed && (p.status.oneshot?.id === m.id || justStarted(m))) return ['running', `${lead} is working on it`];
    if (!m.delivered) return ['queued', 'Sending'];
    if (m.reply) return [m.reply.status === 'declined' ? 'interrupted' : 'done', `${lead} replied: ${REPLY_WORD[m.reply.status].toLowerCase()}`];
    if (m.closed) return ['idle', 'Closed by you'];
    // Delivered means its cycle was started. No cycle running and no reply:
    // the cycle ended first (usage limit, budget, a halt).
    if (m.tier === 'oneshot' && (p.status.state === 'halted' || p.status.state === 'idle')) return ['interrupted', 'Its cycle ended without a reply'];
    if (m.seen) return ['waiting', `Seen by ${lead}`];
    return ['idle', p.status.state === 'halted' ? 'On the VM, read on resume' : 'On the VM, not read yet'];
  }
</script>

<div class="cols">
  <div class="main">
    {#if !p.canControl}
      <div class="panel block warn">
        <h2>Feedback is not available for this project yet</h2>
        <p class="dim">Its VM runs a kit without the owner inbox (or cannot be reached). Upgrade the kit to send messages here.</p>
      </div>
    {:else}
      {#if data.backlogChat}
        <div class="panel block small">
          Chat with {lead} about the latest plan: {data.backlogChat.answered} answer{data.backlogChat.answered === 1 ? '' : 's'}{data.backlogChat.waiting ? ', one on its way' : ''}.
          <a href="/p/{p.id}/backlog">Open the Backlog</a>
        </div>
      {/if}
      <section class="block" id="compose">
        <div class="row">
          <h2>{replyTo ? `Answer ${lead}'s question` : `Message to ${lead}`}</h2>
          {#if replyTo}
            <button class="btn quiet sm" onclick={() => (replyTo = null)}>Not an answer</button>
          {/if}
        </div>
      <div class="panel block lit" class:drag={dragging} ondragover={(e) => { e.preventDefault(); dragging = true; }} ondragleave={() => (dragging = false)} ondrop={drop} role="group" aria-label="New message">
        {#if replyTo}
          <div class="well quote small"><span class="dim">Answering:</span> {replyTo.text.slice(0, 240)}{replyTo.text.length > 240 ? '…' : ''}</div>
        {/if}

        <div class="tiers" role="radiogroup" aria-label="How soon">
          {#each TIERS as t (t.id)}
            <button class="tier t-{t.id}" class:on={tier === t.id} role="radio" aria-checked={tier === t.id} onclick={() => (tier = t.id)}>
              <span class="tname">{t.name}</span>
              <span class="twhat">{t.what}</span>
            </button>
          {/each}
        </div>

        <label class="sr" for="msg">Message</label>
        <textarea id="msg" class="field" rows="5" bind:value={text} onpaste={paste} placeholder="The field menu closes when I press Triangle twice. Screenshot attached."></textarea>

        {#if files.length}
          <ul class="files">
            {#each files as f, i (f.token)}
              <li class="well">
                <span class="mono small">{f.name}</span><span class="dim small">{kb(f.size)}</span>
                <button class="btn quiet icon sm" onclick={() => (files = files.filter((_, j) => j !== i))} aria-label="Remove {f.name}"><Icon name="x" size={12} /></button>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="actions">
          <input bind:this={picker} type="file" multiple hidden onchange={(e) => { upload([...e.currentTarget.files]); e.currentTarget.value = ''; }} />
          <button class="btn quiet" onclick={() => picker.click()}>Attach files</button>
          <span class="dim small">Or paste a screenshot, or drop files here. Up to 8, 20 MB each.</span>
          <span class="spacer"></span>
          <button class="btn primary send" onclick={send} disabled={busy || !text.trim()}>{busy ? 'Sending…' : `Send ${tier}`}</button>
        </div>

        {#if p.status.state === 'halted'}
          <p class="dim small">
            The team is halted, so no cycle is running and all three kinds behave the same: the message is stored on the VM now and
            {lead} reads it at the start of the first cycle after you resume. Sending it starts nothing and spends nothing.
            {#if p.canOneshot}To have something done now without resuming the team, start a <a href="/p/{p.id}/controls#oneshot">one-shot job</a>.{/if}
          </p>
        {:else if p.status.oneshot}
          <p class="dim small">A one-shot job is in progress. Whatever kind you pick, the message reaches {lead} during this cycle.</p>
        {:else if p.status.state === 'unreachable'}
          <p class="s-failed small">The VM cannot be reached. The message is saved here and can be retried.</p>
        {/if}
        {#if problem}<p class="s-failed small" role="alert">{problem}</p>{/if}
      </div>
      </section>
    {/if}

    <section class="block">
      <div class="row">
        <h2>Your messages</h2>
        {#if hiddenCount || showClosed}
          <label class="check small dim"><input type="checkbox" bind:checked={showClosed} /> Show finished ({data.messages.length - data.openMessages})</label>
        {/if}
      </div>
      {#each messages as m (m.id)}
        {@const [cls, word] = stateOf(m)}
        <article class="panel msg">
          <header>
            <span class="pill tp-{m.tier}">{m.tier === 'oneshot' ? 'one-shot job' : m.tier}</span>
            <span class="pill {cls}">{word}</span>
            {#if m.nudged}<span class="dim small">{m.nudged} agent{m.nudged > 1 ? 's' : ''} told to wrap up</span>{/if}
            <span class="grow"></span>
            <span class="dim small mono">{when(m.sentAt)}</span>
          </header>
          {#if m.inReplyTo}<div class="dim small">Answer to question <span class="mono">{m.inReplyTo.replace(/^[0-9TZ]+-a-/, '')}</span></div>{/if}
          <div class="pre">{m.text}</div>
          {#if m.attachments.length}
            <div class="atts">
              {#each m.attachments as a (a.name)}
                <a class="att well" href="{base}/file/sent/{m.id}/{a.name}" target="_blank" rel="noopener">
                  {#if isImage(a.name)}<img src="{base}/file/sent/{m.id}/{a.name}" alt={a.name} loading="lazy" />{/if}
                  <span class="mono small">{a.name}</span>
                </a>
              {/each}
            </div>
          {/if}
          {#if m.error}<div class="s-failed small">Delivery failed: {m.error}</div>{/if}
          {#if m.reply}
            <div class="reply well">
              <div class="small dim">{lead} · {REPLY_WORD[m.reply.status]}{m.reply.date ? ` · ${when(m.reply.date)}` : ''}</div>
              <!-- sanitised by md(): the reply was written inside the sandbox -->
              <div class="md">{@html md(m.reply.text, { breaks: true })}</div>
              {#if m.reply.attachments.length}
                <div class="atts">
                  {#each m.reply.attachments as a (a.name)}
                    <a class="att well" href="{base}/file/reply/{m.id}/{a.name}" target="_blank" rel="noopener">
                      {#if isImage(a.name)}<img src="{base}/file/reply/{m.id}/{a.name}" alt={a.name} loading="lazy" />{/if}
                      <span class="mono small">{a.name}</span>
                    </a>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
          {#if m.error || (m.open && m.delivered)}
            <footer class="actions end">
              {#if m.open && !m.closed}<button class="btn quiet sm" onclick={() => act('close', { id: m.id })}>Close message</button>{/if}
              {#if m.error && m.tier !== 'oneshot'}<button class="btn sm" onclick={() => act('send', { retry: m.id })}>Retry</button>{/if}
              {#if canStart(m)}<button class="btn sm" onclick={() => startJob(m)} disabled={busy}>{m.delivered ? 'Start it again…' : 'Start the job…'}</button>{/if}
            </footer>
          {/if}
        </article>
      {:else}
        <p class="dim">{data.messages.length ? 'No open messages.' : `Nothing sent yet. Messages you send to ${lead} appear here with their replies.`}</p>
      {/each}
    </section>
  </div>

  <aside class="side">
    <section class="block">
      <h2>Questions from {lead}</h2>
      {#each data.asks as a (a.id)}
        <article class="panel msg" class:answered={!a.open}>
          <header>
            <span class="pill {a.open ? 'halted' : 'done'}">{a.open ? 'Waiting on you' : 'Answered'}</span>
            <span class="mono small dim">{a.slug}</span>
            <span class="grow"></span>
            <span class="dim small mono">{when(a.askedAt)}</span>
          </header>
          <!-- sanitised by md() -->
          <div class="md">{@html md(a.text, { breaks: true })}</div>
          <div class="well default small"><span class="dim">If you do not answer, {lead} will:</span> {a.default}</div>
          {#if a.open && p.canControl}<footer class="actions end"><button class="btn primary sm" onclick={() => answer(a)}>Answer</button></footer>{/if}
        </article>
      {:else}
        <p class="dim">No questions. When {lead} is unsure about a decision it can ask here, and it carries on with a stated default meanwhile.</p>
      {/each}
    </section>

    <section class="block">
      <h2>Escalations</h2>
      <p class="dim small">Requests the team filed in its repo (ESCALATIONS.md). Read-only here.</p>
      {#if data.escalations.trim()}
        <details class="panel esc" open={p.summary.escalations > 0}>
          <summary>{p.summary.escalations} filed</summary>
          <div class="md">{@html md(data.escalations)}</div>
        </details>
      {:else}
        <p class="dim">None.</p>
      {/if}
    </section>
  </aside>
</div>

<style>
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr);
    gap: 20px;
    align-items: start;
  }
  .main,
  .side {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .panel.block {
    padding: 18px;
  }
  .panel.block.drag {
    border-color: var(--cyan);
    box-shadow: 0 0 30px rgba(var(--glow), 0.4);
  }
  .warn {
    border-color: var(--warn);
  }
  p {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .tiers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .tier {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--well);
    cursor: pointer;
  }
  .tier:hover {
    border-color: var(--line-strong);
  }
  .tname {
    font-weight: 600;
  }
  .twhat {
    font-size: 12px;
    color: var(--ink-2);
    line-height: 1.4;
  }
  .tier.on {
    border-color: var(--cyan);
    box-shadow: 0 0 16px rgba(var(--glow), 0.3);
  }
  .tier.t-priority.on {
    border-color: var(--warn);
    box-shadow: 0 0 16px rgba(251, 191, 36, 0.3);
  }
  .tier.t-urgent.on {
    border-color: var(--critical);
    box-shadow: 0 0 16px rgba(248, 113, 113, 0.35);
  }
  textarea {
    width: 100%;
    resize: vertical;
    line-height: 1.5;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 10px;
  }
  .send {
    min-width: 140px;
  }
  .quote,
  .default {
    padding: 8px 12px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .msg {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg.answered {
    opacity: 0.7;
  }
  .msg header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  .tp-note {
    color: var(--cyan-soft);
  }
  .tp-priority {
    color: var(--warn);
  }
  .tp-oneshot {
    color: var(--good);
  }
  .tp-urgent {
    color: var(--critical);
  }
  .atts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .att {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    max-width: 200px;
    color: var(--ink-2);
  }
  .att img {
    max-width: 100%;
    max-height: 120px;
    border-radius: 4px;
    object-fit: contain;
    background: #000;
  }
  .reply {
    padding: 10px 14px;
    border-color: var(--line-strong);
  }
  .msg footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .esc {
    padding: 12px 16px;
  }
  .esc summary {
    cursor: pointer;
    color: var(--cyan);
  }
  @media (max-width: 1100px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }
    .tiers {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
