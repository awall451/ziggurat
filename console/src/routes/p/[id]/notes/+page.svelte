<script>
  import { md } from '$lib/md.js';

  let { data } = $props();
  const n = $derived(data.notes);
  const p = $derived(data.project);

  // What is open in the reader: a fixed section or one of the other files.
  let view = $state('state');
  let fileText = $state('');
  let openIssue = $state(null);
  let showClosed = $state(false);

  const CLOSED = ['closed', 'fixed', 'done'];
  const issues = $derived(n.issues.filter((i) => showClosed || !CLOSED.includes(i.status)));

  async function openFile(path) {
    view = `file:${path}`;
    fileText = '';
    const res = await fetch(`/p/${p.id}/notes/file?path=${encodeURIComponent(path)}`);
    fileText = res.ok ? await res.text() : 'Could not load this file.';
  }

  const SECTIONS = $derived([
    ['state', `${p.tiers[0]}'s plan`],
    ['journal', 'Journal'],
    ['escalations', `Escalations${p.summary.escalations ? ` (${p.summary.escalations})` : ''}`],
    ['issues', `QA issues (${p.summary.issuesOpen} open)`]
  ]);
</script>

<div class="layout">
  <nav class="panel side">
    {#each SECTIONS as [k, label] (k)}
      <button class="item" class:on={view === k} onclick={() => (view = k)}>{label}</button>
    {/each}
    {#if n.files.length}
      <div class="group small dim">Other documents</div>
      {#each n.files as f (f)}
        <button class="item file mono" class:on={view === `file:${f}`} onclick={() => openFile(f)} title={f}>{f}</button>
      {/each}
    {/if}
  </nav>

  <article class="panel reader">
    {#if view === 'state'}
      <!-- sanitised by md(): agent-written text is untrusted -->
      {#if n.state}<div class="md">{@html md(n.state)}</div>{:else}<p class="dim">No STATE.md on gate main yet.</p>{/if}
    {:else if view === 'journal'}
      {#if n.journal}<div class="md">{@html md(n.journal)}</div>{:else}<p class="dim">No journal yet.</p>{/if}
    {:else if view === 'escalations'}
      {#if n.escalations}<div class="md">{@html md(n.escalations)}</div>{:else}<p class="dim">Nothing escalated.</p>{/if}
    {:else if view === 'issues'}
      <div class="bar">
        <h2>QA issues</h2>
        <label class="check small dim"><input type="checkbox" bind:checked={showClosed} /> Show closed</label>
      </div>
      {#each issues as i (i.file)}
        <div class="issue well">
          <button class="issue-head" onclick={() => (openIssue = openIssue === i.file ? null : i.file)} aria-expanded={openIssue === i.file}>
            <span class="sev sev-{i.severity}">{i.severity}</span>
            <span class="mono dim">{i.id}</span>
            <span class="ititle">{i.title}</span>
            <span class="small dim">{i.status}</span>
          </button>
          {#if openIssue === i.file}
            <div class="md issue-body">{@html md(i.body)}</div>
          {/if}
        </div>
      {:else}
        <p class="dim">No issues to show.</p>
      {/each}
    {:else}
      <div class="md">{@html md(fileText)}</div>
    {/if}
  </article>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .side {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 72px;
    max-height: calc(100vh - 96px);
    overflow-y: auto;
  }
  .item {
    /* Never shrink: with many files the list scrolls instead of squashing rows. */
    flex: none;
    text-align: left;
    padding: 8px 10px;
    border-radius: 8px;
    border: 0;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }
  .item:hover {
    color: var(--ink);
    background: rgba(var(--glow), 0.06);
  }
  .item.on {
    color: #dff6ff;
    background: rgba(var(--glow), 0.12);
  }
  .item.file {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group {
    flex: none;
    padding: 12px 10px 4px;
  }
  .reader {
    padding: 20px 24px;
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .issue {
    margin-bottom: 8px;
  }
  .issue-head {
    width: 100%;
    display: grid;
    grid-template-columns: 76px 52px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    background: transparent;
    border: 0;
    text-align: left;
    cursor: pointer;
  }
  .ititle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .issue-body {
    padding: 0 14px 12px;
    border-top: 1px solid var(--line);
  }
  .sev {
    font-size: 12px;
    font-weight: 600;
    text-transform: lowercase;
    color: var(--ink-2);
  }
  .sev-blocker,
  .sev-critical {
    color: var(--critical);
  }
  .sev-major {
    color: var(--warn);
  }
  .sev-minor {
    color: var(--cyan-soft);
  }
  @media (max-width: 900px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .side {
      position: static;
      max-height: 240px;
    }
  }
</style>
