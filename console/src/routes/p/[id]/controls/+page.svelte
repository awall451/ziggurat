<script>
  import { invalidateAll } from '$app/navigation';
  import { when } from '$lib/format.js';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

  let { data } = $props();
  const p = $derived(data.project);
  const st = $derived(p.status);
  const c = $derived(data.controls);

  let busy = $state('');
  let problem = $state('');
  let done = $state('');
  let confirm = $state(null); // {title, body, word, run}
  let haltReason = $state('');
  let stopAt = $state('');
  let stopWhy = $state('');
  let edits = $state({});

  async function act(body, label) {
    busy = label;
    problem = '';
    done = '';
    try {
      const res = await fetch(`/p/${p.id}/controls/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The action failed');
      done = out.detail || 'Done';
      await invalidateAll();
    } catch (e) {
      problem = e.message;
    } finally {
      busy = '';
      confirm = null;
    }
  }

  function askHalt() {
    confirm = {
      title: `Halt ${p.name} now?`,
      body: `Stops the cycle in progress, the ${p.tiers[0]}'s timer and the team's own jobs that run Claude. Work in progress stays in its worktrees. Other team services keep running.`,
      word: 'Halt now',
      danger: true,
      run: () => act({ action: 'halt', reason: haltReason }, 'halt')
    };
  }
  function askResume() {
    confirm = {
      title: `Resume ${p.name}?`,
      body: `The ${p.tiers[0]} starts a cycle right away and keeps going until the daily cap, a scheduled stop or a halt. This spends subscription usage: check your weekly limit first.`,
      word: 'Resume team',
      run: () => act({ action: 'resume' }, 'resume')
    };
  }

  function askToken() {
    confirm = {
      title: `Give ${p.name} the saved Claude token?`,
      body: 'Stores the subscription token from the console\'s config folder on this VM. The team then signs in with it instead of its own login, from the next cycle. The token is not shown anywhere.',
      word: 'Apply token',
      run: () => act({ action: 'apply-token' }, 'token')
    };
  }

  const SIGN_IN = { 'claude.ai': 'a login as the agent user', oauth_token: 'the stored subscription token', api_key: 'an API key', none: 'nothing' };

  function schedule() {
    const t = Math.floor(new Date(stopAt).getTime() / 1000);
    if (!t) {
      problem = 'Pick a date and time first.';
      return;
    }
    act({ action: 'halt-at', epoch: t, reason: stopWhy }, 'halt-at');
  }

  const CAPS = [
    ['MAX_CYCLES_PER_DAY', 'Cycles per day', 'Counted per UTC day. A cap on cycles, not on hours.'],
    ['CYCLE_BUDGET_USD', 'Budget per cycle, USD', "Claude Code's API-equivalent estimate. A runaway brake, not a bill."],
    ['LEAD_MODEL', "Lead's model", 'Used from the next cycle.'],
    ['FALLBACK_MODEL', 'Fallback model', 'Used when the first one is unavailable.']
  ];
  const KIND = { token: 'Runs Claude: stopped by a halt', keep: 'Kept running (on the keep list)', other: 'Not Claude: keeps running' };
  const ACTION = {
    halt: 'Halt',
    resume: 'Resume',
    'schedule-halt': 'Scheduled a stop',
    'clear-scheduled-halt': 'Cleared the scheduled stop',
    'set-cap': 'Changed a setting',
    'gate-pause': 'Paused the gate',
    'gate-resume': 'Resumed the gate',
    'message-send': 'Sent a message',
    'message-retry': 'Retried a message',
    'message-close': 'Closed a message',
    'apply-token': 'Applied the saved Claude token',
    'deploy-draft': 'New project: checked the team',
    'deploy-dry-run': 'New project: dry run',
    'deploy-dry-run-end': 'New project: dry run ended',
    'deploy-create': 'New project: creating the VM',
    'deploy-create-end': 'New project: VM run ended',
    'deploy-install': 'New project: installing the team',
    'deploy-install-end': 'New project: install ended',
    'deploy-login-check': 'New project: checked the sign-in',
    'deploy-apply-token': 'New project: applied the saved Claude token',
    'deploy-abandon': 'New project: given up',
    'deploy-gate-proof': 'New project: gate proof started',
    'deploy-gate-proof-end': 'New project: gate proof ended',
    'project-add': 'Added to the registry',
    'project-save': 'Changed the registry entry'
  };
  const args = (a) =>
    Object.entries(a || {})
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
</script>

{#if !p.canControl}
  <div class="panel block warn">
    <h2>Controls are not available for this project yet</h2>
    <p class="dim">
      {st.state === 'unreachable' ? 'Its VM cannot be reached.' : 'Its VM runs a kit without the control scripts. Upgrade the kit to use them.'}
    </p>
  </div>
{:else}
  {#if problem}<div class="panel note bad" role="alert">{problem}</div>{/if}
  {#if done}<div class="panel note good" role="status">{done}</div>{/if}
  {#if c.error}<div class="panel note bad">{c.error}</div>{/if}

  <div class="cols">
    <section class="panel block">
      <h2>Team</h2>
      <p class="dim small">
        State: <span class="pill {st.state}">{st.state}</span>
        {#if st.control}<span class="mono"> {st.control}</span>{/if}
      </p>
      {#if st.state === 'halted' || !st.timerEnabled}
        <p>The team is stopped. Nothing spends tokens until you resume it.</p>
        <div><button class="btn go" onclick={askResume} disabled={!!busy}>Resume team…</button></div>
      {/if}
      {#if st.state !== 'halted'}
        <label class="stack">
          <span class="small dim">Reason (shown in the control file and the audit log)</span>
          <input class="field" bind:value={haltReason} placeholder="Weekly usage" maxlength="120" />
        </label>
        <div><button class="btn stop" onclick={askHalt} disabled={!!busy}>Halt now…</button></div>
      {/if}
    </section>

    <section class="panel block">
      <h2>Stop at a set time</h2>
      <p class="dim small">Halts the team at that moment, even mid-cycle. Survives a reboot of the VM.</p>
      {#if st.haltAt}
        <p>Scheduled for <b>{when(new Date(st.haltAt.epoch * 1000).toISOString())}</b>{st.haltAt.reason ? ` (${st.haltAt.reason})` : ''}.</p>
        <div><button class="btn quiet" onclick={() => act({ action: 'halt-at-clear' }, 'clear')} disabled={!!busy}>Cancel the scheduled stop</button></div>
      {:else}
        <div class="pair">
          <label class="stack"><span class="small dim">When (your local time)</span><input class="field" type="datetime-local" bind:value={stopAt} /></label>
          <label class="stack"><span class="small dim">Reason</span><input class="field" bind:value={stopWhy} placeholder="Overnight window" maxlength="120" /></label>
        </div>
        <div><button class="btn" onclick={schedule} disabled={!!busy}>Schedule stop</button></div>
      {/if}
    </section>

    <section class="panel block">
      <h2>Brakes and models</h2>
      <p class="dim small">Changes apply from the next cycle.</p>
      {#each CAPS as [key, label, help] (key)}
        <div class="cap">
          <label class="stack">
            <span>{label}</span>
            <span class="small dim">{help}</span>
            <span class="pair tight">
              <input class="field mono" value={edits[key] ?? c.caps[key] ?? ''} oninput={(e) => (edits = { ...edits, [key]: e.currentTarget.value })} />
              <button
                class="btn quiet"
                disabled={!!busy || edits[key] == null || edits[key] === c.caps[key]}
                onclick={() => act({ action: 'cap', key, value: edits[key] }, key).then(() => (edits = { ...edits, [key]: undefined }))}
              >Save</button>
            </span>
          </label>
        </div>
      {/each}
    </section>

    <section class="panel block">
      <h2>Merge gate</h2>
      <p class="dim small">The gate tests submitted branches and moves main. It also pauses while the team is halted.</p>
      {#if st.gatePaused}
        <p>The gate is paused. Submitted branches wait.</p>
        <div><button class="btn" onclick={() => act({ action: 'gate', on: true }, 'gate')} disabled={!!busy}>Resume the gate</button></div>
      {:else}
        <p>The gate is running.</p>
        <div><button class="btn quiet" onclick={() => act({ action: 'gate', on: false, reason: 'owner' }, 'gate')} disabled={!!busy}>Pause the gate</button></div>
      {/if}
      <p class="dim small">Kit {st.kitVersion} · main {st.main?.sha || '–'} · {st.ready.length} branch{st.ready.length === 1 ? '' : 'es'} submitted · {st.worktrees ?? 0} worktrees</p>
    </section>
  </div>

  <section class="panel block">
    <h2>Claude sign-in</h2>
    {#if c.auth}
      <p>
        {#if c.auth.loggedIn && !c.auth.apiKeySet}
          Signed in with {SIGN_IN[c.auth.authMethod] || c.auth.authMethod}{c.auth.plan ? ` (${c.auth.plan} plan)` : ''}.
          {#if c.auth.expiresAt && c.auth.authMethod === 'claude.ai'}<span class="dim">The login runs until {when(c.auth.expiresAt)}.</span>{/if}
        {:else if c.auth.apiKeySet}
          <span class="s-failed">An API key is configured for the agents. The kit does not use API keys: remove it on the VM.</span>
        {:else}
          <span class="s-failed">Not signed in. The team cannot run until it is.</span>
        {/if}
      </p>
      <p class="dim small">
        {c.auth.tokenStored ? 'A subscription token is stored on the VM.' : 'No token is stored on the VM.'}
        {data.tokenSaved ? '' : 'No token is saved in the console (claude-token in its config folder).'}
      </p>
      {#if data.tokenSaved}
        <div><button class="btn quiet" onclick={askToken} disabled={!!busy}>{c.auth.tokenStored ? 'Replace the token on the VM…' : 'Apply the saved token…'}</button></div>
      {/if}
    {:else}
      <p class="dim">This VM's kit cannot report its sign-in yet (needs kit 0.3 or later).</p>
    {/if}
  </section>

  <section class="panel block">
    <h2>The team's own services</h2>
    <p class="dim small">Jobs the team installed for itself. A halt stops only the ones that run Claude.</p>
    {#if c.units.length}
      <div class="scroll-x">
        <table class="grid">
          <thead><tr><th>Unit</th><th>On a halt</th><th>Enabled</th><th>Now</th></tr></thead>
          <tbody>
            {#each c.units as u (u.unit)}
              <tr>
                <td class="mono">{u.unit}</td>
                <td class={u.kind === 'token' ? 's-interrupted' : 'dim'}>{KIND[u.kind] || u.kind}</td>
                <td class="mono">{u.enabled}</td>
                <td class="mono">{u.active}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="dim">The team has not installed any services.</p>
    {/if}
  </section>
{/if}

<section class="panel block">
  <h2>Audit log</h2>
  <p class="dim small">Everything this console changed for this project, newest first.</p>
  <div class="scroll-x">
    <table class="grid">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>Result</th></tr></thead>
      <tbody>
        {#each data.audit as a (a.at + a.action)}
          <tr>
            <td class="mono nowrap">{when(a.at)}</td>
            <td>{a.user}</td>
            <td class="nowrap">{ACTION[a.action] || a.action}</td>
            <td class="dim">{args(a.args)}</td>
            <td class={a.ok ? 'dim' : 's-failed'}>{a.ok ? a.detail || 'ok' : `failed: ${a.detail || ''}`}</td>
          </tr>
        {:else}
          <tr><td colspan="5" class="dim">Nothing yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<ConfirmDialog {confirm} busy={!!busy} oncancel={() => (confirm = null)} />

<style>
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }
  .block {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    margin-bottom: 16px;
  }
  .cols .block {
    margin-bottom: 0;
  }
  p {
    margin: 0;
  }
  .warn {
    border-color: var(--warn);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .pair.tight {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
