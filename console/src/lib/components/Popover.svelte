<script>
  // A small panel anchored to the button that opened it: for a field and its
  // action (a date and Set), so fields never sit inside a row of buttons.
  // The parent owns `open`; Escape or a click outside calls onclose.
  //
  // The panel is moved to the end of <body> and placed with fixed
  // coordinates: inside a glass panel (backdrop-filter) it would otherwise be
  // painted under the next card, whatever its z-index.
  let { open = false, onclose = () => {}, align = 'end', block = false, trigger, children } = $props();
  let anchor = $state(null);
  let pop = $state(null);
  let pos = $state({ top: -9999, left: -9999 });

  function place() {
    if (!anchor || !pop) return;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = align === 'start' ? r.left : r.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    // No room below: open upwards.
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pos = { top, left };
  }
  function portal(node) {
    document.body.appendChild(node);
    pop = node;
    place();
    // Its content can change (a menu, then a date field): place it again.
    const seen = new ResizeObserver(() => place());
    seen.observe(node);
    return {
      destroy() {
        seen.disconnect();
        node.remove();
        pop = null;
      }
    };
  }
  $effect(() => {
    if (!open) return;
    const again = () => place();
    window.addEventListener('scroll', again, true);
    window.addEventListener('resize', again);
    return () => {
      window.removeEventListener('scroll', again, true);
      window.removeEventListener('resize', again);
    };
  });

  function outside(e) {
    if (!open) return;
    if (anchor?.contains(e.target) || pop?.contains(e.target)) return;
    onclose();
  }
  function key(e) {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={key} />

<span class="anchor" class:block bind:this={anchor}>
  {@render trigger?.()}
</span>
{#if open}
  <div class="pop panel lit" role="dialog" use:portal style="top: {pos.top}px; left: {pos.left}px">
    {@render children?.()}
  </div>
{/if}

<style>
  .anchor {
    display: inline-flex;
  }
  /* A field-like trigger that fills its column. */
  .anchor.block {
    display: flex;
    width: 100%;
    min-width: 0;
  }
  .pop {
    position: fixed;
    z-index: 70;
    min-width: 240px;
    max-width: calc(100vw - 16px);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--panel-solid);
  }
</style>
