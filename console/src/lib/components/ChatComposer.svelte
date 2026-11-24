<script>
  // The message box of a chat with the lead: the text, and, where the chat
  // takes them, files and the model and effort of the answer. Used by the
  // plan chat on Planning and by the Chat tab. Enter sends only with
  // Ctrl/Cmd; a plain Enter is a new line. The microphone (issue 47) adds
  // spoken words to the text; it never sends.
  import MicButton from '$lib/components/MicButton.svelte';

  let {
    text = $bindable(''),
    placeholder = '',
    rows = 3,
    disabled = false, // nothing can be sent now (the lead is answering, another action runs)
    sending = false,
    hint = '',
    onsend,
    // Files (Chat tab): drafts already uploaded, and how to upload more. No onupload: no files.
    files = $bindable([]),
    onupload = null,
    // Model and effort (Chat tab). `teamModel` names the team's own lead model for "Team default".
    showModel = false,
    model = $bindable(''),
    effort = $bindable(''),
    teamModel = '',
    teamEffort = ''
  } = $props();

  let box = $state(null);
  let picker = $state(null);
  let dragging = $state(false);
  let interim = $state(''); // words being spoken, not final yet
  let problem = $state(''); // why the microphone stopped
  const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const can = $derived(!disabled && !sending && !!text.trim());

  export function focus() {
    box?.focus({ preventScroll: true });
  }

  function keydown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && can) {
      e.preventDefault();
      onsend?.();
    }
  }
  function paste(e) {
    if (!onupload) return;
    const got = [...(e.clipboardData?.files || [])];
    if (got.length) {
      e.preventDefault();
      onupload(got);
    }
  }
  function drop(e) {
    if (!onupload) return;
    e.preventDefault();
    dragging = false;
    onupload([...(e.dataTransfer?.files || [])]);
  }
</script>

<div class="composer" class:dragging role="group" aria-label="Message" ondragover={(e) => { if (onupload) { e.preventDefault(); dragging = true; } }} ondragleave={() => (dragging = false)} ondrop={drop}>
  <textarea class="field" {rows} bind:this={box} bind:value={text} {placeholder} onkeydown={keydown} onpaste={paste}></textarea>
  {#if interim}<div class="small dim interim">{interim}…</div>{/if}
  {#if problem}<div class="small s-failed">{problem}</div>{/if}
  {#if files.length}
    <div class="chips">
      {#each files as f, i (f.token)}
        <span class="chip small">{f.name} <span class="dim">{kb(f.size)}</span>
          <button class="x" aria-label="Remove {f.name}" onclick={() => (files = files.filter((_, j) => j !== i))}>×</button></span>
      {/each}
    </div>
  {/if}
  <div class="row">
    {#if onupload}
      <input type="file" multiple hidden bind:this={picker} onchange={(e) => { onupload([...e.currentTarget.files]); e.currentTarget.value = ''; }} />
      <button class="btn quiet sm" title="Or paste them, or drop them here. Up to 8, 20 MB each." disabled={files.length >= 8} onclick={() => picker?.click()}>Attach</button>
    {/if}
    {#if showModel}
      <select class="field sel" bind:value={model} aria-label="Model" title="Model of the answer">
        <option value="">Team default{teamModel ? ` (${teamModel})` : ''}</option>
        {#each MODELS as m (m)}<option value={m}>{m}</option>{/each}
      </select>
      <select class="field sel" bind:value={effort} aria-label="Thinking effort" title="Thinking effort of the answer">
        <option value="">Effort: default{teamEffort ? ` (${teamEffort})` : ''}</option>
        {#each EFFORTS as e (e)}<option value={e}>{e}</option>{/each}
      </select>
    {/if}
    <MicButton bind:text bind:interim bind:problem disabled={sending} />
    <span class="small dim grow">{hint}</span>
    <button class="btn primary" disabled={!can} onclick={() => onsend?.()}>{sending ? 'Sending…' : 'Send'}</button>
  </div>
</div>

<style>
  .composer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-radius: 8px;
  }
  .composer.dragging {
    outline: 2px dashed var(--accent);
    outline-offset: 2px;
  }
  textarea {
    width: 100%;
    margin: 0;
    box-sizing: border-box;
    resize: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .sel {
    width: auto;
    padding: 4px 6px;
    font-size: 12px;
  }
  .interim {
    font-style: italic;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 4px 2px 10px;
  }
  .x {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    font-size: 14px;
  }
  @media (max-width: 640px) {
    .row {
      flex-wrap: wrap;
    }
  }
</style>
