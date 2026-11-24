<script>
  // One issue as a ticket (kit 0.12), in the manner of a tracker's detail
  // view: the work on the left (title, description, done when, pictures,
  // files, comments, history), the details on the right (status, priority, kind,
  // related issues, Fix now). Everything the lead wrote was checked on the
  // server; text is rendered through the sanitising markdown helper.
  import Modal from '$lib/components/Modal.svelte';
  import { ago } from '$lib/format.js';
  import { md } from '$lib/md.js';
  import Icon from '$lib/components/Icon.svelte';
  import PrioritySelect from '$lib/components/PrioritySelect.svelte';
  import IssuePicker from '$lib/components/IssuePicker.svelte';
  import { KIND_WORD, STATUS_WORD } from '$lib/issues.js';
  import { thread } from '$lib/thread.js';

  let { issue, issues = [], p, base, onclose = () => {}, onopen = () => {}, onchanged = async () => {} } = $props();

  const canEdit = $derived(p.canTickets || !issue.delivered);
  const planned = $derived(issue.kind === 'planned');
  const open = $derived(issue.status === 'new' || issue.status === 'in_progress');
  const st = $derived(p.status);
  // The same rules as a one-shot job on the Controls page.
  const fixReason = $derived(
    !open
      ? 'The issue is closed'
      : !issue.delivered
        ? 'Send the issue to the VM first'
        : !p.canOneshot
          ? 'The VM cannot run one-shot jobs (kit too old)'
          : st.oneshot
            ? 'A one-shot job is already running'
            : st.state === 'halted'
              ? ''
              : st.state === 'idle'
                ? !p.canOneshotIdle
                  ? 'On a running team this needs kit 0.6'
                  : st.haltAfter
                    ? 'A halt after the cycle is pending'
                    : ''
                : st.state === 'running'
                  ? 'A cycle is running. It reads open issues, or wait for it to end'
                  : 'The VM is not reachable'
  );

  let busy = $state('');
  let problem = $state('');
  let editTitle = $state(null);
  let editBody = $state(null);
  let editDone = $state(null);
  let note = $state('');
  let picker = $state(null);
  let showHistory = $state(false);

  async function post(url, body, key) {
    busy = key;
    problem = '';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.message || 'That did not work');
      if (out.pending) problem = `Saved here, but not on the VM yet${out.error ? ` (${out.error})` : ''}.`;
      else if (out.started === false) problem = out.detail || 'No clear answer from the VM.';
      await onchanged();
      return out;
    } catch (e) {
      problem = e.message;
      return null;
    } finally {
      busy = '';
    }
  }
  const act = (action, body, key = action) => post(`${base}/issues/act`, { action, id: issue.id, ...body }, key);
  const move = (status) => (issue.status === status ? null : post(`${base}/issues/status`, { id: issue.id, status }, 'status'));

  async function saveTitle() {
    if ((await act('edit', { title: editTitle }, 'title')) != null) editTitle = null;
  }
  async function saveBody() {
    if ((await act('edit', { body: editBody }, 'body')) != null) editBody = null;
  }
  async function saveDone() {
    if ((await act('edit', { doneWhen: editDone }, 'done')) != null) editDone = null;
  }
  const addRelated = (other) => act('edit', { related: [...(issue.related || []), other.number] }, 'related');
  const dropRelated = (n) => act('edit', { related: (issue.related || []).filter((x) => x !== n) }, 'related');
  async function sendNote() {
    if ((await act('note', { text: note }, 'note')) != null) note = '';
  }
  function readB64(file) {
    return new Promise((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1] || '');
      r.onerror = () => bad(new Error(`Could not read ${file.name}`));
      r.readAsDataURL(file);
    });
  }
  async function addFiles(list) {
    const files = [...list];
    if (!files.length) return;
    if (files.some((f) => f.size > 20 * 1024 * 1024)) return (problem = 'A file is over 20 MB');
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: await readB64(f) })));
      await act('files', { files: payload }, 'files');
    } catch (e) {
      problem = e.message;
    }
  }
  async function fix() {
    if (!window.confirm(`Start a one-shot job for #${issue.number} on ${p.name}?\n\n${p.tiers[0]} runs one cycle for this issue, then the team goes back to how it was. This spends subscription usage.`)) return;
    const out = await act('fix', {}, 'fix');
    if (out?.started) problem = '';
  }

  // Comments from Boss (the owner) and the lead, with the status changes between them (issue 75).
  const comments = $derived(thread(issue));
  const lead = $derived(p.tiers?.[0] || 'Lead');
  const byNumber = $derived(new Map(issues.map((i) => [i.number, i])));
  const img = (i) => `${base}/issues/img/${i.id}/${i.hasMarkup ? 'markup.png' : 'shot.png'}`;
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
</script>

<Modal wide {onclose}>
  {#snippet header()}
    <div class="hd">
      <span class="kind {issue.kind}">{KIND_WORD[issue.kind] || issue.kind}</span>
      {#if issue.number}<span class="mono num">#{issue.number}</span>{/if}
      <span class="pill st {issue.status}">{STATUS_WORD[issue.status]}</span>
      {#if !issue.delivered}<span class="s-failed small">not sent to the VM</span>{/if}
      {#if issue.pendingAmend}<span class="s-failed small">a change is not on the VM yet</span>{/if}
    </div>
  {/snippet}

  <div class="detail">
    <div class="main">
      {#if editTitle != null}
        <div class="fieldrow">
          <input class="field ttl" bind:value={editTitle} maxlength="200" />
          <div class="actions end">
            <button class="btn quiet sm" onclick={() => (editTitle = null)}>Cancel</button>
            <button class="btn primary sm" disabled={!!busy || !editTitle.trim()} onclick={saveTitle}>Save</button>
          </div>
        </div>
      {:else}
        <h2 class="title">
          {#if canEdit}
            <button class="editable" title="Click to change the title" onclick={() => (editTitle = issue.title)}>{issue.title}</button>
            <button class="pen" aria-label="Change the title" title="Change the title" onclick={() => (editTitle = issue.title)}><Icon name="pencil" size={14} /></button>
          {:else}{issue.title}{/if}
        </h2>
      {/if}
      <div class="small dim">
        Raised by {issue.by} {ago(issue.createdAt, p.now)}{#if issue.origin?.screen} · from the gallery: {issue.origin.screen.replace(/-/g, ' ')}{/if}
      </div>

      <section>
        <div class="sect">
          <h3>Description</h3>
          {#if canEdit && editBody == null}<button class="pen" aria-label="Edit the description" title="Edit the description" onclick={() => (editBody = issue.body || '')}><Icon name="pencil" size={14} /></button>{/if}
        </div>
        {#if editBody != null}
          <textarea class="field" rows="8" bind:value={editBody}></textarea>
          <div class="actions end">
            <button class="btn quiet sm" onclick={() => (editBody = null)}>Cancel</button>
            <button class="btn primary sm" disabled={!!busy} onclick={saveBody}>Save</button>
          </div>
        {:else if issue.body}
          <div class="md">{@html md(issue.body, { breaks: true })}</div>
        {:else}
          <p class="dim small">No description.</p>
        {/if}
      </section>

      <section>
        <div class="sect">
          <h3>Done when</h3>
          {#if canEdit && editDone == null}<button class="pen" aria-label="Edit what done means" title="Edit what done means" onclick={() => (editDone = issue.doneWhen || '')}><Icon name="pencil" size={14} /></button>{/if}
        </div>
        {#if editDone != null}
          <textarea class="field" rows="2" maxlength="1000" bind:value={editDone} placeholder="What has to be true for this to be fixed"></textarea>
          <div class="actions end">
            <button class="btn quiet sm" onclick={() => (editDone = null)}>Cancel</button>
            <button class="btn primary sm" disabled={!!busy} onclick={saveDone}>Save</button>
          </div>
        {:else if issue.doneWhen}
          <p class="pre">{issue.doneWhen}</p>
        {:else}
          <p class="dim small">Not set.</p>
        {/if}
      </section>

      {#if issue.hasShot || issue.hasMarkup || issue.resolution?.fixedShot}
        <div class="pics" class:two={issue.resolution?.fixedShot}>
          {#if issue.hasShot || issue.hasMarkup}
            <figure>
              <img src={img(issue)} alt="The owner's screenshot with markup" />
              {#if issue.resolution?.fixedShot}<figcaption class="small dim">Before</figcaption>{/if}
            </figure>
          {/if}
          {#if issue.resolution?.fixedShot}
            <figure>
              <img src="{base}/media/{issue.resolution.fixedShot}" alt="Screenshot after the fix" />
              <figcaption class="small dim">After</figcaption>
            </figure>
          {/if}
        </div>
      {/if}

      <section>
        <div class="sect spread">
          <h3>Files</h3>
          {#if canEdit}
            <input bind:this={picker} type="file" multiple hidden onchange={(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
            <button class="btn quiet sm" disabled={!!busy || (issue.attachments?.length || 0) >= 8} onclick={() => picker.click()}>{busy === 'files' ? 'Adding…' : 'Add files'}</button>
          {/if}
        </div>
        {#if issue.attachments?.length}
          <ul class="files small">
            {#each issue.attachments as a (a.name)}
              <li><a class="mono" href="{base}/issues/att/{issue.id}/{a.name}" target="_blank" rel="noopener">{a.name}</a></li>
            {/each}
          </ul>
        {:else}
          <p class="dim small">No files. Up to 8, 20 MB each.</p>
        {/if}
      </section>

      <section>
        <h3>Comments</h3>
        {#each comments as c, i (i)}
          {#if c.type === 'event'}
            <div class="event small dim">{c.by === 'lead' ? lead : 'Boss'} moved it to <b>{STATUS_WORD[c.to] || c.to}</b>, {ago(c.at, p.now)}</div>
          {:else}
            <div class="note" class:lead={c.by === 'lead'}>
              <div class="small dim"><b class="who">{c.by === 'lead' ? lead : 'Boss'}</b>, {ago(c.at, p.now)}{#if c.by === 'boss' && !c.delivered && issue.delivered} · <span class="s-failed">not on the VM{c.error ? `: ${c.error}` : ''}</span>{/if}</div>
              <div class="md small">{@html md(c.text, { breaks: true })}</div>
            </div>
          {/if}
        {:else}
          <p class="dim small">No comments yet.</p>
        {/each}
        {#if canEdit}
          <textarea class="field" rows="3" bind:value={note} placeholder="Add a comment: what you saw, what changed, a new detail"></textarea>
          <div class="actions end">
            <button class="btn primary sm" disabled={!!busy || !note.trim()} onclick={sendNote}>{busy === 'note' ? 'Sending…' : 'Comment'}</button>
          </div>
        {/if}
      </section>

      <section>
        <div class="sect spread">
          <h3>History</h3>
          <button class="btn quiet sm" onclick={() => (showHistory = !showHistory)}>{showHistory ? 'Hide' : `Show (${issue.history.length})`}</button>
        </div>
        {#if showHistory}
          <ol class="hist small">
            {#each issue.history.toReversed() as h, n (n)}
              <li>
                <span class="mono dim">{h.at.slice(0, 16).replace('T', ' ')}</span>
                <b>{h.who}</b>
                {#if h.from}moved it from {STATUS_WORD[h.from]} to {STATUS_WORD[h.to]}{:else if h.note === 'raised'}raised it{/if}
                {#if h.note && h.note !== 'raised'}<div class="pre">{h.note}</div>{/if}
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    </div>

    <aside class="side">
      <div class="actions">
        <button class="btn primary grow" disabled={!!busy || !!fixReason} title={fixReason || 'A one-shot job for this issue, now'} onclick={fix}>{busy === 'fix' ? 'Starting…' : 'Fix now'}</button>
      </div>
      {#if fixReason && open}<p class="small dim">{fixReason}.</p>{/if}
      {#if !issue.delivered}<button class="btn sm" disabled={!!busy} onclick={() => post(`${base}/issues/status`, { retry: issue.id }, 'retry')}>Send to the VM again</button>{/if}
      {#if issue.pendingAmend}<button class="btn sm" disabled={!!busy} onclick={() => act('resend', {}, 'resend')}>Send the change again</button>{/if}
      {#if problem}<p class="s-failed small">{problem}</p>{/if}

      <h3>Details</h3>
      <dl>
        <dt>Status</dt>
        <dd>
          <select class="field" value={issue.status} disabled={!!busy} onchange={(e) => move(e.currentTarget.value)}>
            {#each Object.entries(STATUS_WORD) as [k, w] (k)}<option value={k}>{w}</option>{/each}
          </select>
        </dd>
        <dt>Priority</dt>
        <dd>
          <PrioritySelect value={issue.priority || 'normal'} disabled={!!busy || !canEdit} onchange={(v) => act('edit', { priority: v }, 'priority')} />
        </dd>
        <dt>Kind</dt>
        <dd>
          {#if planned}
            <span>Planned</span>
          {:else}
            <select class="field" value={issue.kind} disabled={!!busy || !canEdit} onchange={(e) => act('edit', { kind: e.currentTarget.value }, 'kind')}>
              {#each ['bug', 'polish', 'idea'] as k (k)}<option value={k}>{KIND_WORD[k]}</option>{/each}
            </select>
          {/if}
        </dd>
        <dt>Raised</dt>
        <dd class="small">{when(issue.createdAt)}</dd>
        {#if issue.resolution}
          <dt>Closed</dt>
          <dd class="small">{when(issue.resolution.at)} by {issue.resolution.who}</dd>
        {/if}
        {#if issue.resolution?.fixedIn}
          <dt>Fixed in</dt>
          <dd class="mono small" title={issue.resolution.fixedIn}>{issue.resolution.fixedIn.slice(0, 9)}</dd>
        {/if}
        {#if issue.proposal}
          <dt>Planning</dt>
          <dd class="small"><a href="{base}/backlog">approved proposal, revision {issue.proposal.rev}</a></dd>
        {/if}
        {#if issue.job}
          <dt>Job</dt>
          <dd class="small">{issue.job.scheduledFor ? `set for ${new Date(issue.job.scheduledFor * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : issue.job.startedAt ? `started ${ago(issue.job.startedAt, p.now)}` : 'sent'}</dd>
        {/if}
        <dt>Related</dt>
        <dd>
          <div class="rel">
            {#each issue.related || [] as n (n)}
              {@const r = byNumber.get(n)}
              <span class="chip small">
                <button class="linkbtn" onclick={() => r && onopen(r.id)} title={r?.title || ''}>#{n}{r ? ` ${r.title.slice(0, 28)}${r.title.length > 28 ? '…' : ''}` : ''}</button>
                {#if canEdit}<button class="x" aria-label="Remove #{n}" disabled={!!busy} onclick={() => dropRelated(n)}>×</button>{/if}
              </span>
            {:else}
              <span class="dim small">None</span>
            {/each}
          </div>
          {#if canEdit}
            <div class="relrow">
              <IssuePicker issues={issues} exclude={[issue.number, ...(issue.related || [])]} disabled={!!busy} onpick={addRelated} />
            </div>
          {/if}
        </dd>
      </dl>
      {#if !p.canTickets && issue.delivered}
        <p class="small dim">Changing an issue needs kit 0.12 on the VM.</p>
      {/if}
    </aside>
  </div>
</Modal>

<style>
  .hd {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .num {
    color: var(--ink-2);
    font-size: 14px;
  }
  .kind {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kind.bug {
    color: var(--critical);
  }
  .kind.polish {
    color: var(--warn);
  }
  .kind.idea {
    color: var(--cyan);
  }
  .kind.planned {
    color: var(--accent);
  }
  .detail {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    border-top: 1px solid var(--line);
    margin: 0 -18px -18px;
    height: min(760px, calc(100vh - 170px));
    overflow: hidden;
  }
  .main {
    min-height: 0;
    padding: 16px 22px 22px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }
  .side {
    min-height: 0;
    border-left: 1px solid var(--line);
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: rgba(2, 6, 14, 0.25);
  }
  .title {
    margin: 0;
    font-size: 20px;
  }
  .editable {
    all: unset;
    cursor: text;
    border-radius: 6px;
  }
  .editable:hover {
    background: rgba(var(--glow), 0.08);
  }
  .ttl {
    font-size: 18px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sect {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sect.spread {
    justify-content: space-between;
  }
  .pen {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--ink-2);
    cursor: pointer;
    vertical-align: middle;
  }
  .pen:hover,
  .pen:focus-visible {
    color: var(--ink);
    border-color: var(--line);
    background: rgba(var(--glow), 0.08);
  }
  h3 {
    margin: 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-2);
  }
  textarea.field {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  .pre {
    white-space: pre-wrap;
    margin: 0;
  }
  .pics {
    display: grid;
    gap: 10px;
  }
  .pics.two {
    grid-template-columns: 1fr 1fr;
  }
  .pics img {
    max-width: 100%;
    border-radius: 8px;
    border: 1px solid var(--line);
  }
  figure {
    margin: 0;
  }
  .files {
    margin: 0;
    padding-left: 18px;
  }
  .note {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .note.lead {
    border-left: 3px solid var(--accent);
  }
  .note .who {
    color: var(--ink-strong);
  }
  .event {
    padding: 0 10px;
  }
  .hist {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 10px 10px;
    align-items: start;
  }
  dt {
    padding-top: 7px;
  }
  dt {
    font-size: 12px;
    color: var(--ink-2);
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  dd select.field {
    width: 100%;
  }
  .rel {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 8px;
  }
  .x {
    border: 0;
    background: none;
    color: var(--ink-2);
    cursor: pointer;
    padding: 0 2px;
  }
  .relrow {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .grow {
    flex: 1;
  }
  @media (max-width: 800px) {
    .detail {
      grid-template-columns: minmax(0, 1fr);
      height: auto;
      overflow: visible;
    }
    .side {
      border-left: 0;
      border-top: 1px solid var(--line);
      order: -1;
    }
  }
</style>
