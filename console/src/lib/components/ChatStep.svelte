<script>
  // One step of the lead's answer in the Chat tab, in the manner of Claude
  // Code: a line with the tool and what it was given; opened, the input in
  // full (IN) and what came back (OUT), each in its own code block. The
  // output is fetched when the step is opened. Everything here was written
  // by an agent: it is shown as text (shell commands through the escaping
  // highlighter), never as HTML.
  import { untrack } from 'svelte';
  import { highlightShell } from '$lib/highlight.js';

  // expandAll: a {open, at} the thread sets with Ctrl+O, to open or close every step at once.
  let { step, url = '', pending = false, expandAll = null } = $props();

  let open = $state(false);
  let detail = $state(null);
  let loading = $state(false);
  let problem = $state('');
  let copied = $state(false);

  async function toggle() {
    setOpen(!open);
  }
  // Every step at once (Ctrl+O): follow the thread's latest wish; a click on one step still works after.
  $effect(() => {
    const want = expandAll;
    if (want) untrack(() => setOpen(want.open));
  });
  async function setOpen(want) {
    open = want;
    if (!open || detail || loading || !url) return;
    loading = true;
    problem = '';
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status === 404 ? 'This step is not on the console (yet).' : 'Could not load this step.');
      detail = await r.json();
    } catch (e) {
      problem = e.message;
    } finally {
      loading = false;
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(detail?.input?.code || '');
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* no clipboard: nothing to do */
    }
  }
  const fmt = (n) => Number(n || 0).toLocaleString();
  const toolClass = (t) => (['Bash', 'Read', 'Grep', 'Glob'].includes(t) ? t.toLowerCase() : 'other');
</script>

<div class="step" class:open class:fail={step.ok === false}>
  <button class="head" onclick={toggle} aria-expanded={open}>
    <span class="state" class:ok={step.ok === true} class:bad={step.ok === false} class:run={pending} aria-hidden="true"></span>
    <span class="tool {toolClass(step.tool)}">{step.tool}</span>
    <span class="sum">{step.text}</span>
    {#if step.outLines}<span class="lines">{fmt(step.outLines)} line{step.outLines > 1 ? 's' : ''}</span>{/if}
    <span class="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
  </button>

  {#if open}
    <div class="body">
      {#if loading}
        <p class="dim small pad">Loading…</p>
      {:else if problem}
        <p class="small pad s-failed">{problem}</p>
      {:else if detail}
        <div class="row">
          <span class="lbl">IN</span>
          <div class="block in">
            {#if detail.input?.notes?.length}
              <div class="notes">
                {#each detail.input.notes as n (n.label)}<span><span class="dim">{n.label}</span> {n.value}</span>{/each}
              </div>
            {/if}
            <div class="code-wrap">
              {#if detail.input?.lang === 'bash'}
                <pre class="code"><code>{@html highlightShell(detail.input.code)}</code></pre>
              {:else}
                <pre class="code"><code>{detail.input?.code}</code></pre>
              {/if}
              <button class="copy" onclick={copy} title="Copy">{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        </div>
        <div class="row">
          <span class="lbl">OUT</span>
          <div class="block out" class:err={detail.ok === false}>
            {#if detail.output}
              <pre class="code scroll"><code>{detail.output}</code></pre>
              {#if detail.truncated}<div class="foot">The first {fmt(detail.output.split('\n').length)} of {fmt(detail.outLines)} lines.</div>{/if}
            {:else if detail.ok === null}
              <p class="dim small pad">Still running…</p>
            {:else}
              <p class="dim small pad">No output.</p>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .step {
    border: 1px solid transparent;
    border-radius: 8px;
    transition: border-color 0.15s, background 0.15s;
  }
  .step.open {
    border-color: var(--line);
    background: rgba(var(--glow), 0.03);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    background: none;
    border: 0;
    border-radius: 8px;
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .head:hover {
    background: rgba(var(--glow), 0.06);
  }
  .state {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
  }
  .state.ok {
    background: var(--good);
  }
  .state.bad {
    background: var(--critical);
  }
  .state.run {
    background: var(--warn);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .tool {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 4px;
    border: 1px solid currentColor;
  }
  .tool.bash {
    color: #fbbf24;
  }
  .tool.read {
    color: #4fd8ff;
  }
  .tool.grep {
    color: #c4a5ff;
  }
  .tool.glob {
    color: #5eead4;
  }
  .tool.other {
    color: var(--ink-2);
  }
  .sum {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .step.fail .sum {
    color: var(--critical);
  }
  .lines,
  .chev {
    flex: none;
    color: var(--muted);
    font-size: 11px;
  }
  .body {
    padding: 2px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
  }
  .lbl {
    padding-top: 9px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .block {
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  .block.err {
    border-color: color-mix(in srgb, var(--critical) 60%, var(--line));
  }
  .notes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 7px 12px 0;
    font-size: 11.5px;
  }
  .code-wrap {
    position: relative;
  }
  .code {
    margin: 0;
    padding: 9px 12px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.55;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .in .code {
    padding-right: 64px;
  }
  .scroll {
    max-height: 340px;
    overflow: auto;
  }
  .out .code {
    color: var(--ink-2);
  }
  .err .code {
    color: #fca5a5;
  }
  .copy {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 8px;
    font-size: 11px;
    color: var(--muted);
    background: var(--panel-solid);
    border: 1px solid var(--line);
    border-radius: 5px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .code-wrap:hover .copy,
  .copy:focus-visible {
    opacity: 1;
  }
  .foot {
    padding: 5px 12px;
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid var(--line);
  }
  .pad {
    margin: 0;
    padding: 9px 12px;
  }
  .code :global(.hl-cmd) {
    color: #7dd3fc;
    font-weight: 600;
  }
  .code :global(.hl-flag) {
    color: #c4a5ff;
  }
  .code :global(.hl-str) {
    color: #86efac;
  }
  .code :global(.hl-op) {
    color: #fbbf24;
  }
  .code :global(.hl-com) {
    color: var(--muted);
    font-style: italic;
  }
</style>
