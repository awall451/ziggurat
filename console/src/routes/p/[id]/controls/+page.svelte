<script>
  import { invalidateAll } from '$app/navigation';
  import { when, idleText } from '$lib/format.js';
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
  let wrapUp = $state(false);
  let stopAt = $state('');
  let stopWhy = $state('');
  let edits = $state({});
  let jobText = $state('');
  let jobFiles = $state([]); // {token, name, size} once uploaded
  let jobPicker = $state();
  const lead = $derived(p.tiers[0]);
  const pub = $derived(p.publish);
  let remoteText = $state('');
  let editRemote = $state(false);
  let hostAsk = $state(null); // {host, fingerprint, type}: the forge's host key, to confirm once
  let pubChecks = $state(null);
  let copied = $state(false);

  async function pubAct(body, label) {
    busy = label;
    problem = '';
    done = '';
    try {
      const res = await fetch(`/p/${p.id}/controls/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The action failed');
      await invalidateAll();
      return out;
    } catch (e) {
      problem = e.message;
      return null;
    } finally {
      busy = '';
      confirm = null;
    }
  }
  async function saveRemote(value) {
    const out = await pubAct({ action: 'remote', remote: value }, 'remote');
    if (!out) return;
    editRemote = false;
    hostAsk = null;
    pubChecks = null;
    done = value ? 'Remote saved. Add the key below to the repository, then verify.' : 'Publishing is turned off for this project.';
  }
  async function verifyRemote(fingerprint = null) {
    const out = await pubAct({ action: 'verify', fingerprint }, 'verify');
    if (!out) return;
    if (out.need === 'hostkey') {
      hostAsk = out;
      return;
    }
    hostAsk = null;
    pubChecks = out;
    if (out.ok) done = out.note || 'Verified: the console can read the remote and may push to it.';
    else problem = 'The remote could not be verified. See the checks below.';
  }
  function askPublish() {
    confirm = {
      title: `Publish ${p.name} now?`,
      body: `The console fetches the gate's main from the VM, checks what is new (no rewritten history, no secrets, no CI files) and pushes it to ${pub.remote}. What is pushed can be read by everyone who can read that repository. A push cannot be taken back.`,
      word: 'Publish now',
      run: async () => {
        const out = await pubAct({ action: 'now' }, 'publish');
        if (!out) return;
        if (out.outcome === 'blocked') problem = out.detail;
        else done = out.detail;
      }
    };
  }
  async function copyKey() {
    try {
      await navigator.clipboard.writeText(pub.publicKey);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      /* the key can still be selected by hand */
    }
  }
  // On a halted team; on an idle one (set to run, no cycle running) with kit 0.6.
  const idleJob = $derived(st.state === 'idle' && !st.haltAfter);
  const canStartJob = $derived(!st.oneshot && (st.state === 'halted' || (idleJob && p.canOneshotIdle)));

  async function act(body, label) {
    busy = label;
    problem = '';
    done = '';
    try {
      const res = await fetch(`/p/${p.id}/controls/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || 'The action failed');
      // A one-shot job without a clear answer from the VM is not a success.
      if (out.started === false) problem = out.detail;
      else done = out.detail || 'Done';
      await invalidateAll();
      return out;
    } catch (e) {
      problem = e.message;
      return null;
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
  function askHaltAfter() {
    const running = st.leadActive;
    confirm = {
      title: running ? `Halt ${p.name} after this cycle?` : `Halt ${p.name}?`,
      body: running
        ? `The cycle in progress finishes. The gate then judges what it submitted, and after that the team is halted like any halt: timer off, the team's own jobs that run Claude stopped. No new cycle starts in between. ${
            wrapUp
              ? `${lead} and the agents now working are told to wrap up: finish the step in hand, start nothing new, submit and record. The cycle ends sooner and does less.`
              : `Nobody is told, so the cycle runs its usual length, which can be hours.`
          } If the cycle is only waiting for a usage limit to lift, this waits with it: use Halt now instead.`
        : `No cycle is running, so there is nothing to wait for but the gate: the team is halted within a few minutes, after the gate's next pass.`,
      word: running ? 'Halt after this cycle' : 'Halt',
      danger: true,
      run: () => act({ action: 'halt-after', reason: haltReason, wrap: running && wrapUp }, 'halt-after')
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

  // Attachments use the Inbox upload: a one-shot job is stored as an owner message.
  async function attach(list) {
    problem = '';
    for (const f of list) {
      if (jobFiles.length >= 8) {
        problem = 'At most 8 attachments per job.';
        break;
      }
      if (f.size > 20 * 1024 * 1024) {
        problem = `${f.name} is over 20 MB.`;
        continue;
      }
      const res = await fetch(`/p/${p.id}/inbox/attach?name=${encodeURIComponent(f.name || 'pasted.png')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f
      });
      if (res.ok) jobFiles = [...jobFiles, await res.json()];
      else problem = `Could not upload ${f.name}.`;
    }
  }
  function pasteJob(e) {
    const got = [...(e.clipboardData?.files || [])];
    if (got.length) {
      e.preventDefault();
      attach(got);
    }
  }
  function askJob() {
    confirm = {
      title: `Start a one-shot job on ${p.name}?`,
      body:
        st.state === 'idle'
          ? `${lead} starts one cycle now, for this job only: it plans the tasks, hands them to the team, sees them through the gate and replies in the Inbox. It runs even if the daily cycle cap is used up, and counts toward it. Then the team goes back to running: the next normal cycle comes about 15 minutes later, if the cap allows. This spends subscription usage, up to the budget per cycle (${c.caps.CYCLE_BUDGET_USD ? `$${c.caps.CYCLE_BUDGET_USD}` : 'see Brakes'}). Unfinished work left by an earlier cycle is not touched.`
          : `${lead} starts one cycle now, for this job only: it plans the tasks, hands them to the team, sees them through the gate and replies in the Inbox. Then the team is halted again and no further cycle starts. This spends subscription usage, up to the budget per cycle (${c.caps.CYCLE_BUDGET_USD ? `$${c.caps.CYCLE_BUDGET_USD}` : 'see Brakes'}). Unfinished work left by an interrupted cycle is not touched. The gate runs during the job, so branches that were already submitted before the halt are tested and merged as usual.`,
      word: 'Start the job',
      run: async () => {
        // A refusal keeps the form as it is, to start again. Otherwise the job
        // is in the Inbox now (started, or kept there as not started).
        const out = await act({ action: 'oneshot', text: jobText, attachments: jobFiles.map((f) => f.token) }, 'oneshot');
        if (out) {
          jobText = '';
          jobFiles = [];
        }
      }
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
    ['FALLBACK_MODEL', 'Fallback model', 'Used when the first one is unavailable.'],
    // Kit 0.10: shown only when the VM reports them.
    ['PLAN_BUDGET_USD', 'Budget per planning cycle, USD', 'For "Find what to do next" on the Backlog tab. Keep it small.'],
    ['CHAT_BUDGET_USD', 'Budget per chat answer, USD', 'Each message to the lead in a backlog chat.'],
    ['FREE_TAKE_APPROVED', 'Normal cycles may take approved backlog items', 'Off: approved items wait for Run now or a set time. On: a normal cycle may pick one up by itself.']
  ];
  const ACTION_BACKLOG = {
    'plan-start': 'Started a planning cycle',
    'backlog-decide': 'Decided on a backlog item',
    'job-at': 'Set a job for a time',
    'job-at-cancel': 'Cancelled a job set for a time',
    'chat-say': 'Sent a chat message to the lead',
    'chat-end': 'Ended a backlog chat'
  };
  const KIND = { token: 'Runs Claude: stopped by a halt', keep: 'Kept running (on the keep list)', other: 'Not Claude: keeps running' };
  const ACTION = {
    halt: 'Halt',
    resume: 'Resume',
    'halt-after': 'Halt after the cycle',
    'halt-after-clear': 'Cancelled the halt after the cycle',
    'schedule-halt': 'Scheduled a stop',
    'clear-scheduled-halt': 'Cleared the scheduled stop',
    'set-cap': 'Changed a setting',
    'gate-pause': 'Paused the gate',
    'gate-resume': 'Resumed the gate',
    'oneshot-start': 'Started a one-shot job',
    oneshot: 'One-shot job',
    'oneshot-again': 'One-shot job, started again',
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
      {#if st.oneshot}
        <p>
          A one-shot job is in progress. {st.oneshot.runsOn ? 'The team goes back to running when this cycle ends.' : 'The team halts again when this cycle ends.'} Follow it under Topology; {lead}'s reply and any
          questions come to the <a href="/p/{p.id}/inbox">Inbox</a>.
        </p>
      {:else if st.state === 'halted' || !st.timerEnabled}
        <p>The team is stopped. Nothing spends tokens until you resume it{p.canOneshot ? ' or start a one-shot job' : ''}.</p>
        <div><button class="btn go" onclick={askResume} disabled={!!busy}>Resume team…</button></div>
      {/if}
      {#if st.schedule}
        <p class="small dim">
          Cycles start at {st.schedule.slots} set time{st.schedule.slots === 1 ? '' : 's'} ({st.schedule.tz}){st.schedule.next ? `; the next is ${when(new Date(st.schedule.next).toISOString())}` : ''}.
          <a href="/schedule">Schedule</a>
        </p>
      {:else if p.canSchedule}
        <p class="small dim">No schedule: cycles follow each other until the daily cap is used up. <a href="/schedule">Set times</a></p>
      {/if}
      {#if !st.oneshot && st.state === 'idle' && idleText(st.idle, p.now)}
        <p>{idleText(st.idle, p.now)}</p>
      {/if}
      {#if st.haltAfter && st.state !== 'halted'}
        <p>
          {#if st.leadActive}
            The team halts when this cycle ends{st.haltAfter.wrapUp ? `, and ${lead} has been asked to wrap up` : ''}.
          {:else}
            The cycle is over. The team halts as soon as the gate has judged what it submitted.
          {/if}
          No new cycle starts.{st.haltAfter.reason ? ` Reason: ${st.haltAfter.reason}.` : ''}
        </p>
        <div><button class="btn quiet" onclick={() => act({ action: 'halt-after-clear' }, 'halt-after-clear')} disabled={!!busy}>Cancel: keep the team running</button></div>
      {/if}
      {#if st.state !== 'halted'}
        <label class="stack">
          <span class="small dim">Reason (shown in the control file and the audit log)</span>
          <input class="field" bind:value={haltReason} placeholder="Weekly usage" maxlength="120" />
        </label>
        <div class="halts">
          <button class="btn stop" onclick={askHalt} disabled={!!busy}>Halt now…</button>
          {#if p.canHaltAfter && !st.haltAfter && !st.oneshot}
            <button class="btn" onclick={askHaltAfter} disabled={!!busy}>{st.leadActive ? 'Halt after this cycle…' : 'Halt after the gate…'}</button>
            {#if st.leadActive}
              <label class="check small dim"><input type="checkbox" bind:checked={wrapUp} /> also ask {lead} to wrap up</label>
            {/if}
          {/if}
        </div>
        {#if !p.canHaltAfter}
          <p class="dim small">Halting after the cycle needs kit 0.5 on the VM (it runs {st.kitVersion || 'an older kit'}).</p>
        {/if}
      {/if}
    </section>

    <section class="panel block" id="oneshot">
      <h2>One-shot job</h2>
      <p class="dim small">
        One cycle for the work you describe here, on a halted team or one between cycles. {lead} plans it, the team does it, and when
        it ends the team is back as it was: halted again, or running on its normal schedule. For feedback and fixes you want now,
        without letting a halted team run on or waiting for the next cycle (or the daily cap).
      </p>
      {#if !p.canOneshot}
        <p class="dim">This needs kit 0.4 on the VM (it runs {st.kitVersion || 'an older kit'}). Upgrade the kit to use it.</p>
      {:else if st.oneshot}
        <p>In progress since {when(st.oneshot.since)}. One job at a time.</p>
      {:else if st.state === 'unreachable' || st.state === 'checking'}
        <p class="dim">The VM is not answering{st.state === 'checking' ? ' yet' : ''}. A job can be started once it does.</p>
      {:else if !canStartJob}
        <p class="dim">
          {#if idleJob}
            On a team between cycles this needs kit 0.6 on the VM (it runs {st.kitVersion || 'an older kit'}). Halt the team first, or upgrade the kit.
          {:else if st.state === 'idle'}
            A halt is pending. Cancel it under Team to start a job on the running team, or wait for the halt.
          {:else}
            Not while a cycle runs: send an <a href="/p/{p.id}/inbox">Inbox</a> message instead, or halt the team first.
          {/if}
        </p>
      {:else}
        <label class="stack">
          <span class="small dim">The job: one task or several, as much detail as you like</span>
          <textarea
            class="field"
            rows="7"
            bind:value={jobText}
            onpaste={pasteJob}
            maxlength="60000"
            placeholder={'1. The field menu closes when I press Triangle twice.\n2. The title music is too loud next to the effects.\n3. Make the dialogue box border one pixel thinner.'}
          ></textarea>
        </label>
        {#if jobFiles.length}
          <ul class="files">
            {#each jobFiles as f, i (f.token)}
              <li class="well">
                <span class="mono small">{f.name}</span>
                <button class="x" onclick={() => (jobFiles = jobFiles.filter((_, j) => j !== i))} aria-label="Remove {f.name}">×</button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="jobrow">
          <input bind:this={jobPicker} type="file" multiple hidden onchange={(e) => { attach([...e.currentTarget.files]); e.currentTarget.value = ''; }} />
          <button class="btn quiet" onclick={() => jobPicker.click()} disabled={!!busy}>Attach files</button>
          <span class="dim small">Or paste a screenshot. Up to 8, 20 MB each.</span>
          <span class="grow"></span>
          <button class="btn go" onclick={askJob} disabled={!!busy || !jobText.trim()}>Start one-shot job…</button>
        </div>
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
      {#each CAPS.filter(([key]) => !key.startsWith('PLAN_') && !key.startsWith('CHAT_') && key !== 'FREE_TAKE_APPROVED' || c.caps[key] != null) as [key, label, help] (key)}
        <div class="cap">
          {#if key === 'FREE_TAKE_APPROVED'}
          <label class="stack">
            <span>{label}</span>
            <span class="small dim">{help}</span>
            <span class="pair tight">
              <input
                type="checkbox"
                checked={c.caps[key] === '1'}
                disabled={!!busy}
                onchange={(e) => act({ action: 'cap', key, value: e.currentTarget.checked ? '1' : '0' }, key)}
              />
              <span>{c.caps[key] === '1' ? 'On' : 'Off'}</span>
            </span>
          </label>
          {:else}
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
          {/if}
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

<section class="panel block" id="publishing">
  <h2>Publishing</h2>
  <p class="dim small">
    Copies the gate's main to a remote git repository, with the same commits. Nobody on the VM can push: the key lives only in this console.
    {lead} asks for a publish at the end of a cycle. The console then waits for the gate, checks what is new (no rewritten history, no secrets,
    no CI files) and pushes. Nothing is ever fetched from the remote into the VM.
  </p>
  {#if !pub.remote || editRemote}
    <div class="pair tight">
      <input class="field mono" bind:value={remoteText} placeholder="git@github.com:owner/repo.git" aria-label="Remote address" maxlength="300" />
      <button class="btn" onclick={() => saveRemote(remoteText.trim())} disabled={!!busy || !remoteText.trim()}>Save</button>
    </div>
    <p class="dim small">An ssh address. Create the repository empty (no README, no licence): the first publish brings the whole history.</p>
    {#if editRemote}<div><button class="btn quiet" onclick={() => (editRemote = false)}>Cancel</button></div>{/if}
  {:else}
    <p>
      Remote: <span class="mono">{pub.remote}</span>
      {#if pub.verified}<span class="s-done"> · verified {when(pub.verified)}</span>{:else}<span class="s-failed"> · not verified yet</span>{/if}
    </p>
    {#if !p.canPublish && p.canControl}
      <p class="s-failed small">This VM's kit is older than 0.8: upgrade it before publishing.</p>
    {/if}

    <div class="stack">
      <span class="small dim">1. Add this key to the repository as a deploy key <strong>with write access</strong>. It works for this one repository only.</span>
      <pre class="mono pubkey">{pub.publicKey || 'The key is being made. Reload the page.'}</pre>
      <div><button class="btn quiet" onclick={copyKey} disabled={!pub.publicKey}>{copied ? 'Copied' : 'Copy the key'}</button></div>
    </div>
    <div class="stack small dim">
      <span>2. Protect <span class="mono">main</span> on the remote (a ruleset or branch protection): block force pushes, block deletion, and let only this deploy key push.</span>
      <span>3. Turn off what the project does not use there: issues, wiki, and CI (Actions, pipelines). The console refuses to publish CI files.</span>
    </div>

    {#if hostAsk}
      <div class="panel note warn">
        <p>The host <span class="mono">{hostAsk.host}</span> shows this key ({hostAsk.type}):</p>
        <p class="mono">{hostAsk.fingerprint}</p>
        <p class="small dim">Compare it with the fingerprints your git host publishes. Confirm only if it matches: from then on the console accepts no other key for this host.</p>
        <div class="halts">
          <button class="btn" onclick={() => verifyRemote(hostAsk.fingerprint)} disabled={!!busy}>It matches: trust this host</button>
          <button class="btn quiet" onclick={() => (hostAsk = null)}>Cancel</button>
        </div>
      </div>
    {/if}
    {#if pubChecks?.checks}
      <ul class="checks small">
        {#each pubChecks.checks as k (k.name)}
          <li class={k.ok ? 's-done' : 's-failed'}>{k.name}: {k.ok ? 'ok' : 'failed'} <span class="dim">{k.detail}</span></li>
        {/each}
      </ul>
    {/if}

    <p>
      {#if pub.sha}Published: <span class="mono">{pub.sha.slice(0, 9)}</span> <span class="dim">{when(pub.at)}</span>{:else}Nothing has been published yet.{/if}
      {#if st.main?.sha && pub.sha && !pub.sha.startsWith(st.main.sha)}<span class="dim"> · gate main is {st.main.sha}</span>{/if}
    </p>
    {#if pub.blocked}
      <div class="panel note bad">
        <p>The last publish was refused {when(pub.blocked.at)}: {pub.blocked.reason}</p>
        <p class="small dim">{lead} has been told. Nothing was pushed.</p>
      </div>
    {/if}
    {#if pub.request}
      <p class="small dim">
        {lead}'s request ({when(pub.request.date)}): {pub.request.publish === 'yes' ? 'publish' : 'do not publish'}{pub.request.summary ? `. ${pub.request.summary}` : ''}
      </p>
    {/if}
    <div class="halts">
      <button class="btn" onclick={() => verifyRemote()} disabled={!!busy}>{busy === 'verify' ? 'Checking…' : pub.verified ? 'Verify again' : 'Verify'}</button>
      <button class="btn" onclick={askPublish} disabled={!!busy || !pub.verified || !p.canPublish || pub.busy}>{busy === 'publish' || pub.busy ? 'Publishing…' : 'Publish now…'}</button>
      <button
        class="btn quiet"
        onclick={() => {
          remoteText = pub.remote;
          editRemote = true;
        }}
        disabled={!!busy}>Change the remote</button
      >
      <button class="btn quiet" onclick={() => saveRemote('')} disabled={!!busy}>Turn off</button>
    </div>
    {#if data.publishHistory.length}
      <div class="scroll-x">
        <table class="grid">
          <thead><tr><th>When</th><th>Outcome</th><th>Commit</th><th class="num">Commits</th><th>Asked by</th><th>Detail</th></tr></thead>
          <tbody>
            {#each data.publishHistory as h (h.at + h.outcome)}
              <tr>
                <td class="mono nowrap">{when(h.at)}</td>
                <td class={h.outcome === 'blocked' ? 's-failed' : 's-done'}>{h.outcome === 'blocked' ? 'refused' : h.outcome === 'in-sync' ? 'already there' : 'published'}</td>
                <td class="mono">{h.sha ? h.sha.slice(0, 9) : '–'}</td>
                <td class="num mono">{h.commits ?? '–'}</td>
                <td>{h.by === 'request' ? lead : h.by}</td>
                <td class="small">{h.detail || h.summary || ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</section>

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
            <td class="nowrap">{ACTION[a.action] || ACTION_BACKLOG[a.action] || a.action}</td>
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
  .pubkey {
    margin: 0;
    padding: 8px 10px;
    white-space: pre-wrap;
    word-break: break-all;
    border: 1px solid var(--line, currentColor);
    border-radius: 6px;
    user-select: all;
  }
  .checks {
    margin: 0;
    padding-left: 18px;
  }
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
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
  }
  .x {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
  }
  .halts {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .jobrow {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  textarea.field {
    resize: vertical;
    min-height: 120px;
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
