<script>
  // A dialog over the page: a shade, Escape or the shade closes it. The
  // content and its action rows come from the parent.
  import Icon from '$lib/components/Icon.svelte';
  let { title = '', onclose = () => {}, wide = false, header = null, children } = $props();
  function key(e) {
    if (e.key === 'Escape') onclose();
  }
  // Shown from inside a panel (whose backdrop blur would hold a fixed box), the dialog is moved to <body>.
  function portal(node) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

<svelte:window onkeydown={key} />

<div class="wrap" role="dialog" aria-modal="true" aria-label={title} use:portal>
  <button class="shade" onclick={onclose} aria-label="Close"></button>
  <div class="box panel lit" class:wide>
    <header>
      {#if header}<div class="head">{@render header()}</div>{:else}<h2>{title}</h2>{/if}
      <button class="btn quiet icon" onclick={onclose} aria-label="Close"><Icon name="x" size={14} /></button>
    </header>
    {@render children?.()}
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
    padding: 48px 16px;
    overflow: auto;
  }
  .shade {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 14, 0.82);
    border: 0;
  }
  .box {
    position: relative;
    width: min(620px, 100%);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--panel-solid);
  }
  .box.wide {
    width: min(1200px, 100%);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 17px;
  }
  .head {
    flex: 1;
    min-width: 0;
  }
</style>
