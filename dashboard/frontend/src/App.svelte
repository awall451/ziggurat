<script>
  import Chart from './lib/Chart.svelte'
  import { md } from './lib/md.js'

  let index = $state(null)
  let box = $state(null)
  let d = $state(null)
  let err = $state(null)

  async function getJson(path) {
    const r = await fetch(path, { cache: 'no-store' })
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
    return r.json()
  }

  async function load(name) {
    try {
      const next = await getJson(`./data/${name}/dashboard.json`)
      // Switch box and data together so no image URL mixes the two boxes.
      box = name
      d = next
      trialIdx = Math.max(0, (d.trials?.length ?? 1) - 1)
      digestDate = d.digests[0]?.date ?? null
      const days = Object.keys(d.shots).sort()
      shotDate = days.at(-1) ?? null
      compareDate = days.length > 1 ? days[0] : null
    } catch (e) { err = String(e) }
  }

  $effect(() => {
    getJson('./data/index.json')
      .then((i) => { index = i; if (i.boxes.length) load(i.boxes[0].box) })
      .catch((e) => (err = String(e)))
  })

  // ── formatting ──────────────────────────────────────────────────────────
  const usd = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2))
  const ago = (iso) => {
    if (!iso) return '—'
    const m = Math.round((Date.now() - new Date(iso)) / 60000)
    if (m < 60) return `${m} min ago`
    if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
    return `${Math.round(m / 1440)} days ago`
  }
  const local = (iso) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
  const shortModel = (m) => (m || '').replace('claude-', '').replace(/-\d+(-\d+)?$/, '')

  // ── brief + audio ───────────────────────────────────────────────────────
  let digestDate = $state(null)
  let digest = $derived(d?.digests.find((x) => x.date === digestDate))
  let audioEl = $state(null)
  let playing = $state(false)
  function toggleAudio() {
    if (!audioEl) return
    audioEl.paused ? audioEl.play() : audioEl.pause()
  }

  // ── screenshots ─────────────────────────────────────────────────────────
  let shotDate = $state(null)
  let compareDate = $state(null)
  let comparing = $state(false)
  let shotDays = $derived(d ? Object.keys(d.shots).sort().reverse() : [])
  let zoom = $state(null)
  const caption = (f) => f.replace(/^\d+-/, '').replace('.png', '').replace(/-/g, ' ')

  // ── tiles ───────────────────────────────────────────────────────────────
  let tiles = $derived(d ? [
    { label: 'Cycles (24 h)', value: d.last24.cycles, sub: `${d.last24.minutes} min of work` },
    { label: 'Usage (24 h)', value: usd(d.last24.api_usd), sub: 'API-equivalent, not a bill' },
    { label: 'Merged (24 h)', value: d.last24.merged, sub: 'through the gate', tone: d.last24.merged ? 'good' : null },
    { label: 'Gate failures (24 h)', value: d.last24.failed, sub: 'failed or rejected', tone: d.last24.failed ? 'warn' : null },
    { label: 'Unit tests', value: d.tests_now ?? '—', sub: 'on main' },
    { label: 'Open QA issues', value: d.issues_open, sub: `${d.issues.length} filed total` },
    { label: 'Escalations', value: d.escalations_count, sub: 'waiting on you?', tone: d.escalations_count ? 'warn' : null },
    { label: 'Usage (30 d)', value: usd(d.usage?.summary_30d?.api_usd), sub: `${d.usage?.summary_30d?.subagents ?? 0} subagent runs` },
  ] : [])

  // ── charts ──────────────────────────────────────────────────────────────
  const axisBase = (t) => ({
    axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.muted },
    splitLine: { lineStyle: { color: t.grid } },
  })
  let usageOpt = $derived((t) => ({
    grid: { left: 48, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => usd(v) },
    xAxis: { type: 'category', data: (d?.usage?.daily ?? []).map((x) => x.date.slice(5)), ...axisBase(t) },
    yAxis: { type: 'value', ...axisBase(t), axisLabel: { color: t.muted, formatter: '${value}' } },
    series: [{ type: 'bar', data: (d?.usage?.daily ?? []).map((x) => +x.api_usd.toFixed(2)),
               itemStyle: { color: t.series1, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 28 }],
  }))
  let cycleOpt = $derived((t) => ({
    grid: { left: 48, right: 48, top: 24, bottom: 28 },
    legend: { textStyle: { color: t.muted }, top: 0, itemHeight: 8 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: (d?.cycles ?? []).map((c) => local(c.start)), ...axisBase(t) },
    yAxis: [
      { type: 'value', name: '', ...axisBase(t), axisLabel: { color: t.muted, formatter: '${value}' } },
      { type: 'value', ...axisBase(t), splitLine: { show: false }, axisLabel: { color: t.muted, formatter: '{value}m' } },
    ],
    series: [
      { name: 'Cost', type: 'bar', data: (d?.cycles ?? []).map((c) => +(c.cost_usd ?? 0).toFixed(2)),
        itemStyle: { color: t.series1, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 24 },
      { name: 'Minutes', type: 'line', yAxisIndex: 1, data: (d?.cycles ?? []).map((c) => Math.round((c.secs ?? 0) / 60)),
        lineStyle: { color: t.muted }, itemStyle: { color: t.muted }, symbolSize: 5 },
    ],
  }))
  let testsOpt = $derived((t) => ({
    grid: { left: 40, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: (d?.tests_series ?? []).map((x) => local(x.at)), ...axisBase(t) },
    yAxis: { type: 'value', ...axisBase(t), minInterval: 1 },
    series: [{ type: 'line', step: 'end', data: (d?.tests_series ?? []).map((x) => x.tests),
               lineStyle: { color: t.good, width: 2 }, itemStyle: { color: t.good }, areaStyle: { color: t.good, opacity: 0.08 } }],
  }))

  // ── trials ──────────────────────────────────────────────────────────────
  let trialIdx = $state(0)
  let trial = $derived(d?.trials?.length ? d.trials[Math.min(trialIdx, d.trials.length - 1)] : null)
  let trialShots = $state('new')   // 'new' | 'compare'
  const pct = (v) => (v == null ? '—' : Math.round(v) + '%')
  const tierName = (k) => {
    const [who, model] = k.split(':')
    const m = model.replace('claude-', '').replace(/-\d.*$/, '')
    return who === 'eru' ? `Lead (${m})` : m === 'opus' ? 'Opus (leads, review, QA)' : m === 'sonnet' ? 'Sonnet (builders)' : m === 'haiku' ? 'Haiku (scouts)' : m
  }
  let trialRows = $derived.by(() => {
    if (!trial?.baseline) return []
    const b = trial.baseline, r = trial.result
    const bTests = (b.tests_on_main ?? 0) - (b.tests_before ?? 0)
    const rTests = r.tests.after - r.tests.before
    const newOnly = r.merged?.filter((m) => m.kind === 'new').length || r.feature_branches_merged
    return [
      { k: 'Spend (API-equivalent)', a: usd(b.tracker_7d.api_usd) + ` over ${b.cycles_count ?? b.cycles.length} cycles`, b: usd(r.tracker_total_usd) + ' in 1 cycle' },
      { k: 'Branches merged', a: b.merged_branches, b: `${r.feature_branches_merged} (${newOnly} new goals, ${r.feature_branches_merged - newOnly} finished leftovers)` },
      { k: 'Cost per merged branch', a: usd(b.usd_per_merged_branch), b: newOnly === r.feature_branches_merged ? usd(r.tracker_total_usd / newOnly) : `${usd(r.tracker_total_usd / r.feature_branches_merged)} – ${usd(r.tracker_total_usd / newOnly)}`, good: true },
      { k: 'Unit tests added', a: `+${bTests} (${b.tests_before} → ${b.tests_on_main})`, b: `+${rTests} (${r.tests.before} → ${r.tests.after})` },
      { k: 'Tests added per $', a: (bTests / b.tracker_7d.api_usd).toFixed(1), b: (rTests / r.tracker_total_usd).toFixed(1), good: true },
    ]
  })
  let tierOpt = $derived((t) => {
    if (!trial?.baseline) return {}
    const order = ['opus', 'sonnet', 'haiku', 'fable']
    const colors = { opus: t.critical, sonnet: t.series1, haiku: t.good, fable: t.muted }
    const share = (tiers, m) => {
      const tot = Object.values(tiers).reduce((s, v) => s + v.usd, 0)
      return +(100 * Object.entries(tiers).filter(([k]) => k.includes(m)).reduce((s, [, v]) => s + v.usd, 0) / tot).toFixed(1)
    }
    const labels = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable (lead)' }
    return {
      grid: { left: 70, right: 16, top: 30, bottom: 20 },
      legend: { top: 0, textStyle: { color: t.muted }, itemHeight: 8 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => v + '%' },
      xAxis: { type: 'value', max: 100, ...axisBase(t), axisLabel: { color: t.muted, formatter: '{value}%' } },
      yAxis: { type: 'category', data: ['Trial', 'Old'], ...axisBase(t) },
      series: order.map((m) => ({
        name: labels[m], type: 'bar', stack: 'x', barWidth: 22, itemStyle: { color: colors[m] },
        label: { show: true, color: '#fff', fontSize: 11, formatter: (p) => (p.value >= 6 ? p.value + '%' : '') },
        data: [share(trial.result.by_tier, m), share(trial.baseline.by_tier, m)],
      })),
    }
  })

  // ── issues ──────────────────────────────────────────────────────────────
  const sevRank = { blocker: 0, major: 1, minor: 2, polish: 3 }
  let issues = $derived(d ? [...d.issues].filter((i) => i.severity !== 'n/a')
    .sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9)) : [])
</script>

<div class="wrap">
  <header class="top">
    <div>
      <h1>Agent Fleet</h1>
      <div class="muted small">autonomous teams in sandbox VMs</div>
    </div>
    {#if index}
      <div class="boxes">
        {#each index.boxes as b}
          <button class="chip" class:active={b.box === box} onclick={() => load(b.box)}>{b.box}</button>
        {/each}
      </div>
    {/if}
  </header>

  {#if err}
    <div class="card banner bad">Could not load data: {err}</div>
  {:else if !d}
    <p class="muted">Loading…</p>
  {:else}
    <section class="statusbar card">
      <span class="pill" class:paused={d.status.paused}>{d.status.paused ? 'Paused' : 'Running'}</span>
      <span>Last cycle ended <strong>{ago(d.status.last_cycle?.end)}</strong>
        {#if d.status.last_cycle}· {Math.round((d.status.last_cycle.secs ?? 0) / 60)} min · {usd(d.status.last_cycle.cost_usd)}{/if}</span>
      <span class="muted small right">data {ago(d.generated_at)}</span>
    </section>

    <!-- ── Morning brief ── -->
    <section class="card brief">
      <div class="brief-head">
        <h2>Morning brief</h2>
        <div class="brief-controls">
          {#if digest?.mp3}
            <button class="speak" onclick={toggleAudio} aria-label={playing ? 'Pause brief' : 'Play brief'}>
              {playing ? '⏸ Pause' : '▶ Listen'}
            </button>
            {#key digestDate}
              <audio bind:this={audioEl} src={`./data/${box}/digests/${digestDate}.mp3`} preload="none"
                     onplay={() => (playing = true)} onpause={() => (playing = false)} onended={() => (playing = false)}></audio>
            {/key}
          {/if}
          {#if d.digests.length}
            <select bind:value={digestDate} aria-label="Brief date" onchange={() => (playing = false)}>
              {#each d.digests as g}<option value={g.date}>{g.date}</option>{/each}
            </select>
          {/if}
        </div>
      </div>
      {#if digest}
        <div class="prose">{@html md(digest.md.replace(/^# .*\n/, ''))}</div>
      {:else}
        <p class="muted">No brief yet. The first one lands at 08:00.</p>
      {/if}
    </section>

    <!-- ── Tiles ── -->
    <section class="tiles">
      {#each tiles as t}
        <div class="tile card">
          <div class="label">{t.label}</div>
          <div class="value {t.tone ?? ''}">{t.value}</div>
          <div class="sub muted">{t.sub}</div>
        </div>
      {/each}
    </section>

    <!-- ── Trial runs ── -->
    {#if trial}
      <section class="card trial">
        <div class="brief-head">
          <h2>Trial run: {trial.result.title ?? trial.name}</h2>
          {#if d.trials.length > 1}
            <select bind:value={trialIdx} aria-label="Trial">
              {#each d.trials as tr, i}<option value={i}>{tr.result.title ?? tr.name}</option>{/each}
            </select>
          {/if}
        </div>
        <p class="muted small">
          {local(trial.result.started)} – {local(trial.result.ended)} · {Math.round(trial.result.cycle_secs / 60)} min ·
          {trial.result.sessions} sessions ({trial.result.subagents ?? '?'} subagents) · compared with the old model's first {trial.baseline?.cycles_count ?? 5} cycles
        </p>

        <div class="tablewrap">
          <table class="cmp">
            <thead><tr><th></th><th>Old model</th><th>Trial</th></tr></thead>
            <tbody>
              {#each trialRows as row}
                <tr><td class="muted">{row.k}</td><td>{row.a}</td><td class:goodtext={row.good}><strong>{row.b}</strong></td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if trial.result.note}<p class="muted small">Caveat: {trial.result.note}.</p>{/if}
        {#if trial.result.flags?.length}
          <div class="flags">
            <strong class="small">Worth knowing</strong>
            <ul>{#each trial.result.flags as f}<li class="small">{f}</li>{/each}</ul>
          </div>
        {/if}

        <h3 class="sub">Where the spend went</h3>
        <Chart buildOption={tierOpt} height={130} />

        {#if trial.result.merged}
          <h3 class="sub">Merged in this session</h3>
          <ul class="merged">
            {#each trial.result.merged as m}
              <li><span class="badge {m.kind}">{m.kind}</span> <span class="mono">{m.topic}</span> <span class="muted">{m.what}</span></li>
            {/each}
          </ul>
        {/if}

        {#if trial.after.length}
          <div class="brief-head">
            <h3 class="sub">The game after this session</h3>
            <div class="brief-controls">
              <button class="chip" class:active={trialShots === 'new'} onclick={() => (trialShots = 'new')}>New screens ({trial.new_screens.length})</button>
              <button class="chip" class:active={trialShots === 'compare'} onclick={() => (trialShots = 'compare')}>Before / after</button>
            </div>
          </div>
          {#if trialShots === 'new'}
            <div class="shots">
              {#each trial.new_screens as f}
                <figure>
                  <button class="imgbtn" onclick={() => (zoom = `./data/${box}/trials/${trial.name}/after/${f}`)}>
                    <img src={`./data/${box}/trials/${trial.name}/after/${f}`} alt={caption(f)} loading="lazy" />
                  </button>
                  <figcaption class="muted small">{caption(f)}</figcaption>
                </figure>
              {/each}
            </div>
          {:else}
            <div class="shots two">
              {#each trial.after.filter((f) => trial.before.includes(f)) as f}
                <figure>
                  <div class="pair">
                    <button class="imgbtn" onclick={() => (zoom = `./data/${box}/trials/${trial.name}/before/${f}`)}>
                      <img src={`./data/${box}/trials/${trial.name}/before/${f}`} alt="{caption(f)} before" loading="lazy" /><span class="tag">before</span>
                    </button>
                    <button class="imgbtn" onclick={() => (zoom = `./data/${box}/trials/${trial.name}/after/${f}`)}>
                      <img src={`./data/${box}/trials/${trial.name}/after/${f}`} alt="{caption(f)} after" loading="lazy" /><span class="tag">after</span>
                    </button>
                  </div>
                  <figcaption class="muted small">{caption(f)}</figcaption>
                </figure>
              {/each}
            </div>
          {/if}
        {/if}

        {#if trial.summary_md}
          <details class="inner">
            <summary><h3 class="sub">The lead's report for this session</h3></summary>
            <div class="prose">{@html md(trial.summary_md)}</div>
          </details>
        {/if}
      </section>
    {/if}

    <!-- ── Screenshots ── -->
    <section class="card">
      <div class="brief-head">
        <h2>What the game looks like</h2>
        <div class="brief-controls">
          <select bind:value={shotDate} aria-label="Screenshot date">
            {#each shotDays as s}<option value={s}>{s}</option>{/each}
          </select>
          {#if shotDays.length > 1}
            <label class="small"><input type="checkbox" bind:checked={comparing} /> compare with</label>
            {#if comparing}
              <select bind:value={compareDate} aria-label="Compare date">
                {#each shotDays as s}<option value={s}>{s}</option>{/each}
              </select>
            {/if}
          {/if}
        </div>
      </div>
      {#if shotDate}
        <p class="muted small">Captured by the gate from the newest build that passed every check.</p>
        <div class="shots" class:two={comparing && compareDate}>
          {#each d.shots[shotDate] as f}
            <figure>
              <div class="pair">
                {#if comparing && compareDate && d.shots[compareDate]?.includes(f)}
                  <button class="imgbtn" onclick={() => (zoom = `./data/${box}/shots/${compareDate}/${f}`)}>
                    <img src={`./data/${box}/shots/${compareDate}/${f}`} alt="{caption(f)} on {compareDate}" loading="lazy" />
                    <span class="tag">{compareDate}</span>
                  </button>
                {/if}
                <button class="imgbtn" onclick={() => (zoom = `./data/${box}/shots/${shotDate}/${f}`)}>
                  <img src={`./data/${box}/shots/${shotDate}/${f}`} alt="{caption(f)} on {shotDate}" loading="lazy" />
                  {#if comparing}<span class="tag">{shotDate}</span>{/if}
                </button>
              </div>
              <figcaption class="muted small">{caption(f)}</figcaption>
            </figure>
          {/each}
        </div>
      {:else}
        <p class="muted">No screenshots yet.</p>
      {/if}
    </section>

    <!-- ── Charts ── -->
    <div class="charts">
      <section class="card">
        <h3>Usage per day</h3>
        <p class="muted small">API-equivalent dollars from the token tracker (all agents, last 30 days)</p>
        <Chart buildOption={usageOpt} height={220} />
      </section>
      <section class="card">
        <h3>Lead cycles</h3>
        <p class="muted small">Cost and length of each cycle</p>
        <Chart buildOption={cycleOpt} height={220} />
      </section>
      <section class="card">
        <h3>Unit tests on main</h3>
        <p class="muted small">After each merge; the gate never lets this drop</p>
        <Chart buildOption={testsOpt} height={220} />
      </section>
    </div>

    <!-- ── Agent work, last 24h ── -->
    {#if d.usage?.recent_sessions?.length}
      <section class="card">
        <h2>Agent work, last 24 hours</h2>
        <p class="muted small">Every lead cycle and every agent task, from the token tracker</p>
        <div class="tablewrap">
          <table>
            <thead><tr><th>Task</th><th>Model</th><th class="num">Turns</th><th class="num">+Lines</th><th class="num">Usage</th></tr></thead>
            <tbody>
              {#each d.usage.recent_sessions as s}
                <tr>
                  <td>{s.subagent ? s.name : `★ Lead cycle, ${local(new Date(s.last_ts).toISOString())}`}</td>
                  <td class="muted">{Object.keys(s.models ?? {}).map(shortModel).join(', ')}</td>
                  <td class="num">{s.turns}</td>
                  <td class="num">{s.lines_added ?? 0}</td>
                  <td class="num">{usd(s.api_usd)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="muted small">★ = the lead's own cycle session</p>
      </section>
    {/if}

    <!-- ── Gate ── -->
    <section class="card">
      <h2>Gate verdicts</h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>When</th><th>Topic</th><th>Verdict</th><th>Detail</th></tr></thead>
          <tbody>
            {#each d.gate as g}
              <tr class:canary={g.canary}>
                <td class="nowrap">{local(g.at)}</td>
                <td class="mono">{g.topic}</td>
                <td><span class="verdict {g.status}">{g.status}</span></td>
                <td class="small">{g.detail}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Escalations ── -->
    {#if d.escalations_count}
      <section class="card warnbox">
        <h2>Escalations</h2>
        <div class="prose">{@html md(d.escalations_md.replace(/^# .*\n/, ''))}</div>
      </section>
    {/if}

    <!-- ── Roadmap / state ── -->
    <details class="card" open>
      <summary><h2>The lead's plan</h2><span class="muted small">STATE.md, rewritten every cycle</span></summary>
      <div class="prose">{@html md(d.state_md.replace(/^# .*\n/, ''))}</div>
    </details>

    <!-- ── QA issues ── -->
    <details class="card">
      <summary><h2>QA issues ({issues.length})</h2><span class="muted small">filed by the QA agent from playing the game</span></summary>
      {#each issues as i}
        <details class="issue">
          <summary><span class="sev {i.severity}">{i.severity}</span> {i.title} <span class="muted small">{i.area}</span></summary>
          <div class="prose small">{@html md(i.excerpt)}</div>
        </details>
      {/each}
    </details>

    <!-- ── Journal ── -->
    <details class="card">
      <summary><h2>Journal</h2><span class="muted small">the lead's log, newest at the bottom</span></summary>
      <div class="prose">{@html md(d.journal_md)}</div>
    </details>
  {/if}
</div>

{#if zoom}
  <button class="lightbox" onclick={() => (zoom = null)} aria-label="Close">
    <img src={zoom} alt="screenshot, enlarged" />
  </button>
{/if}

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin: 8px 0 16px; }
  h1 { font-size: 26px; }
  h2 { font-size: 18px; }
  h3 { font-size: 15px; }
  .small { font-size: 13px; }
  .right { margin-left: auto; }
  .nowrap { white-space: nowrap; }
  section, details.card { margin-bottom: 14px; }
  .boxes { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--border); background: var(--chip); color: var(--ink); border-radius: 999px; padding: 4px 12px; font: inherit; cursor: pointer; }
  .chip.active { background: var(--series-1); color: #fff; border-color: transparent; }

  .statusbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 16px; }
  .pill { background: var(--good); color: #fff; border-radius: 999px; padding: 2px 10px; font-weight: 600; font-size: 13px; }
  .pill.paused { background: var(--warning); color: #111; }

  .brief-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .brief-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .speak { background: var(--series-1); color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  select { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); color: var(--ink); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .tile { padding: 12px 14px; }
  .tile .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 24px; font-weight: 650; margin: 2px 0; }
  .tile .value.good { color: var(--good-text); }
  .tile .value.warn { color: var(--critical); }
  .tile .sub { font-size: 12px; }

  .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .shots.two { grid-template-columns: 1fr; }
  figure { margin: 0; }
  .pair { display: flex; gap: 8px; }
  .imgbtn { position: relative; flex: 1; padding: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: #000; cursor: zoom-in; }
  .imgbtn img { display: block; width: 100%; image-rendering: pixelated; }
  .tag { position: absolute; left: 6px; top: 6px; background: rgba(0,0,0,.65); color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  figcaption { margin-top: 4px; text-transform: capitalize; }

  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
  .charts section { margin-bottom: 0; }
  .charts + section { margin-top: 14px; }

  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  th { font-weight: 600; color: var(--ink-2); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.canary { opacity: 0.55; }
  .verdict { font-weight: 600; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--chip); }
  .verdict.merged { color: var(--good-text); }
  .verdict.failed, .verdict.rejected { color: var(--critical); }

  details > summary { cursor: pointer; list-style: none; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  details > summary::-webkit-details-marker { display: none; }
  details.card > summary h2::before { content: '▸ '; color: var(--muted); }
  details.card[open] > summary h2::before { content: '▾ '; }
  details.card[open] > summary { margin-bottom: 10px; }
  .issue { border-top: 1px solid var(--grid); padding: 8px 0; }
  .issue summary { display: block; }
  .sev { font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; background: var(--chip); margin-right: 6px; }
  .sev.blocker, .sev.major { color: var(--critical); }
  .sev.minor { color: var(--ink-2); }
  .warnbox { border-color: var(--warning); }
  .banner.bad { border-color: var(--critical); }

  .trial { border-color: var(--series-1); }
  .flags { border-left: 3px solid var(--warning); padding: 4px 10px; margin: 8px 0; background: var(--chip); border-radius: 0 6px 6px 0; }
  .flags ul { margin: 4px 0 0; padding-left: 18px; }
  .trial h3.sub { margin: 16px 0 6px; font-size: 14px; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.04em; }
  table.cmp td:first-child { width: 34%; }
  .goodtext strong { color: var(--good-text); }
  ul.merged { list-style: none; padding: 0; margin: 0; }
  ul.merged li { padding: 4px 0; border-bottom: 1px solid var(--grid); font-size: 14px; }
  .badge { font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; background: var(--chip); }
  .badge.new { color: var(--good-text); }
  .badge.leftover { color: var(--muted); }
  details.inner { margin-top: 10px; }
  details.inner > summary h3::before { content: '▸ '; }
  details.inner[open] > summary h3::before { content: '▾ '; }

  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.85); border: 0; display: flex; align-items: center; justify-content: center; padding: 16px; cursor: zoom-out; z-index: 10; }
  .lightbox img { max-width: 100%; max-height: 100%; image-rendering: pixelated; }

  @media (max-width: 600px) {
    .wrap { padding: 12px 12px 48px; }
    h1 { font-size: 22px; }
    .tile .value { font-size: 20px; }
  }
</style>
