<script>
  // One question before an action that matters.
  // confirm: {title, body, word, danger, run} or null.
  let { confirm = null, busy = false, oncancel } = $props();
</script>

{#if confirm}
  <div class="modal" role="dialog" aria-modal="true" aria-label={confirm.title}>
    <button class="shade" onclick={oncancel} aria-label="Cancel"></button>
    <div class="panel lit box">
      <h2>{confirm.title}</h2>
      <p>{confirm.body}</p>
      <div class="actions end">
        <button class="btn quiet" onclick={oncancel} disabled={busy}>Cancel</button>
        <button class="btn {confirm.danger ? 'danger' : 'primary'}" onclick={confirm.run} disabled={busy}>{busy ? 'Working…' : confirm.word}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  p {
    margin: 0;
  }
  .modal {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .shade {
    position: absolute;
    inset: 0;
    background: rgba(2, 6, 14, 0.8);
    border: 0;
  }
  .box {
    position: relative;
    max-width: 520px;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--panel-solid);
  }
</style>
