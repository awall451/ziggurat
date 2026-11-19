<script>
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { when } from '$lib/format.js';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import EventStream from '$lib/components/EventStream.svelte';

  let { data } = $props();
  const d = $derived(data.deploy);
  const r = $derived(d.request);

  let busy = $state('');
  let problem = $state('');
  let confirm = $state(null);
  let now = $state(Date.now());

  // While a run is going the state changes on the server: keep asking.
  onMount(() => {
    const t = setInterval(() => {
      now = Date.now();
      if (d.running && document.visibilityState === 'visible') invalidateAll().catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  });

  async function act(step, label) {
    busy = label;
    problem = '';
    try {
      const res = await fetch(`/api/deploys/${d.id}${step ? `/${step}` : ''}`, { method: step ? 'POST' : 'DELETE' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The request failed');
    } catch (e) {
      problem = e.message;
    } finally {
      await invalidateAll().catch(() => {});
      busy = '';
      confirm = null;
    }
  }

  function askCreate() {
    confirm = {
      title: `Create ${r.name} now?`,
      body: `Creates VM ${d.plan.vmid} (${d.plan.ip}) on the target: ${r.cores} cores, ${r.memoryMb / 1024} GB memory, ${r.diskGb} GB disk. This is a real change on the Proxmox host and takes 10 to 30 minutes. The console cannot undo it; removing the VM later is done by hand.`,
      word: 'Create project',
      run: () => act('create', 'create')
    };
  }
  function askAbandon() {
    confirm = {
      title: `Give up on ${r.name}?`,
      body: d.vm?.vmid
        ? `Only this record is closed. VM ${d.vm.vmid} is not touched: if it exists, remove it by hand with the commands shown on this page.`
        : 'Only this record is closed. Nothing was created on the host.',
      word: 'Give up',
      danger: true,
      run: () => act('', 'abandon')
    };
  }

  const STATE = {
    draft: ['Draft', 'idle'],
    'dry-running': ['Dry run going', 'running'],
    planned: ['Dry run done', 'done'],
    'dry-run-failed': ['Dry run failed', 'failed'],
    creating: ['Creating the VM', 'running'],
    created: ['VM created', 'done'],
    'create-failed': ['Create failed', 'failed'],
    abandoned: ['Given up', 'idle']
  };
  const STAGE = { cloned: 'the VM exists; it was still being set up', provisioned: 'the VM is set up; its isolation check did not pass', walled: 'the VM is set up and isolated; the last step failed' };
  const mins = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - now) / 60000));
  const gb = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
</script>

<div class="page">
  <div class="head">
    <h1>{r.name}</h1>
    <span class="pill {STATE[d.state]?.[1] || 'idle'}">{STATE[d.state]?.[0] || d.state}</span>
    <span class="mono small dim">{d.id} · target {r.target}</span>
    <span class="grow"></span>
    <a class="small" href="/new">All deploys</a>
  </div>

  {#if problem}
    <div class="panel note bad" role="alert">{#each problem.split('; ') as line}<div>{line}</div>{/each}</div>
  {/if}
  {#if d.busyElsewhere}
    <div class="panel note caution">Another deploy is running (<a href="/new/{d.busyElsewhere}">{d.busyElsewhere}</a>). One at a time.</div>
  {/if}

  <!-- 1. the team -->
  <section class="panel block">
    <div class="bar">
      <h2>The team</h2>
      <span class="small dim">{r.source.kind === 'example' ? 'example' : 'folder'} {r.source.id} · theme {r.theme}</span>
      <span class="grow"></span>
      {#if d.can.edit}<a class="btn quiet" href="/new?edit={d.id}">Change inputs</a>{/if}
    </div>
    {#if d.bundle.problems.length}
      <div class="panel note bad">
        <b>Fix these before a dry run:</b>
        {#each d.bundle.problems as p}<div>{p}</div>{/each}
      </div>
    {/if}
    {#each d.bundle.warnings as w}<div class="small s-interrupted">{w}</div>{/each}
    {#if d.bundle.agents.length}
      <div class="scroll-x">
        <table class="grid">
          <thead><tr><th>Agent</th><th>Model</th><th>What it does</th></tr></thead>
          <tbody>
            {#each d.bundle.agents as a (a.id)}
              <tr><td class="mono nowrap">{a.id}</td><td class="mono">{a.model || '–'}</td><td class="dim small">{a.description}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <p class="small dim">
      Starting repo: {d.bundle.seed ? `seed folder (${gb(d.bundle.sizes.seed || 0)})` : 'almost empty'}
      {#if d.bundle.files} · extra files copied in: {gb(d.bundle.sizes.files || 0)}{/if}
      {#if d.bundle.domains.length} · needs {d.bundle.domains.join(', ')}{/if}
    </p>
    {#if d.bundle.charter}
      <details>
        <summary>Charter, as the team will read it</summary>
        <pre class="well doc">{d.bundle.charter}</pre>
      </details>
    {/if}
    {#if d.bundle.env}
      <details>
        <summary>Settings the console writes (project.env)</summary>
        <pre class="well doc">{d.bundle.env}</pre>
      </details>
    {/if}
    {#if d.bundle.provision}
      <details open>
        <summary>Provisioning script <span class="s-interrupted small">runs as root inside the new VM</span></summary>
        <pre class="well doc">{d.bundle.provision}</pre>
      </details>
    {/if}
  </section>

  <!-- 2. the plan -->
  <section class="panel block">
    <h2>The plan</h2>
    <dl>
      <div><dt>VM id</dt><dd class="mono">{d.vm?.vmid ?? d.plan?.vmid ?? r.vmid ?? 'next free'}</dd></div>
      <div><dt>Address</dt><dd class="mono">{d.vm?.ip ?? d.plan?.ip ?? 'set by the dry run'}</dd></div>
      <div><dt>Size</dt><dd class="mono">{r.cores} cores · {r.memoryMb / 1024} GB · {r.diskGb} GB disk</dd></div>
      <div><dt>Brakes</dt><dd class="mono">${r.budgetUsd} per cycle · {r.cyclesPerDay} cycles a day</dd></div>
      <div><dt>Models</dt><dd class="mono">{r.leadModel}, then {r.fallbackModel}</dd></div>
      {#if d.preflight}
        <div><dt>Host, checked {when(d.preflight.at)}</dt><dd class="mono">{d.preflight.pool ? `storage ${d.preflight.pool.pct.toFixed(1)}% full` : ''}{d.preflight.memFreeMb != null ? ` · ${(d.preflight.memFreeMb / 1024).toFixed(1)} GB memory free` : ''}</dd></div>
      {/if}
    </dl>
    {#if d.plan?.peers?.length}<p class="small dim">Other agent VMs it will be walled off from: <span class="mono">{d.plan.peers.join(', ')}</span></p>{/if}
    {#each d.preflight?.warnings || [] as w}<div class="small s-interrupted">{w}</div>{/each}

    {#if d.state === 'draft' || d.state === 'dry-run-failed' || d.state === 'planned'}
      <p class="small dim">
        A dry run asks the Proxmox host whether the target is ready and settles the VM id and address. It changes nothing. It does <b>not</b> prove that the
        VM will build: cloning, first boot and the isolation check only happen in the real run.
      </p>
    {/if}
    {#if d.state === 'dry-run-failed' && d.error}
      <div class="panel note bad">{#each d.error.split('; ') as line}<div>{line}</div>{/each}</div>
    {/if}
    {#if d.state === 'planned'}
      {#if d.can.create}
        <div class="panel note good">Dry run passed. "Create project" stays open for {mins(d.planExpiresAt)} more minute{mins(d.planExpiresAt) === 1 ? '' : 's'}.</div>
      {:else}
        <div class="panel note caution">The dry run is too old or the inputs changed. Do a dry run again.</div>
      {/if}
    {/if}

    <div class="actions">
      {#if d.can.abandon}<button class="btn quiet" onclick={askAbandon} disabled={!!busy}>Give up…</button>{/if}
      <span class="grow"></span>
      {#if d.can.dryRun}
        <button class="btn" onclick={() => act('dry-run', 'dry')} disabled={!!busy || !!d.busyElsewhere}>{busy === 'dry' ? 'Starting…' : d.state === 'draft' ? 'Dry run' : 'Dry run again'}</button>
      {/if}
      {#if d.state === 'planned'}
        <button class="btn go" onclick={askCreate} disabled={!!busy || !d.can.create || !!d.busyElsewhere}>Create project…</button>
      {/if}
    </div>
  </section>

  <!-- 3. what happened -->
  {#if d.state === 'created'}
    <section class="panel block ok">
      <h2>The VM is ready</h2>
      <p>
        VM <span class="mono">{d.vm.vmid}</span> at <span class="mono">{d.vm.ip}</span>: isolation checked from inside, snapshot
        <span class="mono">{d.vm.snapshot || 'provisioned'}</span> taken, host key stored. No team is installed yet and nothing in it runs Claude.
      </p>
      <p class="dim small">Installing the kit and the team, signing Claude in and adding the project to the list come with the next step of this feature.</p>
    </section>
  {/if}

  {#if d.state === 'create-failed' && d.failure}
    <section class="panel block bad">
      <h2>The create run failed</h2>
      <p>{d.error}</p>
      <dl>
        <div><dt>How far it got</dt><dd>{STAGE[d.failure.stage] || 'the VM was not finished being cloned'}</dd></div>
        <div><dt>VM {d.vm?.vmid} on the host now</dt><dd>{d.failure.vmExists === true ? 'exists' : d.failure.vmExists === false ? 'not there (or not under this name)' : 'could not be checked'}</dd></div>
      </dl>
      {#if d.failure.canContinue}
        <p>The clone finished, so the same VM can be picked up again: "Continue" waits for it and repeats the checks.</p>
      {:else if d.failure.stage === 'provisioned'}
        <p><b>Do not use this VM.</b> Its isolation could not be proven. It is left running so you can look at it; the console will not continue with it.</p>
      {:else}
        <p>This VM cannot be continued. Remove what is left by hand, then start again with a dry run.</p>
      {/if}
      {#if d.failure.cleanup.length}
        <p class="small dim">To remove it, on the Proxmox host (the console never runs these):</p>
        <pre class="well doc">{d.failure.cleanup.join('\n')}</pre>
      {/if}
      <div class="actions">
        <span class="grow"></span>
        {#if d.can.continue}<button class="btn go" onclick={() => act('continue', 'continue')} disabled={!!busy || !!d.busyElsewhere}>Continue</button>{/if}
      </div>
    </section>
  {/if}

  {#if d.lastRun}
    <section class="panel block">
      <div class="bar">
        <h2>{data.run?.kind === 'dry-run' ? 'Dry run' : 'Create run'}</h2>
        <span class="small dim mono">{d.lastRun}</span>
      </div>
      <EventStream deployId={d.id} runId={d.lastRun} initial={data.events} offset={data.next} ondone={() => invalidateAll().catch(() => {})} />
    </section>
  {/if}
</div>

<ConfirmDialog {confirm} busy={!!busy} oncancel={() => (confirm = null)} />

<style>
  .page {
    padding: 32px 24px;
    max-width: 1100px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .head,
  .bar,
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  h1,
  p {
    margin: 0;
  }
  .grow {
    flex: 1;
  }
  .block {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .block.ok {
    border-color: #2f7d5a;
  }
  .block.bad {
    border-color: var(--critical);
  }
  .panel.note {
    margin-bottom: 0;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 10px 16px;
    margin: 0;
  }
  dt {
    color: var(--ink-2);
    font-size: 12px;
  }
  dd {
    margin: 0;
  }
  summary {
    cursor: pointer;
    color: var(--ink-2);
  }
  .doc {
    margin: 8px 0 0;
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 420px;
    overflow: auto;
  }
  .nowrap {
    white-space: nowrap;
  }
  .actions a,
  .bar a.btn {
    display: inline-flex;
    align-items: center;
  }
</style>
