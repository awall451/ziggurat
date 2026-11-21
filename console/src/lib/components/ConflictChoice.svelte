<script>
  // The warning when a job would run into something on its team's row: a
  // planned cycle or another job. Three ways out: place it after, skip that
  // cycle (only when it is one cycle), or go back and pick another time.
  let { conflicts = [], team = 'this team', clockAt = (ms) => String(ms), busy = false, onafter = () => {}, onskip = null, oncancel = () => {} } = $props();
  const lengthText = (ms) => {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
  };
</script>

<div class="warn" role="alert">
  <p>
    <b>This overlaps</b>
    {#each conflicts as c, i (i)}
      {i ? (i === conflicts.length - 1 ? ' and ' : ', ') : ''}{#if c.kind === 'cycle'}{team}'s {clockAt(c.at)} cycle (about {lengthText(c.end - c.at)}){:else}the job “{c.title}” ({clockAt(c.at)} to about {clockAt(c.end)}){/if}
    {/each}.
    {#if onskip}Only one of them can run at a time.{/if}
  </p>
  <div class="actions">
    <button class="btn quiet sm" disabled={busy} onclick={oncancel}>Pick another time</button>
    <span class="spacer"></span>
    {#if onskip}<button class="btn danger sm" disabled={busy} onclick={onskip}>Skip that cycle</button>{/if}
    <button class="btn primary sm" disabled={busy} onclick={onafter}>Place it after</button>
  </div>
</div>

<style>
  .warn {
    border: 1px solid var(--warn);
    border-radius: 10px;
    padding: 10px 12px;
    background: rgba(251, 191, 36, 0.08);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  p {
    margin: 0;
    font-size: 13px;
  }
</style>
