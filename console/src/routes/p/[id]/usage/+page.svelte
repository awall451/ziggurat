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

  function totals(key) {
    const out = {};
    for (const c of cycles) {
      for (const [k, v] of Object.entries(c[key])) {
        const t = (out[k] ||= { costUsd: 0, output: 0, input: 0, cacheRead: 0, cacheWrite: 0, agents: 0 });
        t.costUsd += v.costUsd;
        t.output += v.output;
        t.input += v.input || 0;
        t.cacheRead += v.cacheRead || 0;
        t.cacheWrite += v.cacheWrite || 0;
        t.agents += v.agents;
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
      <h2 class="gap">By role</h2>
      <table class="grid">
        <thead><tr><th>Role</th><th class="num">Agents</th><th class="num">Output</th><th class="num">Estimate</th><th class="num">Share</th></tr></thead>
        <tbody>
          {#each byRole as r (r.name)}
            <tr>
              <td>{kindName[r.name] || r.name}</td>
              <td class="num">{num(r.agents)}</td>
              <td class="num">{num(r.output)}</td>
              <td class="num">{usd(r.costUsd)}</td>
              <td class="num">{total ? Math.round((r.costUsd / total) * 100) : 0}%</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  </div>

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
