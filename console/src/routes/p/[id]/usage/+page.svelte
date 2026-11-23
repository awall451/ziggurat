<script>
  import { num, usd, when, modelShort } from '$lib/format.js';
  import { md } from '$lib/md.js';
  import Chart from '$lib/components/Chart.svelte';

  let { data } = $props();
  const p = $derived(data.project);
  const cycles = $derived(data.cycles);

  const KIND_ORDER = ['lead', 'area_lead', 'worker', 'scout', 'reviewer', 'qa', 'other'];
  const kindName = $derived({
    lead: p.tiers[0],
    area_lead: p.tiers[1],
    worker: p.tiers[2],
    scout: 'Scouts',
    reviewer: 'Reviewer',
    qa: 'QA',
    other: 'Other'
  });

  const CLASSES = [
    ['cacheWrite', 'Cache write'],
    ['cacheRead', 'Cache read'],
    ['output', 'Output'],
    ['input', 'Fresh input']
  ];
  const KIND_NAME = { normal: 'Normal cycle', oneshot: 'One-shot job', plan: 'Planning cycle' };
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  const mostOf = (counts) => Object.entries(counts || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  function totals(key) {
    const out = {};
    for (const c of cycles) {
      for (const [k, v] of Object.entries(c[key])) {
        const t = (out[k] ||= {
          costUsd: 0,
          output: 0,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          agents: 0,
          requests: 0,
          startTokens: 0,
          parts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          rewrite: { count: 0, costUsd: 0 },
          efforts: {},
          models: {}
        });
        t.costUsd += v.costUsd;
        t.output += v.output;
        t.input += v.input || 0;
        t.cacheRead += v.cacheRead || 0;
        t.cacheWrite += v.cacheWrite || 0;
        t.agents += v.agents;
        t.requests += v.requests || 0;
        t.startTokens += v.startTokens || 0;
        for (const k2 of Object.keys(t.parts)) t.parts[k2] += v.parts?.[k2] || 0;
        t.rewrite.count += v.rewrite?.count || 0;
        t.rewrite.costUsd += v.rewrite?.costUsd || 0;
        for (const [e, n] of Object.entries(v.efforts || {})) t.efforts[e] = (t.efforts[e] || 0) + n;
        for (const [m, n] of Object.entries(v.models || {})) t.models[m] = (t.models[m] || 0) + n;
      }
    }
    return Object.entries(out)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd);
  }
  const byModel = $derived(totals('byModel'));
  const byRole = $derived(totals('byRole').sort((a, b) => KIND_ORDER.indexOf(a.name) - KIND_ORDER.indexOf(b.name)));
  const total = $derived(cycles.reduce((t, c) => t + c.costUsd, 0));
  const models = $derived(byModel.map((m) => m.name));

  // Where the estimate goes, by token class, over all cycles shown.
  const parts = $derived(
    cycles.reduce(
      (t, c) => {
        for (const k of Object.keys(t)) t[k] += c.parts?.[k] || 0;
        return t;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }
    )
  );
  const rewrite = $derived(
    cycles.reduce(
      (t, c) => {
        t.count += c.rewrite?.count || 0;
        t.costUsd += c.rewrite?.costUsd || 0;
        return t;
      },
      { count: 0, costUsd: 0 }
    )
  );
  const byKind = $derived(
    ['normal', 'oneshot', 'plan']
      .map((k) => {
        const rows = cycles.filter((c) => c.kind === k);
        const costs = rows.map((c) => c.costUsd).sort((a, b) => a - b);
        return {
          kind: k,
          runs: rows.length,
          costUsd: costs.reduce((t, v) => t + v, 0),
          median: costs.length ? costs[Math.floor((costs.length - 1) / 2)] : 0,
          chatUsd: rows.reduce((t, c) => t + (c.chat?.costUsd || 0), 0),
          chatTurns: rows.reduce((t, c) => t + (c.chat?.turns || 0), 0)
        };
      })
      .filter((r) => r.runs)
  );
  const chat = $derived(byKind.reduce((t, r) => ({ turns: t.turns + r.chatTurns, costUsd: t.costUsd + r.chatUsd }), { turns: 0, costUsd: 0 }));

  // Each area lead with the model it ran on and what the gate said about its branch.
  const areaLeads = $derived(cycles.flatMap((c) => (c.areaLeads || []).map((a) => ({ ...a, cycle: c.number, sid: c.id }))));
  const leadPicks = $derived.by(() => {
    const out = {};
    for (const a of areaLeads) {
      const t = (out[a.model || 'unknown'] ||= { model: a.model || 'unknown', agents: 0, costUsd: 0, merged: 0, refused: 0, none: 0 });
      t.agents++;
      t.costUsd += a.costUsd;
      if (a.gate === 'merged') t.merged++;
      else if (a.gate === 'failed' || a.gate === 'rejected') t.refused++;
      else t.none++;
    }
    return Object.values(out).sort((a, b) => b.costUsd - a.costUsd);
  });
  const redos = $derived(areaLeads.filter((a) => a.redo));
  const PALETTE = ['#4fd8ff', '#a78bfa', '#fbbf24', '#4ade80', '#f472b6', '#8fb3d9'];

  const stacked = $derived((t) => ({
    grid: { left: 48, right: 16, top: 32, bottom: 28 },
    tooltip: { trigger: 'axis', backgroundColor: t.surface, borderColor: t.axis, textStyle: { color: t.ink, fontSize: 12 } },
    legend: { textStyle: { color: t.ink2 }, top: 0, right: 0 },
    xAxis: {
      type: 'category',
      data: cycles.map((c) => `${c.number}`),
      axisLine: { lineStyle: { color: t.axis } },
      axisLabel: { color: t.ink2, fontFamily: t.mono, fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      name: 'USD',
      nameTextStyle: { color: t.ink2 },
      axisLabel: { color: t.ink2, fontFamily: t.mono, fontSize: 11 },
      splitLine: { lineStyle: { color: t.grid } }
    },
    series: models.map((m, i) => ({
      name: modelShort(m),
      type: 'bar',
      stack: 'cost',
      barMaxWidth: 28,
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      data: cycles.map((c) => Math.round((c.byModel[m]?.costUsd || 0) * 100) / 100)
    }))
  }));
</script>

<p class="dim small note">
  Estimates from the transcripts at API prices (the price table is in the console's config). Subscription use is not billed this way; read
  these as relative size, not money owed. Covers the last {cycles.length} cycles{cycles.length >= data.maxCycles ? ' (the most shown)' : ''}.
</p>

{#if !cycles.length}
  <div class="panel block"><h2>No usage recorded yet</h2></div>
{:else}
  <div class="cols">
    <section class="panel block">
      <h2>Per cycle, by model</h2>
      <Chart buildOption={stacked} height={260} />
    </section>

    <section class="panel block">
      <h2>By model</h2>
      <table class="grid">
        <thead><tr><th>Model</th><th class="num">Agents</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Estimate</th><th class="num">Share</th></tr></thead>
        <tbody>
          {#each byModel as m (m.name)}
            <tr>
              <td class="mono">{m.name}</td>
              <td class="num">{num(m.agents)}</td>
              <td class="num">{num(m.output)}</td>
              <td class="num">{num(m.cacheRead)}</td>
              <td class="num">{usd(m.costUsd)}</td>
              <td class="num">{total ? Math.round((m.costUsd / total) * 100) : 0}%</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  </div>

  <section class="panel block">
    <h2>Where it goes</h2>
    <dl class="facts">
      {#each CLASSES as [k, name] (k)}
        <div><dt>{name}</dt><dd class="mono">{pct(parts[k], total)}%</dd></div>
      {/each}
      <div><dt>Thinking (part of output)</dt><dd class="mono">{pct(parts.thinking, total)}%</dd></div>
      <div>
        <dt>Written again after a wait</dt>
        <dd class="mono">{pct(rewrite.costUsd, total)}% <span class="dim small">{num(rewrite.count)} times</span></dd>
      </div>
    </dl>
    <p class="dim small">
      An agent that waits longer than its cache lives (5 minutes for most agents, 1 hour for the lead) pays to have its whole context written
      again. That share is waste: the same work with shorter waits would not cost it.
    </p>
    <h2 class="gap">By role</h2>
    <div class="scroll-x">
      <table class="grid">
        <thead>
          <tr>
            <th>Role</th><th>Model</th><th>Effort</th><th class="num">Agents</th><th class="num">Requests each</th><th class="num">Starts with</th>
            <th class="num">Cache write</th><th class="num">Cache read</th><th class="num">Output</th><th class="num">Thinking</th><th class="num">Written again</th>
            <th class="num">Estimate</th><th class="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {#each byRole as r (r.name)}
            <tr>
              <td>{kindName[r.name] || r.name}</td>
              <td class="mono">{modelShort(mostOf(r.models) || '') || '–'}{Object.keys(r.models).length > 1 ? ' +' : ''}</td>
              <td class="mono">{mostOf(r.efforts) || '–'}</td>
              <td class="num">{num(r.agents)}</td>
              <td class="num">{num(r.agents ? r.requests / r.agents : 0)}</td>
              <td class="num">{num(r.agents ? r.startTokens / r.agents : 0)}</td>
              <td class="num">{pct(r.parts.cacheWrite, r.costUsd)}%</td>
              <td class="num">{pct(r.parts.cacheRead, r.costUsd)}%</td>
              <td class="num">{pct(r.parts.output, r.costUsd)}%</td>
              <td class="num">{pct(r.parts.thinking, r.costUsd)}%</td>
              <td class="num">{pct(r.rewrite.costUsd, r.costUsd)}%</td>
              <td class="num">{usd(r.costUsd)}</td>
              <td class="num">{pct(r.costUsd, total)}%</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="dim small">"Starts with" is the context, in tokens, of an agent's first request: its instructions and tools before any work. The percentages are shares of that role's own estimate.</p>
  </section>

  <div class="cols">
    <section class="panel block">
      <h2>By kind of run</h2>
      <table class="grid">
        <thead><tr><th>Kind</th><th class="num">Runs</th><th class="num">Median</th><th class="num">Estimate</th><th class="num">Share</th></tr></thead>
        <tbody>
          {#each byKind as k (k.kind)}
            <tr>
              <td>{KIND_NAME[k.kind]}</td>
              <td class="num">{num(k.runs)}</td>
              <td class="num">{usd(k.median)}</td>
              <td class="num">{usd(k.costUsd)}</td>
              <td class="num">{pct(k.costUsd, total)}%</td>
            </tr>
          {/each}
          {#if chat.turns}
            <tr>
              <td>Chat with the lead</td>
              <td class="num">{num(chat.turns)}</td>
              <td class="num">–</td>
              <td class="num">{usd(chat.costUsd)}</td>
              <td class="num dim">apart</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </section>

    <section class="panel block">
      <h2>{p.tiers[1]}: model and gate result</h2>
      {#if leadPicks.length}
        <table class="grid">
          <thead><tr><th>Model</th><th class="num">Started</th><th class="num">Merged</th><th class="num">Refused</th><th class="num">Not submitted</th><th class="num">Estimate</th></tr></thead>
          <tbody>
            {#each leadPicks as m (m.model)}
              <tr>
                <td class="mono">{modelShort(m.model)}</td>
                <td class="num">{num(m.agents)}</td>
                <td class="num">{num(m.merged)}</td>
                <td class="num">{num(m.refused)}</td>
                <td class="num">{num(m.none)}</td>
                <td class="num">{usd(m.costUsd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="dim small">
          The lead picks the model for each goal. "Refused" is a branch the gate failed or rejected; "Not submitted" has no gate line under the
          branch's name (parked, renamed, or submitted as part of another branch).
        </p>
        <h2 class="gap">Done again on the larger model</h2>
        {#if redos.length}
          <table class="grid">
            <thead><tr><th class="num">Cycle</th><th>Goal</th><th class="num">Estimate</th></tr></thead>
            <tbody>
              {#each redos as a (a.sid + a.id)}
                <tr>
                  <td class="num"><a href="/p/{p.id}/topology?s={a.sid}">{a.cycle}</a></td>
                  <td>{a.description}</td>
                  <td class="num">{usd(a.costUsd)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="dim small">None in these cycles.</p>
        {/if}
      {:else}
        <p class="dim small">No {p.tiers[1].toLowerCase()} in these cycles.</p>
      {/if}
    </section>
  </div>

  {#if data.overTime?.length}
    <section class="panel block">
      <h2>Over time</h2>
      <div class="scroll-x">
        <table class="grid">
          <thead>
            <tr>
              <th>Week of</th><th>Kind</th><th class="num">Runs</th><th class="num">Median</th><th class="num">Median time</th>
              <th class="num">Time against estimate</th><th class="num">Cost against estimate</th><th class="num">Written again</th>
              <th class="num">Done again</th><th class="num">Merged / refused</th><th class="num">Estimate</th>
            </tr>
          </thead>
          <tbody>
            {#each data.overTime as w (w.week + w.kind)}
              <tr>
                <td class="mono">{w.week}</td>
                <td>{KIND_NAME[w.kind] || 'Chat with the lead'}</td>
                <td class="num">{num(w.runs)}{#if w.notDone}<span class="dim small"> ({w.notDone} not finished)</span>{/if}</td>
                <td class="num">{usd(w.medianUsd)}</td>
                <td class="num">{w.medianMin == null ? '–' : `${num(w.medianMin)} min`}</td>
                <td class="num">{w.timeRatio == null ? '–' : `${w.timeRatio}× (${w.estimated})`}</td>
                <td class="num">{w.costRatio == null ? '–' : `${w.costRatio}×`}</td>
                <td class="num">{w.kind === 'chat' ? '–' : `${pct(w.rewriteUsd, w.costUsd)}%`}</td>
                <td class="num">{w.redo ? `${w.redo} (${usd(w.redoUsd)})` : '–'}</td>
                <td class="num">{w.kind === 'chat' || w.kind === 'plan' ? '–' : `${w.merged} / ${w.refused}`}</td>
                <td class="num">{usd(w.costUsd)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="dim small">
        One line per finished run is kept, so this goes back further than the cycles above. "Against estimate" is what a job took divided by
        what the lead estimated, for the jobs that had an estimate and finished (how many, in brackets); the middle value. Weeks start on Monday,
        UTC. The same figures as data: <a href="/p/{p.id}/usage/metrics.json">metrics.json</a>.
      </p>
    </section>
  {/if}

  <section class="panel block">
    <h2>Cycles</h2>
    <div class="scroll-x">
      <table class="grid">
        <thead><tr><th class="num">Cycle</th><th>Started</th><th>Result</th><th class="num">All agents, estimate</th><th class="num">Lead's own figure</th></tr></thead>
        <tbody>
          {#each cycles.slice().reverse() as c (c.id)}
            <tr>
              <td class="num"><a href="/p/{p.id}/topology?s={c.id}">{c.number}</a></td>
              <td class="mono">{when(c.started)}</td>
              <td><span class="s-{c.state}">{c.state}</span></td>
              <td class="num">{usd(c.costUsd)}</td>
              <td class="num">{usd(c.ledgerUsd)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

{#each data.trials as t (t.name)}
  <section class="panel block">
    <h2>Trial: {t.result?.title || t.name}</h2>
    {#if t.result}
      <dl class="facts">
        {#if t.result.usd_per_feature_branch != null}<div><dt>Per merged branch</dt><dd class="mono">{usd(t.result.usd_per_feature_branch)}</dd></div>{/if}
        {#if t.baseline?.usd_per_merged_branch != null}<div><dt>Before, per merged branch</dt><dd class="mono">{usd(t.baseline.usd_per_merged_branch)}</dd></div>{/if}
        {#if t.result.tracker_total_usd != null}<div><dt>Total estimate</dt><dd class="mono">{usd(t.result.tracker_total_usd)}</dd></div>{/if}
        {#if t.result.feature_branches_merged != null}<div><dt>Branches merged</dt><dd class="mono">{num(t.result.feature_branches_merged)}</dd></div>{/if}
        {#if t.result.tests}<div><dt>Tests</dt><dd class="mono">{num(t.result.tests.before)} → {num(t.result.tests.after)}</dd></div>{/if}
      </dl>
      {#if t.result.note}<p class="dim small">{t.result.note}</p>{/if}
    {/if}
    {#if t.summary}
      <details>
        <summary>Summary from the lead</summary>
        <!-- sanitised by md() -->
        <div class="md">{@html md(t.summary)}</div>
      </details>
    {/if}
  </section>
{/each}

<style>
  .note {
    margin: 0 0 12px;
    max-width: 900px;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
    gap: 16px;
  }
  .block {
    padding: 18px;
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .gap {
    margin-top: 10px;
  }
  .facts {
    display: flex;
    gap: 28px;
    flex-wrap: wrap;
    margin: 0;
  }
  dt {
    color: var(--ink-2);
    font-size: 12px;
  }
  dd {
    margin: 0;
    font-size: 16px;
  }
  details summary {
    cursor: pointer;
    color: var(--cyan);
  }
  p {
    margin: 0;
  }
</style>
