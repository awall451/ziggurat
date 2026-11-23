<script>
  // "Run a cycle now" (#94, kit 0.25): one normal cycle with no job; the lead
  // picks its work. `rc` is runCycle from the project view: {can, why, halted,
  // atCap, today, cap, typical: {secs, costUsd, n}}.
  import { invalidateAll } from '$app/navigation';
  import { usd } from '$lib/format.js';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

  let { id, name, rc, quietNow = false, small = false, showWhy = false, ondone } = $props();

  let confirm = $state(null);
  let pastCap = $state(false);
  let busy = $state(false);
  let problem = $state('');

  // The dialog is moved to <body>: inside a panel (backdrop blur) a fixed box would be held by the panel.
  function portal(node) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const length = (secs) => (secs >= 3600 ? `${Math.floor(secs / 3600)} h ${String(Math.round((secs % 3600) / 60)).padStart(2, '0')} min` : `${Math.max(1, Math.round(secs / 60))} min`);

  function typicalText(t) {
    if (!t?.n || !Number.isFinite(t.secs)) return 'No finished cycles of this team yet to say how long one takes.';
    const cost = Number.isFinite(t.costUsd) ? `, about ${usd(t.costUsd)} of usage` : '';
    return `A cycle of ${name} typically takes about ${length(t.secs)}${cost} (the median of its last ${t.n}).`;
  }

  function ask() {
    problem = '';
    pastCap = false;
    confirm = {
      title: `Run a cycle of ${name} now?`,
      body: [
        'One normal cycle starts now: the lead picks the work, as in any cycle.',
        typicalText(rc.typical),
        rc.halted ? 'The team is halted: it halts again when this cycle ends.' : 'When it ends, the team goes back to how it was.',
        quietNow ? 'Now is inside your quiet hours.' : null,
        'It counts toward the daily cap and spends subscription usage.'
      ]
        .filter(Boolean)
        .join(' '),
      word: 'Run the cycle',
      run
    };
  }

  async function run() {
    busy = true;
    problem = '';
    try {
      const res = await fetch(`/p/${id}/controls/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run-cycle', pastCap }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || `The VM refused (${res.status})`);
      confirm = null;
      ondone?.(out.detail);
      await invalidateAll();
    } catch (e) {
      problem = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<button class="btn {small ? 'quiet sm' : ''}" onclick={ask} disabled={!rc?.can || busy} title={rc?.can ? `One normal cycle of ${name} now, no job` : rc?.why || null}>
  {small ? '▶ Run a cycle' : 'Run a cycle now…'}
</button>
{#if showWhy && rc && !rc.can && rc.why}<span class="small dim">{rc.why}.</span>{/if}

<div use:portal>
<ConfirmDialog confirm={confirm ? { ...confirm, disabled: rc?.atCap && !pastCap } : null} {busy} oncancel={() => (confirm = null)}>
  {#if rc?.atCap}
    <label class="cap">
      <input type="checkbox" bind:checked={pastCap} />
      <span>Today's cap is reached ({rc.today}/{rc.cap}). Run it anyway, past the cap.</span>
    </label>
  {/if}
  {#if problem}<p class="bad" role="alert">{problem}</p>{/if}
</ConfirmDialog>
</div>

<style>
  .cap {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    color: var(--warn);
  }
  .bad {
    margin: 0;
    color: var(--critical);
  }
</style>
