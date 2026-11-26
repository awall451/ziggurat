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

  // System packages and domains the lead asked for (kit 0.16).
  let pkgBusy = $state('');
  let pkgNote = $state('');
  let pkgErr = $state({}); // rid -> why the VM refused, shown on the card
  let pkgLocal = $state({}); // rid -> decision just sent, until the list shows it
  const openPkgs = $derived((data.packages?.requests || []).filter((r) => r.state === 'waiting'));
  const pastPkgs = $derived((data.packages?.requests || []).filter((r) => r.state !== 'waiting').slice(0, 6));
  const PKG_KIND = { apt: 'Ubuntu package', recipe: 'Install recipe', domain: 'Domain on the allow-list' };
  async function decidePkg(r, decision) {
    if (decision === 'approve' && r.missing?.length && !confirm(`Approving adds ${r.missing.join(', ')} to the gateway's allow-list, for every agent VM behind it. Go on?`)) return;
    pkgBusy = r.rid;
    pkgNote = '';
    pkgErr = { ...pkgErr, [r.rid]: '' };
    try {
      const res = await fetch(`${base}/packages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rid: r.rid, decision }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The VM refused');
      pkgLocal = { ...pkgLocal, [r.rid]: { decision, added: out.added || [] } };
      await invalidateAll();
    } catch (e) {
      pkgErr = { ...pkgErr, [r.rid]: e.message };
    } finally {
      pkgBusy = '';
    }
  }
  // A failed install, tried again once its cause is fixed (kit 0.17), and a domain taken back off the gateway.
  async function pkgAct(body, key, said) {
    pkgBusy = key;
    pkgNote = '';
    try {
      const res = await fetch(`${base}/packages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'That did not work');
      pkgNote = said;
      await invalidateAll();
    } catch (e) {
      pkgNote = e.message;
    } finally {
      pkgBusy = '';
    }
  }
  const retryPkg = (r) => pkgAct({ decision: 'retry', rid: r.rid }, r.rid, `Trying ${r.request} again. It starts between cycles, within a minute or two.`);
  function removeDomain(d) {
    if (!confirm(`Take ${d} off the gateway's allow-list? Every agent VM behind it loses it.`)) return;
    pkgAct({ decision: 'remove-domain', domain: d }, d, `Removed ${d} from the gateway's allow-list.`);
  }
  const PKG_STATE = { fetching: 'fetching files', installing: 'installing', installed: 'installed', failed: 'failed', declined: 'declined', approved: 'approved' };

  // Changes to what "done" means, held by the gate (kit 0.14).
  let gateBusy = $state('');
  let gateErr = $state({}); // sha -> why the VM refused, shown on the card
  let gateLocal = $state({}); // sha -> {decision, at}: just sent, until the VM lists it as approved
  let settledSeen = $state([]); // how approved changes ended, until dismissed
  let clock = $state(Date.now());
  const gstate = (h) => (h.state !== 'waiting' ? h.state : gateLocal[h.sha] ? (gateLocal[h.sha].decision === 'approve' ? 'approved' : 'declined') : 'waiting');
  const gAt = (h) => h.approvedAt || gateLocal[h.sha]?.at || null;
  const minsSince = (iso) => Math.max(0, Math.floor((clock - Date.parse(iso)) / 60000));
  const SETTLED = {
    merged: (s) => `${s.topic} was merged into main.`,
    rejected: (s) => `${s.topic} was not merged: ${s.detail || 'the gate rejected it'}.${/main moved/.test(s.detail) ? ` ${lead} rebases it and you approve the new commit.` : ''}`,
    failed: (s) => `${s.topic} failed the gate's checks: ${s.detail || 'see the log'}.`,
    held: (s) => `${s.topic} is held again and waits for you.`,
    gone: (s) => `${s.topic || 'The change'} is no longer waiting. Check the Controls tab for the gate's verdict.`
  };
  $effect(() => {
    for (const s of data.gateHeld?.settled || []) if (!settledSeen.some((x) => x.sha === s.sha)) settledSeen = [...settledSeen, s];
  });
  // While something the owner approved is still being worked on, look again by itself.
  const inFlight = $derived((data.gateHeld?.held || []).some((h) => gstate(h) === 'approved') || (data.packages?.requests || []).some((r) => ['approved', 'fetching', 'installing'].includes(r.state)));
  $effect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      clock = Date.now();
      if (!document.hidden) invalidateAll();
    }, 30000);
    return () => clearInterval(t);
  });
  const diffClass = (l) => (l.startsWith('+++') || l.startsWith('---') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '');
  async function decideGate(h, decision) {
    const what = decision === 'approve' ? `Approve ${h.topic}? The gate checks it once more and merges it if it passes. From then on these checks define "done".` : `Decline ${h.topic}? It will not be merged.`;
    if (!confirm(what)) return;
    gateBusy = h.sha;
    gateErr = { ...gateErr, [h.sha]: '' };
    try {
      const r = await fetch(`${base}/gate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: h.sha, decision, topic: h.topic }) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.message || 'The VM refused');
      clock = Date.now();
      gateLocal = { ...gateLocal, [h.sha]: { decision: decision === 'approve' ? 'approve' : 'deny', at: res.at || new Date().toISOString() } };
      await invalidateAll();
    } catch (e) {
      gateErr = { ...gateErr, [h.sha]: e.message };
    } finally {
      gateBusy = '';
    }
  }
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

  // Escalations from the team's file: open ones wait for an answer or a dismissal.
  const openEsc = $derived(data.escalations.filter((e) => e.open));
  const closedEsc = $derived(data.escalations.filter((e) => !e.open));
  const ESC_HOW = { answered: 'you answered', dismissed: 'you dismissed it', resolved: 'the team marked it resolved', question: 'its question is answered' };
  let escFor = $state(null); // key of the entry being answered
  let escText = $state('');
  let escBusy = $state(false);
  let escProblem = $state('');
  async function escAct(action, key) {
    escBusy = true;
    escProblem = '';
    try {
      const out = await post('escalation', { action, key, text: action === 'answer' ? escText : undefined });
      if (action === 'answer') {
        if (!out.delivered) escProblem = `Saved, but not delivered yet: ${out.error || 'the VM did not accept it'}. Use Retry on the message.`;
        escFor = null;
        escText = '';
      }
      await invalidateAll();
    } catch (e) {
      escProblem = e.message;
    } finally {
      escBusy = false;
    }
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
    if (m.scheduledFor && !m.closed) return ['queued', `Set for ${new Date(m.scheduledFor * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (from Planning)`];
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
    {#if data.publishing}
      <section class="block">
        <h2>Publishing</h2>
        <article class="panel msg">
          <header>
            <span class="pill halted">Waiting on you</span>
            <span class="mono small">{data.publishing.remote}</span>
            <span class="grow"></span>
            {#if data.publishing.lastAt}<span class="dim small mono">checked {when(data.publishing.lastAt)}</span>{/if}
          </header>
          {#if data.publishing.need === 'hostkey'}
            <p>{data.publishing.error}</p>
            <p class="dim small">After that one confirmation the console checks the key by itself.</p>
          {:else}
            <p>Publishing to <span class="mono">{data.publishing.remote}</span> is not working: {data.publishing.error}</p>
            <p class="dim small">Add the project's key to the repository as a deploy key with write access, then nothing else is needed: the console checks again by itself.</p>
          {/if}
          <footer class="actions end"><a class="btn sm" href="/p/{p.id}/controls#publishing">Show the key</a></footer>
        </article>
      </section>
    {/if}
    {#if data.gateHeld && (data.gateHeld.held.length || data.gateHeld.error || settledSeen.length)}
      <section class="block">
        <h2>Changes to what "done" means</h2>
        <p class="dim small">The gate holds any change to the project's checks until you approve that exact commit.</p>
        {#each settledSeen as s (s.sha)}
          <p class="small settled">{SETTLED[s.status]?.(s) || SETTLED.gone(s)} <button class="btn quiet sm" onclick={() => (settledSeen = settledSeen.filter((x) => x.sha !== s.sha))}>Dismiss</button></p>
        {/each}
        {#if data.gateHeld.error && !data.gateHeld.held.length}<p class="small s-failed">Could not ask the VM: {data.gateHeld.error}</p>{/if}
        {#each data.gateHeld.held as h (h.sha)}
          <article class="panel msg">
            <header>
              {#if gstate(h) === 'approved'}
                <span class="pill running">Approved {when(gAt(h))}, re-checking</span>
              {:else if gstate(h) === 'declined'}
                <span class="pill halted">Declined</span>
              {:else}
                <span class="pill halted">Waiting on you</span>
              {/if}
              <span class="mono small">{h.topic}</span>
              <span class="mono small dim">{h.sha.slice(0, 9)}</span>
              <span class="grow"></span>
              <span class="dim small mono">{when(h.at)}</span>
            </header>
            {#if h.summary}
              {#if !h.summary.current}<p class="small dim">{lead} explained an earlier commit of this branch:</p>{/if}
              <!-- sanitised by md() -->
              <div class="md">{@html md(h.summary.text, { breaks: true })}</div>
            {:else}
              <p class="dim small">{lead} has not explained this change yet. Read the diff, or wait for the explanation.</p>
            {/if}
            {#if h.diff}
              <details class="diff">
                <summary class="small">The change to the checks{h.diff.cut ? ' (cut at 200 KB)' : ''}</summary>
                <pre class="mono small">{#each h.diff.text.split('\n') as l, i (i)}<span class={diffClass(l)}>{l}</span>{'\n'}{/each}</pre>
              </details>
            {:else}
              <p class="dim small">The diff could not be read.</p>
            {/if}
            {#if gstate(h) === 'approved'}
              <p class="small dim">The gate runs all of the checks again on this exact commit, usually 6 to 8 minutes{gAt(h) ? `; ${minsSince(gAt(h))} min so far` : ''}, then merges it. This card changes by itself when it is done. If main moves in the meantime the gate rejects it, {lead} rebases, and you approve the new commit.</p>
            {:else if gstate(h) === 'declined'}
              <p class="small dim">Declined. It will not be merged.</p>
            {/if}
            {#if gateErr[h.sha]}<p class="small s-failed" role="alert">Could not {gateLocal[h.sha] ? 'finish' : 'send'} that: {gateErr[h.sha]}</p>{/if}
            {#if p.canControl && gstate(h) === 'waiting'}
              <footer class="actions end">
                <button class="btn sm" disabled={gateBusy === h.sha} onclick={() => decideGate(h, 'deny')}>Decline</button>
                <button class="btn primary sm" disabled={gateBusy === h.sha} onclick={() => decideGate(h, 'approve')}>Approve</button>
              </footer>
            {/if}
          </article>
        {/each}
      </section>
    {/if}

    {#if data.packages && (data.packages.requests.length || data.packages.error || pkgNote)}
      <section class="block">
        <h2>Packages and domains</h2>
        <p class="dim small">{lead} is not root and the proxy is closed. What it asks for is installed between cycles once you approve.</p>
        {#if pkgNote}<p class="small">{pkgNote}</p>{/if}
        {#if data.packages.error && !data.packages.requests.length}<p class="small s-failed">Could not ask the VM: {data.packages.error}</p>{/if}
        {#each openPkgs as r (r.rid)}
          <article class="panel msg">
            <header>
              {#if pkgLocal[r.rid]}
                <span class="pill {pkgLocal[r.rid].decision === 'approve' ? 'running' : 'halted'}">{pkgLocal[r.rid].decision === 'approve' ? 'Approved, installed between cycles' : 'Declined'}</span>
              {:else if pkgBusy === r.rid}
                <span class="pill running">Sending…</span>
              {:else}
                <span class="pill halted">Waiting on you</span>
              {/if}
              <span class="mono small">{r.request}</span>
              <span class="grow"></span>
              <span class="dim small">{PKG_KIND[r.what.kind]}</span>
            </header>
            {#if r.what.about}<p class="small dim">{r.what.about}</p>{/if}
            {#if r.reason}<div class="md">{@html md(r.reason, { breaks: true })}</div>{:else}<p class="small dim">No reason was given.</p>{/if}
            {#if r.what.domains.length}
              <p class="small">
                Needs {#each r.what.domains as dm, i (dm)}<span class="mono">{dm}</span>{i < r.what.domains.length - 1 ? ', ' : ''}{/each}.
                {#if r.missing == null}<span class="s-interrupted">The gateway's list could not be checked{data.packages.gateway === 'none' ? ': this project has no deploy target' : ''}.</span>
                {:else if r.missing.length}<span class="s-interrupted">Not allowed yet: approving adds {r.missing.join(', ')} for every agent VM.</span>
                {:else}<span class="dim">All allowed already.</span>{/if}
              </p>
            {/if}
            {#if pkgLocal[r.rid]?.added?.length}<p class="small dim">Allowed on the gateway: {pkgLocal[r.rid].added.join(', ')}.</p>{/if}
            {#if pkgErr[r.rid]}<p class="small s-failed" role="alert">Could not send that: {pkgErr[r.rid]}</p>{/if}
            {#if p.canControl && !pkgLocal[r.rid]}
              <footer class="actions end">
                <button class="btn sm" disabled={pkgBusy === r.rid} onclick={() => decidePkg(r, 'deny')}>Decline</button>
                <button class="btn primary sm" disabled={pkgBusy === r.rid} onclick={() => decidePkg(r, 'approve')}>Approve</button>
              </footer>
            {/if}
          </article>
        {/each}
        {#if pastPkgs.length}
          <ul class="pkgs small">
            {#each pastPkgs as r (r.rid)}
              <li>
                <span class="pill {r.state === 'installed' ? 'done' : r.state === 'failed' ? 'failed' : r.state === 'declined' ? 'halted' : 'running'}">{PKG_STATE[r.state] || r.state}</span>
                <span class="mono">{r.request}</span>
                {#if r.state === 'fetching'}<span class="dim">the console is bringing {r.needs.length || 'its'} file{r.needs.length === 1 ? '' : 's'}{r.ready ? '; installed at the next tick' : ''}</span>{/if}
                {#if r.state === 'failed'}
                  {#if p.canControl && p.canRetryPackages}<button class="btn sm" disabled={pkgBusy === r.rid} onclick={() => retryPkg(r)}>Try again</button>{/if}
                  {#if r.log}
                    <details class="diff">
                      <summary class="small">Why it failed (the end of its log)</summary>
                      <pre class="mono small">{r.log}</pre>
                    </details>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if data.packages.extra?.length}
          <p class="dim small">
            Added to the gateway's allow-list since it was made, for every agent VM behind it:
            {#each data.packages.extra as d (d)}
              <span class="mono">{d}</span>
              {#if p.canControl}<button class="btn quiet sm" disabled={pkgBusy === d} onclick={() => removeDomain(d)} title="Take this domain off the allow-list">Remove</button>{/if}
            {/each}
          </p>
        {/if}
      </section>
    {/if}

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
      <p class="dim small">Requests the team filed in its repo (ESCALATIONS.md). Answer one and {lead} gets it as a note; dismiss one that needs no answer. Either way it stops waiting on you.</p>
      {#if escProblem}<p class="s-failed small" role="alert">{escProblem}</p>{/if}
      {#each openEsc as e (e.key)}
        <article class="panel esc">
          <h3>{e.title}</h3>
          {#if e.body}<div class="md escbody">{@html md(e.body)}</div>{/if}
          {#if escFor === e.key}
            <textarea class="field" rows="3" placeholder="Your answer to {lead}" bind:value={escText}></textarea>
            <div class="actions end">
              <button class="btn quiet sm" disabled={escBusy} onclick={() => (escFor = null)}>Cancel</button>
              <button class="btn primary sm" disabled={escBusy || !escText.trim()} onclick={() => escAct('answer', e.key)}>Send answer</button>
            </div>
          {:else}
            <div class="actions end">
              <button class="btn quiet sm" disabled={escBusy} onclick={() => escAct('dismiss', e.key)}>Dismiss</button>
              <button class="btn sm" disabled={escBusy} onclick={() => ((escFor = e.key), (escText = ''))}>Answer…</button>
            </div>
          {/if}
        </article>
      {:else}
        <p class="dim">{closedEsc.length ? 'None open.' : 'None.'}</p>
      {/each}
      {#if closedEsc.length}
        <details class="panel esc">
          <summary>Closed ({closedEsc.length})</summary>
          {#each closedEsc as e (e.key)}
            <div class="escdone">
              <span class="grow">{e.title}</span>
              <span class="small dim">{ESC_HOW[e.closed.how]}{e.closed.at ? `, ${when(e.closed.at)}` : ''}</span>
              {#if e.closed.how === 'answered' || e.closed.how === 'dismissed'}
                <button class="btn quiet sm" disabled={escBusy} onclick={() => escAct('reopen', e.key)}>Reopen</button>
              {/if}
            </div>
          {/each}
        </details>
      {/if}
    </section>
  </aside>
</div>

<style>
  .pkgs {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .diff pre {
    max-height: 420px;
    overflow: auto;
    margin: 8px 0 0;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    white-space: pre;
  }
  .diff .add {
    color: var(--good);
  }
  .diff .del {
    color: var(--critical);
  }
  .diff .hunk,
  .diff .meta {
    color: var(--muted);
  }
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
  article.esc {
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .esc h3 {
    margin: 0;
    font-size: 14px;
  }
  .escbody {
    max-height: 260px;
    overflow: auto;
    font-size: 13px;
  }
  .escdone {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-top: 1px solid var(--line);
    margin-top: 6px;
  }
  .escdone .grow {
    flex: 1;
    min-width: 0;
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
