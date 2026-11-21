<script>
  // A small panel anchored to the button that opened it: for a field and its
  // action (a date and Set), so fields never sit inside a row of buttons.
  // The parent owns `open`; Escape or a click outside calls onclose.
  let { open = false, onclose = () => {}, align = 'end', trigger, children } = $props();
  let box = $state(null);

  function outside(e) {
    if (open && box && !box.contains(e.target)) onclose();
  }
  function key(e) {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={key} />

<span class="anchor" bind:this={box}>
  {@render trigger?.()}
  {#if open}
    <div class="pop panel lit" class:start={align === 'start'} role="dialog">
      {@render children?.()}
    </div>
  {/if}
</span>

<style>
  .anchor {
    position: relative;
    display: inline-flex;
  }
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    min-width: 240px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--panel-solid, #0b1830);
  }
  .pop.start {
    right: auto;
    left: 0;
  }
</style>
