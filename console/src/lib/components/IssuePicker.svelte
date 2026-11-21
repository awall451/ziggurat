<script>
  // Find an issue to link: type its number or words from its title, and pick
  // from the matches (arrow keys and Enter work too). The list opens in a
  // Popover, so a scrolling column cannot cut it off.
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';
  import { KIND_WORD, STATUS_WORD } from '$lib/issues.js';

  let { issues = [], exclude = [], disabled = false, placeholder = 'Search: #12 or words of a title', onpick = () => {} } = $props();

  let query = $state('');
  let focused = $state(false);
  let hi = $state(0);
  let list = $state(null);

  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '');
    if (!q) return [];
    const words = q.split(/\s+/).filter(Boolean);
    const skip = new Set(exclude);
    return issues
      .filter((i) => Number.isInteger(i.number) && !skip.has(i.number))
      .filter((i) => (/^\d+$/.test(q) ? String(i.number).startsWith(q) : words.every((w) => i.title.toLowerCase().includes(w))))
      .sort((a, b) => (/^\d+$/.test(q) ? a.number - b.number : b.number - a.number))
      .slice(0, 8);
  });
  const open = $derived(focused && query.trim().length > 0);

  function pick(i) {
    if (!i) return;
    onpick(i);
    query = '';
    hi = 0;
  }
  function key(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!matches.length) return;
      hi = (hi + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      list?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[hi]);
    } else if (e.key === 'Escape' && query) {
      e.stopPropagation();
      query = '';
    }
  }
  $effect(() => {
    query;
    hi = 0;
  });
</script>

<Popover {open} onclose={() => (focused = false)} align="start" block>
  {#snippet trigger()}
    <span class="box field" class:off={disabled}>
      <Icon name="search" size={14} />
      <input
        type="text"
        bind:value={query}
        {placeholder}
        {disabled}
        aria-label="Find an issue to link"
        aria-autocomplete="list"
        onfocus={() => (focused = true)}
        onblur={() => (focused = false)}
        onkeydown={key}
      />
    </span>
  {/snippet}
  <ul class="opts" role="listbox" bind:this={list}>
    {#each matches as i, n (i.id)}
      <li>
        <button type="button" role="option" aria-selected={n === hi} class:on={n === hi} data-i={n} onpointerdown={(e) => e.preventDefault()} onclick={() => pick(i)}>
          <span class="kind {i.kind}">{KIND_WORD[i.kind] || i.kind}</span>
          <span class="mono num">#{i.number}</span>
          <span class="t">{i.title}</span>
          <span class="st">{STATUS_WORD[i.status] || i.status}</span>
        </button>
      </li>
    {:else}
      <li class="none small dim">No issue matches “{query.trim()}”.</li>
    {/each}
  </ul>
</Popover>

<style>
  .box {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    color: var(--ink-2);
  }
  .box.off {
    opacity: 0.6;
  }
  .box input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    color: var(--ink);
    font: inherit;
    padding: 0;
  }
  .opts {
    list-style: none;
    margin: -6px;
    padding: 0;
    width: min(420px, calc(100vw - 40px));
    max-height: 300px;
    overflow-y: auto;
  }
  .opts button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-size: 13px;
  }
  .opts button.on,
  .opts button:hover {
    background: rgba(var(--glow), 0.14);
  }
  .kind {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    flex: none;
    width: 46px;
  }
  .kind.bug {
    color: var(--critical);
  }
  .kind.polish {
    color: var(--warn);
  }
  .kind.idea {
    color: var(--cyan);
  }
  .kind.planned {
    color: var(--accent);
  }
  .num {
    color: var(--ink-2);
    flex: none;
  }
  .t {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    flex: none;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .none {
    padding: 6px 8px;
  }
</style>
