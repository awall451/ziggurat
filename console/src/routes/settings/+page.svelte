<script>
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

  let { data } = $props();

  // Field lists drive the forms. key: path in the entry ("ssh.alias").
  const TARGET_FIELDS = [
    { title: 'Proxmox host' },
    { key: 'id', label: 'Id', help: 'Short name used in addresses. Cannot be changed later.', mono: true, idField: true },
    { key: 'name', label: 'Name' },
    { key: 'pveHost', label: 'Host address', mono: true },
    { key: 'pveUser', label: 'Login', help: 'Default: root', mono: true },
    { key: 'bastion', label: 'Jump host', help: 'Optional, [user@]host. Leave empty to connect directly.', mono: true },
    { key: 'pveHostKey', label: 'Host key', help: 'Type and key, as printed by ssh-keyscan (without the host name). The console never trusts a host on first contact.', mono: true, wide: true },
    { key: 'pveLanIp', label: 'Host address on the LAN', help: 'Sandboxed VMs must fail to reach it. Default: the host address.', mono: true },
    { key: 'lanGateway', label: 'LAN router', help: 'Sandboxed VMs must fail to reach it.', mono: true },
    { title: 'Sandbox network' },
    { key: 'bridge', label: 'Isolated bridge', mono: true },
    { key: 'subnetPrefix', label: 'Subnet, first three numbers', help: 'Like 10.66.0. The gateway is .1; a VM gets .(id − first id + 10).', mono: true },
    { key: 'gatewayVmid', label: 'Gateway container id', type: 'number' },
    { key: 'gatewayLanIp', label: 'Gateway address on the LAN', help: 'The console reaches new VMs through it.', mono: true },
    { key: 'gatewayHostKey', label: 'Gateway host key', help: 'Optional when the gateway is already in the console’s known_hosts.', mono: true, wide: true },
    { key: 'adminUser', label: 'Admin login in new VMs', mono: true },
    { title: 'Virtual machines' },
    { key: 'templateVmid', label: 'Template id', type: 'number' },
    { key: 'vmidMin', label: 'First VM id', type: 'number' },
    { key: 'vmidMax', label: 'Last VM id', type: 'number' },
    { key: 'criticalVmids', label: 'Protected ids', help: 'Comma separated. The console refuses to act on these.', type: 'list', mono: true },
    { key: 'storage', label: 'Disk storage', mono: true },
    { key: 'snippetsStorage', label: 'Snippets storage', help: 'Default: local', mono: true },
    { key: 'snippetsDir', label: 'Snippets folder on the host', help: 'Default: /var/lib/vz/snippets', mono: true },
    { key: 'poolWarnPct', label: 'Warn when storage is this full, %', help: 'Default: 80', type: 'number' },
    { key: 'poolBlockPct', label: 'No deploys when this full, %', help: 'Default: 90', type: 'number' }
  ];
  const PROJECT_FIELDS = $derived([
    { title: 'Project' },
    { key: 'id', label: 'Id', help: 'Short name used in addresses. Cannot be changed later.', mono: true, idField: true },
    { key: 'name', label: 'Name' },
    { key: 'description', label: 'Description', wide: true },
    { key: 'theme', label: 'Theme', type: 'select', options: data.themes },
    { key: 'accent', label: 'Accent colour', help: 'Like #4fd8ff', mono: true },
    { key: 'hidden', label: 'Hidden from the project list', type: 'bool' },
    { key: 'pull', label: 'Pull its data', help: 'On unless switched off.', type: 'bool', fallback: true },
    { title: 'How the console reaches its VM' },
    { key: 'ssh.alias', label: 'Host alias', help: 'A Host entry in the console’s ssh config. Use this or the three fields below.', mono: true },
    { key: 'ssh.host', label: 'Address', mono: true },
    { key: 'ssh.user', label: 'Login', mono: true },
    { key: 'ssh.jump', label: 'Jump host', help: '[user@]host', mono: true }
  ]);

  let tab = $state('projects');
  let draft = $state(null); // the entry being edited (a copy)
  let original = $state(null); // its id when it already exists, null for a new one
  let mode = $state('form'); // form | json
  let text = $state(''); // JSON view
  let busy = $state('');
  let problem = $state('');
  let done = $state('');
  let confirm = $state(null);
  let check = $state(null); // result of "Check target"

  const kind = $derived(tab === 'targets' ? 'target' : 'project');
  const list = $derived(tab === 'targets' ? data.targets : data.projects);
  const fields = $derived(tab === 'targets' ? TARGET_FIELDS : PROJECT_FIELDS);

  function open(entry) {
    draft = entry ? JSON.parse(JSON.stringify(entry)) : tab === 'targets' ? {} : { ssh: {} };
    original = entry ? entry.id : null;
    mode = 'form';
    problem = done = '';
    check = null;
  }
  function pick(next) {
    tab = next;
    draft = null;
    check = null;
    problem = done = '';
  }

  function get(key) {
    return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), draft);
  }
  function set(key, value) {
    const parts = key.split('.');
    let o = draft;
    for (const k of parts.slice(0, -1)) o = o[k] ??= {};
    if (value === '' || value == null) delete o[parts.at(-1)];
    else o[parts.at(-1)] = value;
  }
  const asList = (v) =>
    String(v)
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((n) => (/^[0-9]+$/.test(n) ? Number(n) : n));

  function toJson() {
    text = JSON.stringify(draft, null, 2);
    mode = 'json';
  }
  function toForm() {
    try {
      draft = JSON.parse(text);
      mode = 'form';
      problem = '';
    } catch (e) {
      problem = `That is not valid JSON: ${e.message}`;
    }
  }

  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || 'The request failed');
    return out;
  }

  async function save() {
    problem = done = '';
    let entry = draft;
    if (mode === 'json') {
      try {
        entry = JSON.parse(text);
      } catch (e) {
        problem = `That is not valid JSON: ${e.message}`;
        return;
      }
    }
    busy = 'save';
    try {
      const saved = await call(original ? 'PUT' : 'POST', `/api/${kind}s${original ? `/${original}` : ''}`, entry);
      await invalidateAll();
      open(saved);
      done = 'Saved.';
    } catch (e) {
      // The server lists every problem as "field: what is wrong; ...".
      problem = e.message;
    } finally {
      busy = '';
    }
  }

  function askRemove() {
    confirm = {
      title: `Remove ${original} from the list?`,
      body:
        kind === 'project'
          ? 'Only the entry in projects.json is removed. The VM, the team on it and all data already pulled stay exactly as they are. The console stops showing and pulling this project.'
          : 'Only the entry in targets.json is removed. Nothing on the Proxmox host changes.',
      word: 'Remove entry',
      danger: true,
      run: async () => {
        busy = 'remove';
        try {
          await call('DELETE', `/api/${kind}s/${original}`);
          await invalidateAll();
          draft = null;
          done = 'Removed from the list.';
        } catch (e) {
          problem = e.message;
        } finally {
          busy = '';
          confirm = null;
        }
      }
    };
  }

  async function runCheck() {
    busy = 'check';
    problem = done = '';
    try {
      check = await call('POST', `/api/targets/${original}/check`);
    } catch (e) {
      problem = e.message;
    } finally {
      busy = '';
    }
  }

  // A link can open one entry directly: /settings?tab=targets&edit=<id>
  onMount(() => {
    const want = page.url.searchParams;
    if (want.get('tab') === 'targets') tab = 'targets';
    const entry = want.get('edit') && list.find((e) => e.id === want.get('edit'));
    if (entry) open(entry);
  });

  const gb = (kb) => `${(kb / 1048576).toFixed(0)} GB`;
</script>

<div class="page">
  <div class="head">
    <h1>Settings</h1>
    <div class="tabs" role="tablist">
      <button class="tab" class:on={tab === 'projects'} role="tab" aria-selected={tab === 'projects'} onclick={() => pick('projects')}>Projects</button>
      <button class="tab" class:on={tab === 'targets'} role="tab" aria-selected={tab === 'targets'} onclick={() => pick('targets')}>Deploy targets</button>
    </div>
  </div>

  {#if tab === 'targets' && !data.deploy}
    <div class="panel block">
      <h2>Creating projects from the console is turned off</h2>
      <p class="dim">
        A deploy target is a Proxmox host with a sandbox network already set up. To use targets, set
        <span class="mono">CONSOLE_DEPLOY=1</span> in the console's env file and start it again. Read the README first: the console's ssh key then acts as
        an administrator on that host.
      </p>
    </div>
  {:else}
    <div class="cols">
      <section class="panel side">
        {#each list as e (e.id)}
          <button class="row" class:on={original === e.id} onclick={() => open(e)}>
            <span>{e.name || e.id}</span>
            <span class="mono small dim">{e.id}</span>
          </button>
        {:else}
          <p class="dim small pad">Nothing here yet.</p>
        {/each}
        <button class="btn quiet add" onclick={() => open(null)}>Add a {kind}</button>
      </section>

      <section class="panel block">
        {#if !draft}
          <p class="dim">
            {tab === 'targets'
              ? 'Pick a target to edit it, or add one. Targets are stored in targets.json in the console’s config folder.'
              : 'Pick a project to edit its entry, or add one. Entries are stored in projects.json in the console’s config folder.'}
          </p>
          {#if done}<div class="panel note good" role="status">{done}</div>{/if}
        {:else}
          <div class="bar">
            <h2>{original ? `Edit ${original}` : `New ${kind}`}</h2>
            <span class="grow"></span>
            {#if mode === 'form'}
              <button class="btn quiet" onclick={toJson}>Edit as JSON</button>
            {:else}
              <button class="btn quiet" onclick={toForm}>Back to the form</button>
            {/if}
          </div>
          {#if problem}
            <div class="panel note bad" role="alert">
              {#each problem.split('; ') as line}<div>{line}</div>{/each}
            </div>
          {/if}
          {#if done}<div class="panel note good" role="status">{done}</div>{/if}

          {#if mode === 'json'}
            <p class="dim small">The whole entry. Fields the form does not show (kit paths, data folders, agent name aliases) can be edited here.</p>
            <textarea class="field mono json" bind:value={text} spellcheck="false"></textarea>
          {:else}
            <div class="form">
              {#each fields as f (f.key || f.title)}
                {#if f.title}
                  <h3>{f.title}</h3>
                {:else if f.type === 'bool'}
                  <label class="tick" class:wide={f.wide}>
                    <input type="checkbox" checked={get(f.key) ?? f.fallback ?? false} onchange={(e) => set(f.key, e.currentTarget.checked === (f.fallback ?? false) ? null : e.currentTarget.checked)} />
                    <span>{f.label}{#if f.help}<span class="small dim"> · {f.help}</span>{/if}</span>
                  </label>
                {:else}
                  <label class="stack" class:wide={f.wide}>
                    <span>{f.label}</span>
                    {#if f.type === 'select'}
                      <select class="field" value={get(f.key) ?? ''} onchange={(e) => set(f.key, e.currentTarget.value)}>
                        <option value="">Default</option>
                        {#each f.options as o}<option value={o}>{o}</option>{/each}
                      </select>
                    {:else if f.type === 'number'}
                      <input class="field mono" type="number" value={get(f.key) ?? ''} oninput={(e) => set(f.key, e.currentTarget.value === '' ? null : Number(e.currentTarget.value))} />
                    {:else if f.type === 'list'}
                      <input class="field mono" value={(get(f.key) || []).join(', ')} onchange={(e) => set(f.key, asList(e.currentTarget.value))} />
                    {:else}
                      <input class="field" class:mono={f.mono} value={get(f.key) ?? ''} disabled={f.idField && !!original} oninput={(e) => set(f.key, e.currentTarget.value.trim())} spellcheck="false" />
                    {/if}
                    {#if f.help}<span class="small dim">{f.help}</span>{/if}
                  </label>
                {/if}
              {/each}
            </div>
          {/if}

          <div class="actions">
            {#if original}<button class="btn danger" onclick={askRemove} disabled={!!busy}>Remove entry…</button>{/if}
            <span class="grow"></span>
            {#if original && tab === 'targets'}
              <button class="btn quiet" onclick={runCheck} disabled={!!busy}>{busy === 'check' ? 'Checking…' : 'Check target'}</button>
            {/if}
            <button class="btn primary" onclick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          </div>

          {#if check}
            <div class="well result">
              <h3>What the host says <span class="small dim">read-only; nothing was changed</span></h3>
              {#if check.error}
                <div class="s-failed">{check.error}</div>
              {:else}
                <ul class="checks">
                  {#each check.checks as c (c.id)}
                    <li>
                      <span class="pill {c.ok ? (c.warn ? 'halted' : 'done') : 'failed'}">{c.ok ? (c.warn ? 'Warning' : 'OK') : 'Problem'}</span>
                      <span>{c.label}</span>
                      {#if c.detail}<span class="small dim">{c.detail}</span>{/if}
                    </li>
                  {/each}
                </ul>
                <p class="small dim">
                  {check.version}
                  {#if check.memFreeMb != null} · {(check.memFreeMb / 1024).toFixed(1)} GB memory free{/if}
                  {#if check.pool} · {gb(check.pool.availKb)} of {gb(check.pool.totalKb)} storage free{/if}
                  {#if check.next} · next VM would be <span class="mono">{check.next.vmid}</span> at <span class="mono">{check.next.ip}</span>{/if}
                </p>
                <div class="scroll-x">
                  <table class="grid">
                    <thead><tr><th>Id</th><th>Name</th><th>Kind</th><th>State</th><th></th></tr></thead>
                    <tbody>
                      {#each check.guests as g (g.kind + g.vmid)}
                        <tr>
                          <td class="mono">{g.vmid}</td>
                          <td>{g.name}</td>
                          <td class="dim">{g.kind === 'ct' ? 'container' : 'VM'}</td>
                          <td class="mono">{g.status}</td>
                          <td class="small">{g.critical ? 'protected' : g.inRange ? 'in the agent range' : ''}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>

<ConfirmDialog {confirm} busy={!!busy} oncancel={() => (confirm = null)} />

<style>
  .page {
    padding: 32px 24px;
    max-width: 1300px;
    width: 100%;
    margin: 0 auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tab {
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
    font-weight: 500;
  }
  .tab.on {
    border-color: var(--line-strong);
    color: var(--ink);
    background: rgba(var(--glow), 0.08);
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  @media (max-width: 760px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .side {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    text-align: left;
  }
  .row:hover,
  .row.on {
    border-color: var(--line-strong);
    background: rgba(var(--glow), 0.08);
  }
  .add {
    margin-top: 8px;
  }
  .pad {
    padding: 8px 10px;
    margin: 0;
  }
  .block {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .bar,
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  .form {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 14px 16px;
    align-items: start;
  }
  .form h3,
  .wide {
    grid-column: 1 / -1;
  }
  .form h3 {
    margin: 8px 0 0;
    font-size: 13px;
    color: var(--ink-2);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .tick {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    cursor: pointer;
  }
  .tick input {
    width: 16px;
    height: 16px;
    accent-color: var(--cyan);
  }
  input.field:disabled {
    opacity: 0.6;
  }
  .json {
    min-height: 420px;
    width: 100%;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
  }
  .result {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .result h3 {
    margin: 0;
    font-size: 15px;
  }
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .checks li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
</style>
