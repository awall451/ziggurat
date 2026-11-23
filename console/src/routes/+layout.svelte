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
  import Popover from '$lib/components/Popover.svelte';

  let { children } = $props();
  // Which tab of the header is the current one. Settings is neither.
  const section = $derived(page.url.pathname.startsWith('/schedule') ? 'schedule' : page.url.pathname.startsWith('/settings') ? null : 'projects');

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

  // Phone width: the sections and Settings are in a menu. It closes when the page changes.
  let menu = $state(false);
  $effect(() => {
    page.url.pathname;
    menu = false;
  });
  const crumb = $derived(project || /^\/(new|settings)/.test(page.url.pathname));

  // Focus mode (#93): the team in focus, shown under the header on every page.
  const focus = $derived(page.data.focusNow || null);
  let stopping = $state(false);
  let focusProblem = $state('');
  const fwhen = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  async function stopFocus() {
    stopping = true;
    focusProblem = '';
    try {
      const r = await fetch('/api/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop', project: focus.id }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.message || 'That did not work');
      await invalidateAll();
    } catch (e) {
      focusProblem = e.message;
    } finally {
      stopping = false;
    }
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} · Ziggurat` : 'Ziggurat'}</title>
</svelte:head>

<div class="app" style="--accent: {project?.accent || '#4fd8ff'}">
  <header class="bar">
    <a class="brand" class:short={crumb} href="/">
      <span class="logo"><Icon name="ziggurat" size={26} /></span>
      <span class="word">Ziggurat</span>
    </a>
    <span class="sep"></span>
    <!-- The sections of the console. More can be added here. -->
    <nav class="tabs" aria-label="Sections">
      <a class:on={section === 'projects'} aria-current={section === 'projects' ? 'page' : undefined} href="/">Projects</a>
      <a class:on={section === 'schedule'} aria-current={section === 'schedule' ? 'page' : undefined} href="/schedule">Schedule</a>
    </nav>
    <span class="crumbs">
      {#if project}
        <span class="dim slash">/</span><span class="here">{project.name}</span>
        <span class="chip mono">{project.theme}</span>
      {:else if page.url.pathname.startsWith('/new')}
        <span class="dim slash">/</span><span class="here">New project</span>
      {:else if page.url.pathname.startsWith('/settings')}
        <span class="dim slash">/</span><span class="here">Settings</span>
      {/if}
    </span>
    <span class="grow"></span>
    <a class="small settings" href="/settings">Settings</a>
    <span class="narrow">
      <Popover open={menu} onclose={() => (menu = false)}>
        {#snippet trigger()}
          <button class="btn quiet icon" aria-label="Menu" aria-haspopup="true" aria-expanded={menu} onclick={() => (menu = !menu)}><Icon name="menu" size={18} /></button>
        {/snippet}
        <a class="menuitem" class:on={section === 'projects'} aria-current={section === 'projects' ? 'page' : undefined} href="/">Projects</a>
        <a class="menuitem" class:on={section === 'schedule'} aria-current={section === 'schedule' ? 'page' : undefined} href="/schedule">Schedule</a>
        <a class="menuitem" class:on={page.url.pathname.startsWith('/settings')} href="/settings">Settings</a>
      </Popover>
    </span>
  </header>
  {#if focus}
    <div class="focusbar" role="status">
      <span><b>Focus:</b> <a href="/p/{focus.id}/topology">{focus.name}</a> runs cycles back to back{focus.until ? ` until ${fwhen(focus.until)}` : focus.cycles ? ` · ${focus.done} of ${focus.cycles} cycles` : ' until you switch it off'} · at most {focus.perDay} a day</span>
      {#if focusProblem}<span class="s-failed small">{focusProblem}</span>{/if}
      <button class="btn quiet sm" onclick={stopFocus} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop'}</button>
    </div>
  {/if}
  <main>
    {@render children()}
  </main>
</div>

<style>
  .focusbar {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    padding: 6px 16px;
    font-size: 13px;
    color: var(--cyan-soft);
    background: rgba(var(--glow), 0.08);
    border-bottom: 1px solid var(--line);
  }
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
  .tabs {
    display: flex;
    align-self: stretch;
    gap: 4px;
  }
  .tabs a {
    display: flex;
    align-items: center;
    padding: 0 12px;
    color: var(--ink-2);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    font-weight: 500;
  }
  .tabs a:hover {
    color: var(--ink-strong);
  }
  .tabs a.on {
    color: var(--ink-strong);
    border-bottom-color: var(--cyan);
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
  .narrow {
    display: none;
  }
  /* Phone width: the logo, where you are, and a menu. */
  @media (max-width: 700px) {
    .bar {
      padding: 0 12px;
      gap: 10px;
    }
    .tabs,
    .sep,
    .chip,
    .slash,
    .settings,
    .brand.short .word {
      display: none;
    }
    .narrow {
      display: inline-flex;
    }
    .here {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
