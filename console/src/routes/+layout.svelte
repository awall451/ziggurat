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

  // Focus mode (#93, several at once since #115): every team in focus, one line each under the header.
  const focusing = $derived(page.data.focusAll || []);
  let stopping = $state('');
  let focusProblem = $state({ id: '', text: '' });
  const fwhen = (secs) => new Date(secs * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  async function stopFocus(id) {
    stopping = id;
    focusProblem = { id: '', text: '' };
    try {
      const r = await fetch('/api/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop', project: id }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.message || 'That did not work');
      await invalidateAll();
    } catch (e) {
      focusProblem = { id, text: e.message };
    } finally {
      stopping = '';
    }
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} · Ziggurat` : 'Ziggurat'}</title>
</svelte:head>

<div class="app" style="--accent: {project?.accent || '#4fd8ff'}">
  <header class="bar" class:band={!!project}>
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
    <!-- A project names itself in its own header, under this bar (with its colour band). -->
    <span class="crumbs">
      {#if !project && page.url.pathname.startsWith('/new')}
        <span class="here">New project</span>
      {:else if !project && page.url.pathname.startsWith('/settings')}
        <span class="here">Settings</span>
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
  {#each focusing as focus (focus.id)}
    <div class="focusbar" role="status">
      <span><b>Focus:</b> <a href="/p/{focus.id}/topology">{focus.name}</a> runs cycles back to back{focus.until ? ` until ${fwhen(focus.until)}` : focus.cycles ? ` · ${focus.done} of ${focus.cycles} cycles` : ' until you switch it off'} · at most {focus.perDay} a day{focus.hold ? ` · planned jobs first: next the ${focus.hold.kind === 'once' ? 'one-time cycle' : focus.hold.kind === 'plan' ? 'planning cycle' : 'job'} set for ${fwhen(focus.hold.at)}` : ''}</span>
      {#if focusProblem.id === focus.id}<span class="s-failed small">{focusProblem.text}</span>{/if}
      <button class="btn quiet sm" onclick={() => stopFocus(focus.id)} disabled={!!stopping} aria-label="Stop the focus on {focus.name}">{stopping === focus.id ? 'Stopping…' : 'Stop'}</button>
    </div>
  {/each}
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
  /* A project's colour across the top of every one of its pages (it stays with the sticky bar). */
  .bar.band {
    border-top: 4px solid var(--accent);
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
