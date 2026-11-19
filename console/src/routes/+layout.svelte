<script>
  import '@fontsource/inter/400.css';
  import '@fontsource/inter/500.css';
  import '@fontsource/inter/600.css';
  import '@fontsource/jetbrains-mono/400.css';
  import '@fontsource/jetbrains-mono/500.css';
  import '@fontsource/space-grotesk/600.css';
  import '../app.css';
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import Icon from '$lib/components/Icon.svelte';

  let { children } = $props();

  // Keep every page current while its tab is visible.
  onMount(() => {
    document.getElementById('boot')?.remove();
    const t = setInterval(() => {
      // A refresh cut short by leaving the page is not an error.
      if (document.visibilityState === 'visible') invalidateAll().catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  });

  const project = $derived(page.data.project || null);
</script>

<svelte:head>
  <title>{project ? `${project.name} · Ziggurat` : 'Ziggurat'}</title>
</svelte:head>

<div class="app" style="--accent: {project?.accent || '#4fd8ff'}">
  <header class="bar">
    <a class="brand" href="/">
      <span class="logo"><Icon name="ziggurat" size={26} /></span>
      <span class="word">Ziggurat</span>
    </a>
    <span class="sep"></span>
    <nav class="crumbs">
      {#if project}
        <a href="/">Projects</a><span class="dim">/</span><span class="here">{project.name}</span>
        <span class="chip mono">{project.theme}</span>
      {:else if page.url.pathname.startsWith('/new')}
        <a href="/">Projects</a><span class="dim">/</span><span class="here">New project</span>
      {:else if page.url.pathname.startsWith('/settings')}
        <a href="/">Projects</a><span class="dim">/</span><span class="here">Settings</span>
      {:else}
        <span class="here">Projects</span>
      {/if}
    </nav>
    <span class="grow"></span>
    <a class="small" href="/settings">Settings</a>
  </header>
  <main>
    {@render children()}
  </main>
</div>

<style>
  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .bar {
    height: 56px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 24px;
    background: var(--bar);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 20;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--ink-strong);
  }
  .logo {
    color: var(--cyan);
    display: flex;
    filter: drop-shadow(0 0 8px rgba(var(--glow), 0.6));
  }
  .word {
    font-family: var(--font-head);
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .sep {
    width: 1px;
    height: 24px;
    background: var(--line);
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .grow {
    flex: 1;
  }
  .here {
    font-weight: 500;
    color: var(--ink);
  }
  .chip {
    margin-left: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: 12px;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
