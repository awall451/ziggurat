<script>
  // Live output of one deploy run: one line per task, filled in as events
  // arrive. Starts from the events the page already loaded and continues over
  // server-sent events from that byte offset.
  import { onDestroy } from 'svelte';

  let { deployId, runId, initial = [], offset = 0, ondone = () => {} } = $props();

  let rows = $state([]);
  let ended = $state(null); // the run's `done` event
  let lost = $state(false);
  let source = null;
  let current = null; // run the rows belong to

  function add(e) {
    if (e.type === 'task_start') rows.push({ task: e.task, state: 'running', msg: '', tries: 0 });
    else if (e.type === 'play_start') rows.push({ head: e.play });
    else if (e.type === 'stderr') rows.push({ note: e.line });
    else if (e.type === 'done') ended = e;
    else if (e.type === 'recap') rows.push({ note: `${e.host}: ${e.ok} ok, ${e.changed} changed, ${e.failed} failed, ${e.skipped} skipped` });
    else if (e.task) {
      // The latest row for that task.
      let row = null;
      for (let i = rows.length - 1; i >= 0 && !row; i--) if (rows[i].task === e.task) row = rows[i];
      if (!row) rows.push((row = { task: e.task, state: 'running', msg: '', tries: 0 }));
      if (e.type === 'task_ok') {
        row.state = e.changed ? 'changed' : 'ok';
        if (e.msg) row.msg = typeof e.msg === 'string' ? e.msg : JSON.stringify(e.msg);
        if (e.censored) row.msg = 'output hidden';
      } else if (e.type === 'task_skipped') row.state = 'skipped';
      else if (e.type === 'task_retry') row.tries = e.attempt || row.tries + 1;
      else if (e.type === 'task_failed') {
        row.state = e.ignored ? 'ignored' : 'failed';
        row.msg = [e.msg, e.stderr, e.stdout].filter(Boolean).join('\n');
      }
    }
  }

  function close() {
    source?.close();
    source = null;
  }

  $effect(() => {
    if (!runId || runId === current) return;
    // A new run: start over from what the page loaded.
    close();
    current = runId;
    rows = [];
    ended = null;
    lost = false;
    for (const e of initial) add(e);
    if (ended) return;
    const es = new EventSource(`/api/deploys/${deployId}/events?run=${encodeURIComponent(runId)}&offset=${offset}`);
    source = es;
    const on = (ev) => {
      try {
        add(JSON.parse(ev.data));
      } catch {
        /* skip a damaged event */
      }
      if (ended) {
        close();
        ondone(ended);
      }
    };
    for (const t of ['play_start', 'task_start', 'task_ok', 'task_failed', 'task_skipped', 'task_retry', 'recap', 'stderr', 'done']) es.addEventListener(t, on);
    es.onerror = () => {
      // The browser reconnects by itself and sends the last offset it saw.
      lost = es.readyState === EventSource.CLOSED;
    };
  });

  onDestroy(close);

  const MARK = { ok: 'ok', changed: 'done', skipped: 'skip', failed: 'FAILED', ignored: 'failed, ignored', running: '…' };
  const shown = $derived(rows.filter((r) => r.head || r.note || r.state !== 'skipped'));
</script>

<div class="well log mono" role="log" aria-live="polite">
  {#each shown as r, i (i)}
    {#if r.head}
      <div class="head">{r.head}</div>
    {:else if r.note}
      <div class="dim">{r.note}</div>
    {:else}
      <div class="row {r.state}">
        <span class="mark">{MARK[r.state]}</span>
        <span class="task">{r.task}{#if r.tries} <span class="dim">(attempt {r.tries})</span>{/if}</span>
      </div>
      {#if r.msg && (r.state === 'failed' || r.state === 'ignored' || r.msg.length < 600)}<pre class:bad={r.state === 'failed'}>{r.msg}</pre>{/if}
    {/if}
  {:else}
    <div class="dim">Waiting for the first step…</div>
  {/each}
  {#if ended}
    <div class="end {ended.status === 'succeeded' ? 's-done' : 's-failed'}">
      {ended.status === 'succeeded' ? 'Run finished.' : ended.status === 'timeout' ? 'Run stopped: over its time limit.' : ended.status === 'interrupted' ? 'Run cut off by a console restart.' : 'Run failed.'}
    </div>
  {:else if lost}
    <div class="s-failed">Lost the live connection. Reload the page to see the rest.</div>
  {/if}
</div>

<style>
  .log {
    padding: 12px 14px;
    font-size: 12.5px;
    line-height: 1.55;
    max-height: 520px;
    overflow: auto;
  }
  .head {
    color: var(--cyan-soft);
    margin-bottom: 4px;
  }
  .row {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 10px;
  }
  .mark {
    color: var(--ink-2);
  }
  .row.changed .mark,
  .row.ok .mark {
    color: var(--good);
  }
  .row.failed .mark,
  .row.failed .task {
    color: var(--critical);
  }
  .row.ignored .mark {
    color: var(--warn);
  }
  .row.running .task {
    color: var(--cyan);
  }
  pre {
    margin: 2px 0 6px 74px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--ink-2);
    font: inherit;
  }
  pre.bad {
    color: var(--critical);
  }
  .end {
    margin-top: 8px;
    font-weight: 500;
  }
</style>
