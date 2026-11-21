<script>
  // Small line icons, drawn here so the app loads nothing from outside.
  let { name, size = 20, label = null } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : null}
  aria-label={label}
  aria-hidden={label ? null : 'true'}
>
  {#if name === 'ziggurat'}
    <rect x="8.5" y="4" width="7" height="4.5" fill="currentColor" stroke="none" />
    <rect x="5" y="9.75" width="14" height="4.5" fill="currentColor" stroke="none" />
    <rect x="1.5" y="15.5" width="21" height="4.5" fill="currentColor" stroke="none" />
  {:else if name === 'area_lead'}
    <path d="M12 3 L20 8 V16 L12 21 L4 16 V8 Z" />
    <circle cx="12" cy="12" r="2.5" />
  {:else if name === 'worker'}
    <path d="M9 7 L4 12 L9 17" />
    <path d="M15 7 L20 12 L15 17" />
    <path d="M13.5 5 L10.5 19" />
  {:else if name === 'scout'}
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15 L20.5 20.5" />
  {:else if name === 'reviewer'}
    <path d="M2.5 12 C5 7 8.5 5 12 5 C15.5 5 19 7 21.5 12 C19 17 15.5 19 12 19 C8.5 19 5 17 2.5 12 Z" />
    <circle cx="12" cy="12" r="3" />
  {:else if name === 'qa'}
    <path d="M12 3 L20 6 V12 C20 16.5 16.5 19.5 12 21 C7.5 19.5 4 16.5 4 12 V6 Z" />
    <path d="M8.5 12 L11 14.5 L15.5 9.5" />
  {:else if name === 'check'}
    <path d="M5 12.5 L10 17.5 L19 7" />
  {:else if name === 'x'}
    <path d="M6 6 L18 18 M18 6 L6 18" />
  {:else if name === 'refresh'}
    <path d="M20 12 A8 8 0 1 1 17.5 6.2" />
    <path d="M20 4 V8.5 H15.5" />
  {:else if name === 'plus'}
    <path d="M12 5 V19 M5 12 H19" />
  {:else if name === 'minus'}
    <path d="M5 12 H19" />
  {:else if name === 'fit'}
    <path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15" />
  {:else if name === 'pencil'}
    <path d="M4 20 L8.5 19 L19 8.5 A2.1 2.1 0 0 0 16 5.5 L5.5 16 Z M14 7.5 L17 10.5" />
  {:else if name === 'chevron'}
    <path d="M6 9 L12 15 L18 9" />
  {:else if name === 'search'}
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20 L15.5 15.5" />
  {:else}
    <circle cx="12" cy="12" r="4" />
  {/if}
</svg>
