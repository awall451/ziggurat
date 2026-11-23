<script>
  // Owner issues as a board: New, In progress, Done. The lead triages and
  // moves them; the owner can move a card too (drag it, or use the buttons).
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { ago } from '$lib/format.js';
  import Icon from '$lib/components/Icon.svelte';
  import NewIssue from '$lib/components/NewIssue.svelte';
  import IssueDetail from '$lib/components/IssueDetail.svelte';
  import { byPriority, PRIORITY_WORD } from '$lib/issues.js';

  let { data } = $props();
  const p = $derived(data.project);
  const base = $derived(`/p/${p.id}`);

  const COLUMNS = [
    ['new', 'New'],
    ['in_progress', 'In progress'],
    ['done', 'Done']
  ];
  const WORD = { new: 'New', in_progress: 'In progress', done: 'Done', wontfix: "Won't fix" };
  const column = (i) => (i.status === 'wontfix' ? 'done' : i.status);

  // A link from another page may name the issue to open: /issues?issue=<id>.
  let openId = $state(page.url.searchParams.get('issue'));
  let dragId = $state(null);
  let over = $state(null);
  let busy = $state(false);
  let err = $state('');
  let creating = $state(false);
  let flash = $state(null); // {ok, text}
  let kindFilter = $state('all');
  let query = $state('');

  const KIND_FILTERS = [
    ['all', 'All'],
    ['bug', 'Bugs'],
    ['polish', 'Polish'],
    ['idea', 'Ideas'],
    ['planned', 'Planned']
  ];
  // A planned issue: an approved backlog item, done by its own job.
  function jobText(i) {
    const j = i.job;
    if (!j || i.status !== 'new') return '';
    if (j.scheduledFor) return `set for ${new Date(j.scheduledFor * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    if (j.startedAt) return 'job started';
    return '';
  }
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const n = /^#?(\d{1,6})$/.exec(q);
    return data.issues
      .filter(
        (i) =>
          (kindFilter === 'all' || i.kind === kindFilter) &&
          (!q || (n && i.number === Number(n[1])) || i.title.toLowerCase().includes(q) || (i.body || '').toLowerCase().includes(q))
      )
      .sort(byPriority);
  });

  async function created(res) {
    creating = false;
    flash = res.delivered
      ? { ok: true, text: 'Issue raised.' }
      : { ok: false, text: `Issue saved here, but not sent to the VM yet${res.error ? ` (${res.error})` : ''}. Open it to send it again.` };
    await invalidateAll();
  }

  const open = $derived(data.issues.find((i) => i.id === openId) || null);
  const img = (i) => `${base}/issues/img/${i.id}/${i.hasMarkup ? 'markup.png' : 'shot.png'}`;
  const screenName = (i) => (i.origin?.screen || '').replace(/-/g, ' ');

  async function move(id, status) {
    const i = data.issues.find((x) => x.id === id);
    if (!i || i.status === status) return;
    busy = true;
    err = '';
    try {
      const r = await fetch(`${base}/issues/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status }) });
      if (!r.ok) err = (await r.json().catch(() => ({}))).message || 'Could not move the issue';
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  async function retry(id) {
    busy = true;
    try {
      await fetch(`${base}/issues/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retry: id }) });
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  function drop(e, status) {
    e.preventDefault();
    over = null;
    if (dragId) move(dragId, status);
    dragId = null;
  }

</script>

<div class="toolbar actions">
  <div class="seg" role="group" aria-label="Kind">
    {#each KIND_FILTERS as [k, label] (k)}
      <button class="btn quiet sm" class:on={kindFilter === k} aria-pressed={kindFilter === k} onclick={() => (kindFilter = k)}>{label}</button>
    {/each}
  </div>
  <input class="field search" type="search" placeholder="Search issues" bind:value={query} aria-label="Search issues" />
  <span class="spacer"></span>
  <span class="dim small">{p.tiers[0]} moves the cards as the team works. Drag one to override.</span>
  <!-- Works with the VM off too: the issue is kept here and sent when asked again. -->
  <button class="btn primary" onclick={() => (creating = true)}>
    <Icon name="plus" size={14} /> New issue
  </button>
</div>

{#if flash}<div class="small err" class:s-done={flash.ok} class:s-interrupted={!flash.ok}>{flash.text}</div>{/if}
{#if err}<div class="s-failed small err">{err}</div>{/if}

{#if !data.issues.length}
  <div class="panel empty">
    <h2>No issues yet</h2>
    <p class="dim">
      Raise one with <b>New issue</b>, with a picture or files if you like, or from the Gallery: open a screenshot's menu (☰) and pick “Leave a
      note”. The lead triages every issue at the start of its next cycle and hands it to the team.
    </p>
  </div>
{:else}
  <div class="board">
    {#each COLUMNS as [status, label] (status)}
      {@const cards = shown.filter((i) => column(i) === status)}
      <section
        class="col panel"
        class:over={over === status}
        aria-label={label}
        ondragover={(e) => {
          e.preventDefault();
          over = status;
        }}
        ondragleave={() => (over = over === status ? null : over)}
        ondrop={(e) => drop(e, status)}
      >
        <header><h3>{label}</h3><span class="dim small">{cards.length}</span></header>
        {#each cards as i (i.id)}
          <button
            class="card"
            class:muted={i.status === 'wontfix'}
            draggable="true"
            ondragstart={() => (dragId = i.id)}
            ondragend={() => (dragId = null)}
            onclick={() => (openId = i.id)}
          >
            {#if i.hasShot || i.hasMarkup}<img src={img(i)} alt="" loading="lazy" />{/if}
            <span class="t">{i.title}</span>
            <span class="meta small">
              <span class="dot prio-{i.priority || 'normal'}" title="Priority: {PRIORITY_WORD[i.priority || 'normal']}"></span>
              {#if i.number}<span class="mono dim">#{i.number}</span>{/if}
              <span class="pill kind {i.kind}">{i.kind}</span>
              {#if i.origin?.screen}<span class="dim cap">{screenName(i)}</span>{/if}
              {#if jobText(i)}<span class="dim">{jobText(i)}</span>{/if}
              <span class="grow"></span>
              {#if !i.delivered}<span class="s-failed" title={i.error || 'Not delivered to the VM yet'}>not sent</span>{/if}
              {#if i.status === 'wontfix'}<span class="dim">won't fix</span>{/if}
              <span class="dim">{ago(i.createdAt, p.now)}</span>
            </span>
          </button>
        {/each}
      </section>
    {/each}
  </div>
{/if}

{#if open}
  <IssueDetail issue={open} issues={data.issues} {p} {base} onclose={() => (openId = null)} onopen={(id) => (openId = id)} onchanged={() => invalidateAll()} />
{/if}

{#if creating}
  <NewIssue project={p} issues={data.issues} canFiles={p.canIssueFiles} canTickets={p.canTickets} onclose={() => (creating = false)} oncreated={created} />
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .prio-urgent {
    background: var(--critical);
  }
  .prio-high {
    background: #fb923c;
  }
  .prio-normal {
    background: var(--accent);
  }
  .prio-low {
    background: var(--muted);
  }
  .search {
    width: 200px;
  }
  .empty {
    padding: 32px;
  }
  .err {
    margin-bottom: 8px;
  }
  .board {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
    align-items: start;
  }
  @media (max-width: 900px) {
    .board {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .col {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 200px;
    border-radius: 10px;
  }
  .col.over {
    border-color: var(--accent);
  }
  .col header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0 4px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--well);
    color: var(--ink);
    cursor: grab;
    font: inherit;
  }
  .card:hover {
    border-color: var(--line-strong);
  }
  .card.muted {
    opacity: 0.55;
  }
  .card img {
    width: 100%;
    max-height: 140px;
    object-fit: cover;
    object-position: top;
    border-radius: 4px;
    image-rendering: pixelated;
  }
  .t {
    font-weight: 500;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .grow {
    flex: 1;
  }
  .cap {
    text-transform: capitalize;
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
    border-style: dashed;
  }
  h2 {
    margin: 0 0 4px;
  }
  .note {
    white-space: pre-wrap;
    color: var(--ink-2);
  }
</style>
