<script>
  // Draw on a screenshot (box, ellipse, freehand) and write a note about it.
  // The drawing is MarkupCanvas; on save it is also flattened onto the
  // screenshot as a PNG, which is what the lead looks at.
  import Icon from './Icon.svelte';
  import MarkupCanvas from './MarkupCanvas.svelte';

  let { src, name = '', onsave = async () => {}, oncancel = () => {} } = $props();

  let shapes = $state([]);
  let title = $state('');
  let body = $state('');
  let kind = $state('bug');
  let saving = $state(false);
  let err = $state('');
  let drawing = $state();

  async function save() {
    err = '';
    if (!title.trim()) {
      err = 'Give the note a short title';
      return;
    }
    saving = true;
    try {
      const blob = await drawing.flatten();
      await onsave({ title: title.trim(), body: body.trim(), kind, markup: $state.snapshot(shapes), blob });
    } catch (e) {
      err = e.message || 'Could not save';
    } finally {
      saving = false;
    }
  }

  function key(e) {
    if (e.key === 'Escape') oncancel();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      drawing?.undo();
    }
  }
</script>

<svelte:window onkeydown={key} />

<div class="wrap" role="dialog" aria-modal="true" aria-label="Leave a note on {name}">
  <button class="shade" onclick={oncancel} aria-label="Cancel"></button>
  <div class="box panel lit">
    <header>
      <h2>Note on <span class="cap">{name}</span></h2>
      <button class="btn quiet" onclick={oncancel} aria-label="Cancel"><Icon name="x" size={14} /></button>
    </header>

    <MarkupCanvas bind:this={drawing} {src} bind:shapes />

    <div class="form">
      <input class="field" placeholder="Short title, e.g. Names box overlaps the victory box" bind:value={title} maxlength="200" />
      <select class="field" bind:value={kind}>
        <option value="bug">Bug</option>
        <option value="polish">Polish</option>
        <option value="idea">Idea</option>
      </select>
    </div>
    <textarea class="field" rows="3" placeholder="Details (optional)" bind:value={body}></textarea>

    {#if err}<div class="s-failed small">{err}</div>{/if}
    <div class="foot">
      <span class="dim small">Goes to the Issues board. The lead triages it and hands it to the team.</span>
      <button class="btn" onclick={oncancel}>Cancel</button>
      <button class="btn go" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Raise issue'}</button>
    </div>
  </div>
</div>

<style>
  .wrap {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 32px 16px;
    overflow: auto;
  }
  .shade {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 14, 0.88);
    border: 0;
  }
  .box {
    position: relative;
    width: min(1100px, 100%);
    padding: 16px;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .cap {
    text-transform: capitalize;
  }






  .form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }
  textarea {
    resize: vertical;
    font: inherit;
  }
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .foot .dim {
    flex: 1;
  }
  .go {
    border-color: var(--accent);
    background: rgba(var(--glow), 0.25);
  }
</style>
