<script>
  // A project's tile: its picture, or the first letter of its name on its
  // accent colour. Used beside the name in a project's header and in the
  // project switcher.
  let { name = '', accent = '#4fd8ff', avatar = null, size = 40 } = $props();
  const letter = $derived((String(name).trim()[0] || '?').toUpperCase());
</script>

<span class="tile" style="--size: {size}px; --tile: {accent || '#4fd8ff'}" aria-hidden="true">
  {#if avatar}<img src={avatar} alt="" />{:else}{letter}{/if}
</span>

<style>
  .tile {
    flex: none;
    width: var(--size);
    height: var(--size);
    border-radius: calc(var(--size) * 0.23);
    background: var(--tile);
    color: #050b17;
    font-family: var(--font-head);
    font-weight: 700;
    font-size: calc(var(--size) * 0.55);
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
