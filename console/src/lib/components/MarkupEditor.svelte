<script>
  // Draw on a screenshot (box, ellipse, freehand) and write a note about it.
  // Shapes are kept in 0..1 coordinates so they fit any size of the image;
  // on save the drawing is also flattened onto the screenshot as a PNG, which
  // is what the lead looks at.
  import Icon from './Icon.svelte';

  let { src, name = '', onsave = async () => {}, oncancel = () => {} } = $props();

  const TOOLS = [
    ['rect', 'Box'],
    ['ellipse', 'Ellipse'],
    ['path', 'Freehand']
  ];
  const COLORS = ['#ff3b3b', '#fbbf24', '#4ade80', '#4fd8ff', '#ffffff'];

  let tool = $state('ellipse');
  let color = $state(COLORS[0]);
  let shapes = $state([]);
  let draft = $state(null);
  let title = $state('');
  let body = $state('');
  let kind = $state('bug');
  let saving = $state(false);
  let err = $state('');

  let canvas = $state();
  let img = $state(null);

  $effect(() => {
    const i = new Image();
    i.onload = () => (img = i);
    i.src = src;
  });

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  }

  function down(e) {
    if (!img) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    draft = tool === 'path' ? { type: 'path', color, points: [[x, y]] } : { type: tool, color, x0: x, y0: y, x, y, w: 0, h: 0 };
  }

  function moveTo(e) {
    if (!draft) return;
    const [x, y] = point(e);
    if (draft.type === 'path') draft.points.push([x, y]);
    else Object.assign(draft, { x: Math.min(x, draft.x0), y: Math.min(y, draft.y0), w: Math.abs(x - draft.x0), h: Math.abs(y - draft.y0) });
  }

  function up() {
    if (!draft) return;
    const d = draft;
    draft = null;
    if (d.type === 'path' ? d.points.length > 1 : d.w > 0.005 && d.h > 0.005) {
      const { x0, y0, ...s } = d;
      shapes.push(s);
    }
  }

  function paint(ctx, list) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, W, H);
    ctx.lineWidth = Math.max(2, W / 240);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of list) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      if (s.type === 'rect') ctx.rect(s.x * W, s.y * H, s.w * W, s.h * H);
      else if (s.type === 'ellipse') ctx.ellipse((s.x + s.w / 2) * W, (s.y + s.h / 2) * H, (s.w / 2) * W, (s.h / 2) * H, 0, 0, Math.PI * 2);
      else s.points.forEach(([x, y], n) => (n ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
      ctx.stroke();
    }
  }

  $effect(() => {
    if (!img || !canvas) return;
    // Draw at least ~1280 px wide so lines stay crisp on small pixel-art shots.
    const scale = Math.max(1, Math.ceil(1280 / img.naturalWidth));
    canvas.width = img.naturalWidth * scale;
    canvas.height = img.naturalHeight * scale;
    paint(canvas.getContext('2d'), draft ? [...shapes, draft] : shapes);
  });

  async function save() {
    err = '';
    if (!title.trim()) {
      err = 'Give the note a short title';
      return;
    }
    saving = true;
    try {
      paint(canvas.getContext('2d'), shapes);
      const blob = shapes.length ? await new Promise((r) => canvas.toBlob(r, 'image/png')) : null;
      await onsave({ title: title.trim(), body: body.trim(), kind, markup: $state.snapshot(shapes), blob });
    } catch (e) {
      err = e.message || 'Could not save';
    } finally {
      saving = false;
    }
  }

  function key(e) {
    if (e.key === 'Escape') oncancel();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      shapes.pop();
    }
  }
</script>

<svelte:window onkeydown={key} />

<div class="wrap" role="dialog" aria-modal="true" aria-label="Leave a note on {name}">
  <button class="shade" onclick={oncancel} aria-label="Cancel"></button>
  <div class="box panel lit">
    <header>
      <h2>Note on <span class="cap">{name}</span></h2>
      <button class="btn quiet" onclick={oncancel} aria-label="Cancel"><Icon name="x" size={14} /></button>
    </header>

    <div class="tools">
      {#each TOOLS as [t, label] (t)}
        <button class="btn quiet" class:on={tool === t} onclick={() => (tool = t)} aria-pressed={tool === t}>{label}</button>
      {/each}
      <span class="sep"></span>
      {#each COLORS as c (c)}
        <button class="swatch" class:on={color === c} style:background-color={c} onclick={() => (color = c)} aria-label="Colour {c}" aria-pressed={color === c}></button>
      {/each}
      <span class="sep"></span>
      <button class="btn quiet" onclick={() => shapes.pop()} disabled={!shapes.length}>Undo</button>
      <button class="btn quiet" onclick={() => (shapes = [])} disabled={!shapes.length}>Clear</button>
    </div>

    <canvas bind:this={canvas} onpointerdown={down} onpointermove={moveTo} onpointerup={up} onpointercancel={up}></canvas>

    <div class="form">
      <input class="field" placeholder="Short title, e.g. Names box overlaps the victory box" bind:value={title} maxlength="200" />
      <select class="field" bind:value={kind}>
        <option value="bug">Bug</option>
        <option value="polish">Polish</option>
        <option value="idea">Idea</option>
      </select>
    </div>
    <textarea class="field" rows="3" placeholder="Details (optional)" bind:value={body}></textarea>

    {#if err}<div class="s-failed small">{err}</div>{/if}
    <div class="foot">
      <span class="dim small">Goes to the Issues board. The lead triages it and hands it to the team.</span>
      <button class="btn" onclick={oncancel}>Cancel</button>
      <button class="btn go" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Raise issue'}</button>
    </div>
  </div>
</div>

<style>
  .wrap {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 32px 16px;
    overflow: auto;
  }
  .shade {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 14, 0.88);
    border: 0;
  }
  .box {
    position: relative;
    width: min(1100px, 100%);
    padding: 16px;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .cap {
    text-transform: capitalize;
  }
  .tools {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .tools .on {
    border-color: var(--accent);
    color: var(--ink);
    background: rgba(var(--glow), 0.16);
  }
  .sep {
    width: 1px;
    height: 24px;
    background: var(--line);
    margin: 0 4px;
  }
  .swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid var(--line);
    cursor: pointer;
    padding: 0;
  }
  .swatch.on {
    border-color: var(--ink-strong);
    box-shadow: 0 0 0 2px var(--accent);
  }
  canvas {
    /* Fit the screen so the form below stays in view; aspect ratio is kept. */
    display: block;
    align-self: center;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: calc(100vh - 330px);
    min-height: 200px;
    border: 1px solid var(--line);
    border-radius: 6px;
    cursor: crosshair;
    touch-action: none;
    image-rendering: pixelated;
    background: #000;
  }
  .form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }
  textarea {
    resize: vertical;
    font: inherit;
  }
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .foot .dim {
    flex: 1;
  }
  .go {
    border-color: var(--accent);
    background: rgba(var(--glow), 0.25);
  }
</style>
