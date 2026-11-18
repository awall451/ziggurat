<script>
  import { onMount } from 'svelte';

  // buildOption(tokens) -> ECharts option. Colours come from the CSS
  // variables, so charts follow the theme.
  let { buildOption, height = 260 } = $props();

  let el;
  let chart = null;

  function tokens() {
    const s = getComputedStyle(document.documentElement);
    const v = (name) => s.getPropertyValue(name).trim();
    return {
      surface: v('--surface-1'),
      ink: v('--ink'),
      ink2: v('--ink-2'),
      muted: v('--muted'),
      grid: v('--grid'),
      axis: v('--axis'),
      series1: v('--series-1'),
      good: v('--good'),
      warn: v('--warn'),
      critical: v('--critical'),
      mono: v('--font-mono')
    };
  }

  function render() {
    if (chart) chart.setOption(buildOption(tokens()), true);
  }

  onMount(() => {
    let disposed = false;
    let ro;
    // ECharts is large and needs the DOM: load it in the browser only.
    import('echarts').then((echarts) => {
      if (disposed) return;
      chart = echarts.init(el, null, { renderer: 'canvas' });
      render();
      ro = new ResizeObserver(() => chart.resize());
      ro.observe(el);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chart?.dispose();
    };
  });

  $effect(() => {
    buildOption;
    render();
  });
</script>

<div bind:this={el} style="width:100%; height:{height}px"></div>
