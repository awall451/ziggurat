<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { when } from '$lib/format.js';

  let { data } = $props();

  let f = $state({
    name: '',
    id: '',
    description: '',
    remote: '',
    source: '',
    charter: '',
    target: data.targets[0]?.id || '',
    theme: 'plain',
    accent: '#4fd8ff',
    cores: 4,
    memoryGb: 12,
    diskGb: 40,
    vmid: '',
    leadModel: 'fable',
    fallbackModel: 'opus',
    budgetUsd: 40,
    cyclesPerDay: 6
  });
  let idTouched = $state(false);
  let check = $state(null); // read-only look at the chosen bundle
  let charterFrom = $state(''); // the bundle's own charter, to tell whether it was edited
  let busy = $state(false);
  let problem = $state('');

  const slug = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  const key = (s) => `${s.kind}:${s.id}`;
  const folders = $derived(data.sources.filter((s) => s.kind === 'folder'));
  const examples = $derived(data.sources.filter((s) => s.kind === 'example'));
  const open = $derived(data.deploys.filter((d) => d.state !== 'abandoned' && d.state !== 'ready'));

  function setName(v) {
    f.name = v;
    if (!idTouched) f.id = slug(v);
  }

  async function pick(value, keepCharter = false) {
    f.source = value;
    check = null;
    if (!value) return;
    const [kind, id] = value.split(':');
    try {
      const res = await fetch(`/api/deploy-sources?kind=${kind}&id=${encodeURIComponent(id)}`);
      check = await res.json();
      charterFrom = check.charter || '';
      if (!keepCharter) f.charter = charterFrom;
      if (kind === 'folder' && !f.name && !keepCharter) setName(id);
      // Settings the bundle suggests.
      if (!keepCharter) {
        if (check.env?.LEAD_MODEL) f.leadModel = check.env.LEAD_MODEL;
        if (check.env?.FALLBACK_MODEL) f.fallbackModel = check.env.FALLBACK_MODEL;
        if (/^[0-9]+$/.test(check.env?.CYCLE_BUDGET_USD || '')) f.budgetUsd = Number(check.env.CYCLE_BUDGET_USD);
        if (/^[0-9]+$/.test(check.env?.MAX_CYCLES_PER_DAY || '')) f.cyclesPerDay = Number(check.env.MAX_CYCLES_PER_DAY);
      }
    } catch {
      problem = 'Could not read that bundle.';
    }
  }

  // /new?edit=<id>: change the inputs of a deploy that has no VM yet.
  onMount(async () => {
    const edit = page.url.searchParams.get('edit');
    if (!edit) return;
    const res = await fetch(`/api/deploys/${edit}`);
    if (!res.ok) return;
    const r = (await res.json()).request;
    Object.assign(f, { ...r, source: key(r.source), memoryGb: r.memoryMb / 1024, vmid: r.vmid ?? '', charter: r.charter || '' });
    idTouched = true;
    await pick(f.source, true);
    if (!r.charter) f.charter = charterFrom;
  });

  async function submit() {
    problem = '';
    if (!f.source) {
      problem = 'source: pick what the team starts from';
      return;
    }
    busy = true;
    const [kind, id] = f.source.split(':');
    const body = {
      id: f.id,
      name: f.name,
      description: f.description,
      remote: f.remote.trim() || null,
      target: f.target,
      source: { kind, id },
      // Only sent when it was changed, so a folder's own charter stays the source of truth.
      charter: f.charter.trim() && f.charter !== charterFrom ? f.charter : null,
      theme: f.theme,
      accent: f.accent,
      cores: Number(f.cores),
      memoryMb: Math.round(Number(f.memoryGb) * 1024),
      diskGb: Number(f.diskGb),
      vmid: f.vmid === '' || f.vmid == null ? null : Number(f.vmid),
      leadModel: f.leadModel,
      fallbackModel: f.fallbackModel,
      budgetUsd: Number(f.budgetUsd),
      cyclesPerDay: Number(f.cyclesPerDay)
    };
    try {
      const res = await fetch('/api/deploys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The request failed');
      await goto(`/new/${out.id}`);
    } catch (e) {
      problem = e.message;
    } finally {
      busy = false;
    }
  }

  const STATE = { draft: 'Draft', 'dry-running': 'Dry run going', planned: 'Dry run done', 'dry-run-failed': 'Dry run failed', creating: 'Creating', created: 'VM created', 'create-failed': 'Create failed', installing: 'Installing the team', 'install-failed': 'Install failed', 'awaiting-login': 'Waiting for a sign-in', ready: 'Ready' };
</script>

<div class="page">
  <h1>New project</h1>
  <p class="dim lead">A new sandbox VM with a team in it. Nothing is created until you have seen a dry run and clicked "Create project".</p>

  {#if open.length}
    <section class="panel block">
      <h2>Under way</h2>
      {#each open as d (d.id)}
        <a class="line" href="/new/{d.id}">
          <span>{d.name}</span><span class="mono small dim">{d.id}{d.vmid ? ` · VM ${d.vmid}` : ''}</span>
          <span class="grow"></span><span class="small dim">{STATE[d.state] || d.state} · {when(d.updatedAt)}</span>
        </a>
      {/each}
    </section>
  {/if}

  {#if !data.targets.length}
    <div class="panel note caution">No deploy target yet. Add one under <a href="/settings?tab=targets">Settings → Deploy targets</a> first.</div>
  {/if}
  {#if problem}
    <div class="panel note bad" role="alert">{#each problem.split('; ') as line}<div>{line}</div>{/each}</div>
  {/if}

  <section class="panel block">
    <h2>The project</h2>
    <div class="grid">
      <label class="stack">
        <span>Name</span>
        <input class="field" value={f.name} oninput={(e) => setName(e.currentTarget.value)} maxlength="80" />
      </label>
      <label class="stack">
        <span>Id</span>
        <input class="field mono" bind:value={f.id} oninput={() => (idTouched = true)} maxlength="40" spellcheck="false" />
        <span class="small dim">Also the VM's name and the repo folder. Lowercase letters, digits, hyphens. Cannot be changed later.</span>
      </label>
      <label class="stack wide">
        <span>Description</span>
        <input class="field" bind:value={f.description} maxlength="200" placeholder="One line shown on the project card" />
      </label>
      <label class="stack wide">
        <span>Remote repository (optional)</span>
        <input class="field mono" bind:value={f.remote} maxlength="300" placeholder="git@github.com:owner/repo.git" />
        <span class="small dim">
          Where the project's main is published. An ssh address of an empty repository. When the project is ready, the console shows a key to add
          there. Leave empty to set it up later on the Controls tab.
        </span>
      </label>
    </div>
  </section>

  <section class="panel block">
    <h2>What the team starts from</h2>
    <label class="stack">
      <span>Team</span>
      <select class="field" value={f.source} onchange={(e) => pick(e.currentTarget.value)}>
        <option value="">Pick one…</option>
        {#if folders.length}
          <optgroup label="Your project folders">
            {#each folders as s (s.id)}<option value={key(s)}>{s.id}{s.seed ? '' : ' (no seed)'}</option>{/each}
          </optgroup>
        {/if}
        {#if examples.length}
          <optgroup label="Examples">
            {#each examples as s (s.id)}<option value={key(s)}>{s.id}</option>{/each}
          </optgroup>
        {/if}
      </select>
      <span class="small dim">A project folder holds <span class="mono">team/</span> and usually <span class="mono">seed/</span> (the starting repo). An example brings its own.</span>
    </label>
    {#if !data.sources.length}
      <p class="dim small">Nothing to pick yet: no project folder with a <span class="mono">team/CHARTER.md</span> was found, and no example ships a seed.</p>
    {/if}

    {#if check}
      {#if check.problems.length}
        <div class="panel note bad">
          <b>This team cannot be deployed yet:</b>
          {#each check.problems as p}<div>{p}</div>{/each}
        </div>
      {/if}
      {#each check.warnings as w}<div class="small s-interrupted">{w}</div>{/each}
      <p class="small dim">
        {check.agents.length} agents: {check.agents.map((a) => a.id).join(', ') || 'none'}
        {#if check.provision}· has a provisioning script (shown in full before the dry run){/if}
      </p>
      <label class="stack">
        <span>Goal and rules (the charter)</span>
        <textarea class="field mono charter" bind:value={f.charter} spellcheck="false"></textarea>
        <span class="small dim">What the team builds, how free it is, what it must never do. Role names in double braces are filled in from the theme.</span>
      </label>
    {/if}
  </section>

  <details class="panel block">
    <summary><h2>Advanced</h2><span class="small dim">target, size, theme, models and brakes; the defaults are fine for most projects</span></summary>
    <div class="grid">
      <label class="stack">
        <span>Deploy target</span>
        <select class="field" bind:value={f.target}>
          {#each data.targets as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
      </label>
      <label class="stack"><span>CPU cores</span><input class="field mono" type="number" min="1" max="16" bind:value={f.cores} /></label>
      <label class="stack"><span>Memory, GB</span><input class="field mono" type="number" min="2" max="64" bind:value={f.memoryGb} /></label>
      <label class="stack"><span>Disk, GB</span><input class="field mono" type="number" min="20" max="200" bind:value={f.diskGb} /></label>
      <label class="stack">
        <span>VM id</span>
        <input class="field mono" type="number" bind:value={f.vmid} placeholder="next free" />
        <span class="small dim">Empty: the next free id in the target's range.</span>
      </label>
      <label class="stack">
        <span>Theme</span>
        <select class="field" bind:value={f.theme}>
          {#each data.themes as t}<option value={t}>{t}</option>{/each}
        </select>
        <span class="small dim">The role names the team and the console use.</span>
      </label>
      <label class="stack"><span>Accent colour</span><input class="field mono" bind:value={f.accent} maxlength="7" /></label>
      <label class="stack"><span>Lead's model</span><input class="field mono" bind:value={f.leadModel} /></label>
      <label class="stack"><span>Fallback model</span><input class="field mono" bind:value={f.fallbackModel} /></label>
      <label class="stack">
        <span>Budget per cycle, USD</span>
        <input class="field mono" type="number" min="1" max="500" bind:value={f.budgetUsd} />
        <span class="small dim">An API-equivalent estimate. A runaway brake, not a bill.</span>
      </label>
      <label class="stack">
        <span>Cycles per day</span>
        <input class="field mono" type="number" min="0" max="200" bind:value={f.cyclesPerDay} />
        <span class="small dim">Counted per UTC day. A cap on cycles, not on hours.</span>
      </label>
    </div>
  </details>

  <div class="actions">
    <a class="btn quiet" href="/">Cancel</a>
    <button class="btn primary" onclick={submit} disabled={busy || !data.targets.length}>{busy ? 'Checking…' : 'Check the team'}</button>
  </div>
</div>

<style>
  .page {
    padding: 32px 24px;
    max-width: 980px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  h1,
  p {
    margin: 0;
  }
  .lead {
    margin-top: -8px;
  }
  .block {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 14px 16px;
    align-items: start;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .charter {
    min-height: 300px;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
  }
  summary {
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  details[open] summary {
    margin-bottom: 4px;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 6px 0;
    color: var(--ink);
    border-top: 1px solid var(--line);
  }
  .grow {
    flex: 1;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .panel.note {
    margin-bottom: 0;
  }
</style>
