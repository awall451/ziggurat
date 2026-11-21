<script>
  // A priority picker with its colour dot inside, like a tracker's: a button
  // showing the dot and the word, and a list to pick from. The list opens in
  // a Popover, so a scrolling column cannot cut it off.
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';
  import { PRIORITIES, PRIORITY_WORD } from '$lib/issues.js';

  let { value = 'normal', disabled = false, onchange = () => {} } = $props();
  let open = $state(false);
  let hi = $state(0);
  let list = $state(null);

  function toggle() {
    open = !open;
    hi = Math.max(0, PRIORITIES.findIndex(([k]) => k === value));
    if (open) queueMicrotask(() => list?.querySelector(`[data-i="${hi}"]`)?.focus());
  }
  function pick(k) {
    open = false;
    if (k !== value) onchange(k);
  }
  function key(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      hi = (hi + (e.key === 'ArrowDown' ? 1 : PRIORITIES.length - 1)) % PRIORITIES.length;
      list?.querySelector(`[data-i="${hi}"]`)?.focus();
    }
  }
</script>

<Popover {open} onclose={() => (open = false)} align="start" block>
  {#snippet trigger()}
    <button type="button" class="field pick" {disabled} aria-haspopup="listbox" aria-expanded={open} onclick={toggle}>
      <span class="dot prio-{value}"></span>
      <span class="word">{PRIORITY_WORD[value] || value}</span>
      <Icon name="chevron" size={14} />
    </button>
  {/snippet}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <ul class="opts" role="listbox" bind:this={list} onkeydown={key}>
    {#each PRIORITIES as [k, w], i (k)}
      <li>
        <button type="button" role="option" aria-selected={k === value} class:on={k === value} data-i={i} onclick={() => pick(k)}>
          <span class="dot prio-{k}"></span>{w}
        </button>
      </li>
    {/each}
  </ul>
</Popover>

<style>
  .pick {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    cursor: pointer;
  }
  .pick:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .word {
    flex: 1;
  }
  .opts {
    list-style: none;
    margin: -6px;
    padding: 0;
    min-width: 180px;
  }
  .opts button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .opts button:hover,
  .opts button:focus-visible,
  .opts button.on {
    background: rgba(var(--glow), 0.14);
    outline: none;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
  }
  .prio-urgent {
    background: var(--critical);
  }
  .prio-high {
    background: #fb923c;
  }
  .prio-normal {
    background: var(--accent);
  }
  .prio-low {
    background: var(--muted);
  }
</style>
