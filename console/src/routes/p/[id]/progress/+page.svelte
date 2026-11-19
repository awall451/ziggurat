<script>
  import { num, usd, dur, when } from '$lib/format.js';
  import Chart from '$lib/components/Chart.svelte';

  let { data } = $props();
  const pr = $derived(data.progress);
  const cycles = $derived(pr.cycles.filter((c) => c.counted));
  const newestFirst = $derived(pr.cycles.slice().reverse());

  const axis = (t) => ({
    axisLine: { lineStyle: { color: t.axis } },
    axisLabel: { color: t.ink2, fontFamily: t.mono, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid } }
  });
  const tip = (t) => ({
    trigger: 'axis',
    backgroundColor: t.surface,
    borderColor: t.axis,
    textStyle: { color: t.ink, fontSize: 12 }
  });

  const cycleChart = $derived((t) => ({
    grid: { left: 48, right: 48, top: 44, bottom: 28 },
    tooltip: tip(t),
    legend: { textStyle: { color: t.ink2 }, top: 0, left: 'center' },
    xAxis: { type: 'category', data: cycles.map((_, i) => `${i + 1}`), ...axis(t) },
    yAxis: [
      { type: 'value', name: 'USD', nameTextStyle: { color: t.ink2 }, ...axis(t) },
      { type: 'value', name: 'min', nameTextStyle: { color: t.ink2 }, ...axis(t), splitLine: { show: false } }
    ],
    series: [
      {
        name: 'Estimate, USD',
        type: 'bar',
        data: cycles.map((c) => (c.costUsd == null ? null : Math.round(c.costUsd * 100) / 100)),
        itemStyle: { color: t.series1, borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 28
      },
      {
        name: 'Minutes',
        type: 'line',
        yAxisIndex: 1,
        data: cycles.map((c) => (c.secs == null ? null : Math.round(c.secs / 60))),
        lineStyle: { color: t.warn, width: 2 },
        itemStyle: { color: t.warn },
        symbolSize: 5
      }
    ]
  }));

  const testsChart = $derived((t) => ({
    grid: { left: 56, right: 16, top: 16, bottom: 28 },
    tooltip: tip(t),
    xAxis: { type: 'time', ...axis(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axis(t), scale: true },
    series: [
      {
        name: 'Tests on main',
        type: 'line',
        step: 'end',
        showSymbol: false,
        data: pr.testsSeries.map((p) => [p.at, p.tests]),
        lineStyle: { color: t.good, width: 2 },
        areaStyle: { color: t.good, opacity: 0.12 }
      }
    ]
  }));
</script>

<div class="cols">
  <section class="panel block">
    <h2>Cycles</h2>
    <p class="dim small">Estimate is Claude Code's API-equivalent figure for the lead's session, not a bill.</p>
    {#if cycles.length}
      <Chart buildOption={cycleChart} height={240} />
    {:else}
      <p class="dim">No finished cycles yet.</p>
    {/if}
  </section>
  <section class="panel block">
    <h2>Tests on main</h2>
    <p class="dim small">Count reported by the gate each time it merged.</p>
    {#if pr.testsSeries.length}
      <Chart buildOption={testsChart} height={240} />
    {:else}
      <p class="dim">The gate has not merged anything yet.</p>
    {/if}
  </section>
</div>

<section class="panel block">
  <h2>Cycle log</h2>
  <p class="dim small">The summary is the end of the lead's last message of the cycle (the ledger keeps its last 600 characters).</p>
  <div class="scroll-x">
    <table class="grid">
      <thead>
        <tr><th>Started</th><th class="num">Time</th><th class="num">Turns</th><th class="num">Estimate</th><th>Result</th><th>Summary from the lead</th></tr>
      </thead>
      <tbody>
        {#each newestFirst as c (c.start + c.session)}
          <tr>
            <td class="mono nowrap">{when(c.start)}</td>
            <td class="num">{dur(c.secs)}</td>
            <td class="num">{num(c.turns)}</td>
            <td class="num">{usd(c.costUsd)}</td>
            <td class="nowrap">
              {#if c.halted}<span class="s-interrupted">halted by you</span>
              {:else if c.limited}<span class="s-interrupted">usage limit, not counted</span>
              {:else if c.rc === 0 && !c.isError}<span class="s-done">finished</span>
              {:else}<span class="s-failed">ended with an error</span>{/if}
            </td>
            <td class="summary">{c.summary.length >= 600 ? '… ' : ''}{c.summary}</td>
          </tr>
        {:else}
          <tr><td colspan="6" class="dim">No cycles in the ledger yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<section class="panel block">
  <h2>Gate verdicts</h2>
  <p class="dim small">Newest first. The gate tests every submitted branch on a fresh checkout before main moves.</p>
  <div class="scroll-x">
    <table class="grid">
      <thead>
        <tr><th>When</th><th>Branch</th><th>Commit</th><th>Verdict</th><th class="num">Tests</th><th>Detail</th></tr>
      </thead>
      <tbody>
        {#each pr.gate as g (g.at + g.topic + g.sha)}
          <tr class:faint={g.canary || g.proof}>
            <td class="mono nowrap">{when(g.at)}</td>
            <td class="mono">{g.topic}</td>
            <td class="mono">{g.sha}</td>
            <td>
              {#if g.proof}
                <!-- A gate proof: the refused branch is the expected, good outcome. -->
                <span class="dim">{g.status === 'failed' ? 'refused' : g.status} · gate proof</span>
              {:else}
                <span class={g.status === 'merged' ? 's-done' : g.status === 'failed' || g.status === 'rejected' ? 's-failed' : 'dim'}>{g.status}</span>
              {/if}
            </td>
            <td class="num">{num(g.tests)}</td>
            <td class="dim">{g.detail}</td>
          </tr>
        {:else}
          <tr><td colspan="6" class="dim">No verdicts yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 16px;
  }
  .block {
    padding: 18px;
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .block p {
    margin: 0;
  }
  .nowrap {
    white-space: nowrap;
  }
  .summary {
    min-width: 320px;
    color: #c5d9ee;
  }
  .faint {
    opacity: 0.5;
  }
</style>
