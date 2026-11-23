<script>
  import { onMount } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { when } from '$lib/format.js';

  let { data } = $props();

  const PLAN_FOCUS = "Read the owner's plan and design in docs/ and the charter, and propose the first jobs. Choosing the stack and writing the real tools/check comes first.";
  const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.md$/;
  const DOC_MAX = { files: 10, bytes: 2 * 1024 * 1024 };

  let f = $state({
    name: '',
    id: '',
    description: '',
    remote: '',
    source: '',
    goal: '',
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
  let docs = $state([]); // {name, text}
  let plan = $state({ on: true, focus: PLAN_FOCUS, maxProposals: 5 });
  let idTouched = $state(false);
  let check = $state(null); // read-only look at the chosen team
  let charterFrom = $state(''); // the team's own charter, to tell whether it was edited
  let busy = $state(false);
  let problem = $state('');
  let dragging = $state(false);
  let pasting = $state(null); // {name, text} while a document is being pasted
  let picker = $state();

  const slug = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  const key = (s) => `${s.kind}:${s.id}`;
  const templates = $derived(data.sources.filter((s) => s.kind === 'template'));
  const folders = $derived(data.sources.filter((s) => s.kind === 'folder'));
  const open = $derived(data.deploys.filter((d) => d.state !== 'abandoned' && d.state !== 'ready'));
  const isTemplate = $derived(f.source.startsWith('template:'));
  const goalNeeded = $derived(isTemplate || !!check?.needsGoal);
  const docBytes = $derived(docs.reduce((t, d) => t + new Blob([d.text]).size, 0));
  const kb = (n) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

  function setName(v) {
    f.name = v;
    if (!idTouched) f.id = slug(v);
  }

  async function pick(value, keep = false) {
    f.source = value;
    check = null;
    if (!value) return;
    const [kind, id] = value.split(':');
    try {
      const res = await fetch(`/api/deploy-sources?kind=${kind}&id=${encodeURIComponent(id)}`);
      check = await res.json();
      charterFrom = check.charter || '';
      if (!keep) f.charter = charterFrom;
      if (kind === 'folder' && !f.name && !keep) setName(id);
      // Settings the team suggests.
      if (!keep) {
        if (check.env?.LEAD_MODEL) f.leadModel = check.env.LEAD_MODEL;
        if (check.env?.FALLBACK_MODEL) f.fallbackModel = check.env.FALLBACK_MODEL;
        if (/^[0-9]+$/.test(check.env?.CYCLE_BUDGET_USD || '')) f.budgetUsd = Number(check.env.CYCLE_BUDGET_USD);
        if (/^[0-9]+$/.test(check.env?.MAX_CYCLES_PER_DAY || '')) f.cyclesPerDay = Number(check.env.MAX_CYCLES_PER_DAY);
      }
    } catch {
      problem = 'Could not read that team.';
    }
  }

  /** Put a saved request (an edit, or a draft) into the form. */
  async function fill(r) {
    Object.assign(f, {
      ...f,
      ...r,
      source: r.source ? key(r.source) : f.source,
      memoryGb: r.memoryMb ? r.memoryMb / 1024 : f.memoryGb,
      vmid: r.vmid ?? '',
      charter: r.charter || '',
      goal: r.goal || '',
      remote: r.remote || '',
      description: r.description || ''
    });
    docs = Array.isArray(r.docs) ? r.docs.map((d) => ({ name: d.name, text: d.text })) : [];
    if (r.plan) plan = { on: r.plan.on === true, focus: r.plan.focus || '', maxProposals: r.plan.maxProposals || 5 };
    idTouched = true;
    await pick(f.source, true);
    if (!r.charter) f.charter = charterFrom;
  }

  // /new?edit=<id>: change the inputs of a deploy that has no VM yet.
  // /new?draft=<id>: open a draft (written by hand, or by Claude after a planning talk).
  let draftId = $state('');
  let importer = $state();
  onMount(async () => {
    const edit = page.url.searchParams.get('edit');
    if (edit) {
      const res = await fetch(`/api/deploys/${edit}`);
      if (res.ok) return fill((await res.json()).request);
    }
    const draft = page.url.searchParams.get('draft');
    if (draft && (await openDraft(draft))) return;
    if (templates.length) await pick(key(templates[0]));
  });

  async function openDraft(id) {
    problem = '';
    const res = await fetch(`/api/drafts/${encodeURIComponent(id)}`);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      problem = `draft: ${out.message || 'could not be opened'}`;
      return false;
    }
    draftId = out.id;
    await fill(out.request);
    return true;
  }

  // A draft file from disk: stored like any draft (the server checks it), then opened.
  async function importFile(file) {
    problem = '';
    let json;
    try {
      json = JSON.parse(await file.text());
    } catch {
      problem = `draft: ${file.name} is not JSON`;
      return;
    }
    const res = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      problem = out.message || 'The draft was not accepted';
      return;
    }
    await goto(out.url, { invalidateAll: true });
    await openDraft(out.id);
    if (out.warnings?.length) problem = out.warnings.join('; ');
  }

  async function dropDraft(id) {
    if (!confirm('Delete this draft?')) return;
    await fetch(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (id === draftId) draftId = '';
    await invalidateAll();
  }

  // ---- documents ----
  const docName = (n) => {
    let base = String(n || 'plan.md')
      .split(/[\\/]/)
      .pop()
      .replace(/\.(markdown|txt)$/i, '.md')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '');
    if (!/\.md$/i.test(base)) base += '.md';
    return base.replace(/\.md$/i, '.md').slice(-99);
  };
  function addDoc(name, text) {
    problem = '';
    const n = docName(name);
    if (!DOC_RE.test(n)) return (problem = `docs: "${name}" cannot be used as a file name`);
    if (docs.length >= DOC_MAX.files && !docs.some((d) => d.name === n)) return (problem = `docs: at most ${DOC_MAX.files} documents`);
    if (docBytes + new Blob([text]).size > DOC_MAX.bytes) return (problem = 'docs: at most 2 MB of documents together');
    docs = [...docs.filter((d) => d.name !== n), { name: n, text }];
  }
  async function readFiles(list) {
    for (const file of list) {
      if (!/\.(md|markdown|txt)$/i.test(file.name)) {
        problem = `docs: ${file.name} is not a Markdown or text file`;
        continue;
      }
      addDoc(file.name, await file.text());
    }
  }
  function drop(e) {
    e.preventDefault();
    dragging = false;
    readFiles([...(e.dataTransfer?.files || [])]);
  }

  async function submit() {
    problem = '';
    if (!f.source) {
      problem = 'team: pick a team';
      return;
    }
    if (goalNeeded && f.goal.trim().length < 20) {
      problem = 'goal: say what the team should build (a few sentences)';
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
      goal: f.goal.trim() || null,
      docs,
      plan: { on: !!plan.on, focus: plan.focus, maxProposals: Number(plan.maxProposals) },
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
      // The draft has become a deploy: it is not needed any more.
      if (draftId) await fetch(`/api/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => {});
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
  <p class="dim lead">Say what to build and drop in your plan. The console builds a sandbox VM with a team in it; nothing is created until you have seen a dry run and clicked "Create project".</p>

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

  <div class="importbar">
    {#if draftId}<span class="small">Opened from a draft. Read it, change what you like, then press Check.</span>{/if}
    <span class="grow"></span>
    <button class="btn quiet sm" onclick={() => importer.click()}>Import JSON…</button>
    <input bind:this={importer} type="file" accept=".json,application/json" hidden onchange={(e) => (importFile(e.currentTarget.files[0]), (e.currentTarget.value = ''))} />
  </div>

  {#if data.drafts?.length}
    <section class="panel block">
      <h2>Drafts</h2>
      {#each data.drafts as dr (dr.id)}
        <div class="line">
          <a href="/new?draft={dr.id}" data-sveltekit-reload>{dr.name || dr.projectId}</a>
          <span class="mono small dim">{dr.projectId}</span>
          <span class="grow"></span><span class="small dim">{when(dr.createdAt)}</span>
          <button class="btn quiet sm" onclick={() => dropDraft(dr.id)}>Delete</button>
        </div>
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
    <h2>What should the team build?</h2>
    <label class="stack">
      <textarea
        class="field goal"
        bind:value={f.goal}
        rows={Math.min(22, Math.max(6, f.goal.split('\n').length + 1))}
        maxlength="20000"
        placeholder="A few honest paragraphs: what it is, who it is for, and how you will know it is good. Example: a command-line tool that turns a folder of bank CSV exports into one tidy ledger; done when last year's totals match my spreadsheet."
      ></textarea>
      <span class="small dim">
        Goes into the charter as the team's goal. {goalNeeded ? 'Needed.' : 'Optional for this team folder: its charter already has a goal.'} The rules (autonomy, boundaries,
        quality bar) come from the team.
      </span>
    </label>
  </section>

  <section class="panel block">
    <h2>Plan and design documents</h2>
    <div
      class="drop"
      class:over={dragging}
      role="region"
      aria-label="Drop Markdown files here"
      ondragover={(e) => (e.preventDefault(), (dragging = true))}
      ondragleave={() => (dragging = false)}
      ondrop={drop}
    >
      <span class="small dim">Drop <span class="mono">.md</span> files here, or</span>
      <button class="btn sm" onclick={() => picker.click()}>Choose files…</button>
      <button class="btn quiet sm" onclick={() => (pasting = { name: 'DESIGN.md', text: '' })}>Paste one…</button>
      <input bind:this={picker} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden onchange={(e) => (readFiles([...e.currentTarget.files]), (e.currentTarget.value = ''))} />
    </div>
    {#if pasting}
      <div class="paste">
        <label class="stack"><span class="small">File name</span><input class="field mono" bind:value={pasting.name} maxlength="99" /></label>
        <textarea class="field mono" rows="10" bind:value={pasting.text} placeholder="Paste Markdown here"></textarea>
        <div class="actions">
          <button class="btn quiet sm" onclick={() => (pasting = null)}>Cancel</button>
          <button class="btn primary sm" disabled={!pasting.text.trim()} onclick={() => (addDoc(pasting.name, pasting.text), (pasting = null))}>Add</button>
        </div>
      </div>
    {/if}
    {#each docs as d (d.name)}
      <details class="doc">
        <summary>
          <span class="mono">docs/{d.name}</span><span class="small dim">{kb(new Blob([d.text]).size)}</span><span class="grow"></span>
          <button class="btn quiet sm" onclick={(e) => (e.preventDefault(), (docs = docs.filter((x) => x.name !== d.name)))}>Remove</button>
        </summary>
        <pre class="mono small">{d.text.slice(0, 6000)}{d.text.length > 6000 ? '\n…' : ''}</pre>
      </details>
    {:else}
      <p class="small dim">Optional. They go into the new repository's <span class="mono">docs/</span> folder, and the lead reads them before it plans.</p>
    {/each}
  </section>

  <section class="panel block">
    <h2>Team</h2>
    <div class="teams" role="radiogroup" aria-label="Team">
      {#each templates as t (t.id)}
        <button class="team" class:on={f.source === key(t)} role="radio" aria-checked={f.source === key(t)} onclick={() => pick(key(t))}>
          <b>{t.name}</b>
          <span class="small dim">{t.about}</span>
          <span class="small mono dim">{t.agents.length} agents</span>
        </button>
      {/each}
    </div>
    {#if !isTemplate && f.source}<p class="small">Using the prepared team folder <span class="mono">{f.source.split(':')[1]}</span> (see Advanced).</p>{/if}
    <p class="small dim">How the team works, not the language: the team chooses the stack in its first planning cycle, and its checks wait for your approval.</p>
    {#if check}
      {#if check.problems.length}
        <div class="panel note bad">
          <b>This team cannot be deployed yet:</b>
          {#each check.problems as p}<div>{p}</div>{/each}
        </div>
      {/if}
      {#each check.warnings as w}<div class="small s-interrupted">{w}</div>{/each}
      {#if check.provision}<p class="small dim">Has a provisioning script (shown in full before the dry run).</p>{/if}
    {/if}
  </section>

  <section class="panel block">
    <h2>When it's ready</h2>
    <label class="check">
      <input type="checkbox" bind:checked={plan.on} />
      <span>Start a planning cycle as soon as the VM is ready</span>
    </label>
    {#if plan.on}
      <label class="stack">
        <span class="small">What to plan</span>
        <textarea class="field" rows="2" maxlength="8000" bind:value={plan.focus}></textarea>
      </label>
      <label class="check small">
        At most
        <select class="field" bind:value={plan.maxProposals}>
          {#each [1, 2, 3, 4, 5, 6, 7, 8] as n (n)}<option value={n}>{n}</option>{/each}
        </select>
        proposals
      </label>
      <p class="small dim">
        One planning cycle after the gate is proven: the lead reads your goal and documents, writes no code, and proposes jobs on the Planning tab, where you can
        talk them over. The team stays halted; nothing runs until you approve.
      </p>
    {:else}
      <p class="small dim">The project is registered and halted. Start it from its Planning or Controls tab when you like.</p>
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
      <label class="stack wide">
        <span>Use a prepared team folder</span>
        <select class="field" value={isTemplate ? '' : f.source} onchange={(e) => pick(e.currentTarget.value || (templates[0] ? key(templates[0]) : ''))}>
          <option value="">No: use the team above</option>
          {#each folders as s (s.id)}<option value={key(s)}>{s.id}{s.seed ? '' : ' (no seed)'}</option>{/each}
        </select>
        <span class="small dim">
          A folder under the projects folder with <span class="mono">team/</span> and usually <span class="mono">seed/</span>, written by hand. Registered projects are not
          listed.
        </span>
      </label>
      {#if check}
        <label class="stack wide">
          <span>The full charter</span>
          <textarea class="field mono charter" bind:value={f.charter} spellcheck="false"></textarea>
          <span class="small dim">
            The team's rules. <span class="mono">{'{{goal}}'}</span> is replaced by your goal above; role names in double braces come from the theme.
          </span>
        </label>
      {/if}
    </div>
  </details>

  <div class="actions">
    <a class="btn quiet" href="/">Cancel</a>
    <button class="btn primary" onclick={submit} disabled={busy || !data.targets.length}>{busy ? 'Checking…' : 'Check'}</button>
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
  .goal {
    min-height: 120px;
    resize: vertical;
    line-height: 1.5;
  }
  .drop {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 14px;
    border: 1px dashed var(--line-strong, var(--line));
    border-radius: 8px;
  }
  .drop.over {
    border-color: var(--accent);
    background: rgba(var(--glow), 0.08);
  }
  .paste {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .doc summary {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .doc pre {
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    margin: 8px 0 0;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .teams {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
  }
  .team {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    font: inherit;
  }
  .team.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent) inset;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
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
  .importbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: -6px;
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
