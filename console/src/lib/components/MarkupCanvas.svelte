<script>
  // Draw on a picture (box, ellipse, freehand). Shapes are kept in 0..1
  // coordinates so they fit any size of the image. `flatten()` returns the
  // picture with the drawing on it as a PNG blob (null when nothing is drawn),
  // `picture()` the picture alone as a PNG blob.
  let { src, shapes = $bindable([]), maxHeight = 'calc(100vh - 330px)' } = $props();

  const TOOLS = [
    ['rect', 'Box'],
    ['ellipse', 'Ellipse'],
    ['path', 'Freehand']
  ];
  const COLORS = ['#ff3b3b', '#fbbf24', '#4ade80', '#4fd8ff', '#ffffff'];

  let tool = $state('ellipse');
  let color = $state(COLORS[0]);
  let draft = $state(null);
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
    // Draw at least ~1280 px wide so lines stay crisp on small pixel-art shots,
    // and at most ~2560 px so a phone photo does not make a huge PNG.
    const scale = Math.min(Math.max(1, Math.ceil(1280 / img.naturalWidth)), Math.max(0.1, 2560 / img.naturalWidth));
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    paint(canvas.getContext('2d'), draft ? [...shapes, draft] : shapes);
  });

  const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

  /** The picture with the drawing, or null when nothing is drawn. */
  export async function flatten() {
    if (!img || !shapes.length) return null;
    paint(canvas.getContext('2d'), shapes);
    return toBlob(canvas);
  }

  /** The picture alone as a PNG, at its own size (at most 2560 px wide). */
  export async function picture() {
    if (!img) return null;
    const c = document.createElement('canvas');
    const s = Math.min(1, 2560 / img.naturalWidth);
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = s === 1 ? false : true;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return toBlob(c);
  }

  export function undo() {
    shapes.pop();
  }
</script>

<div class="tools">
  {#each TOOLS as [t, label] (t)}
    <button type="button" class="btn quiet" class:on={tool === t} onclick={() => (tool = t)} aria-pressed={tool === t}>{label}</button>
  {/each}
  <span class="sep"></span>
  {#each COLORS as c (c)}
    <button type="button" class="swatch" class:on={color === c} style:background-color={c} onclick={() => (color = c)} aria-label="Colour {c}" aria-pressed={color === c}></button>
  {/each}
  <span class="sep"></span>
  <button type="button" class="btn quiet" onclick={() => shapes.pop()} disabled={!shapes.length}>Undo</button>
  <button type="button" class="btn quiet" onclick={() => (shapes = [])} disabled={!shapes.length}>Clear</button>
</div>

<canvas bind:this={canvas} style:max-height={maxHeight} onpointerdown={down} onpointermove={moveTo} onpointerup={up} onpointercancel={up}></canvas>

<style>
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
    min-height: 200px;
    border: 1px solid var(--line);
    border-radius: 6px;
    cursor: crosshair;
    touch-action: none;
    image-rendering: pixelated;
    background: #000;
  }
</style>
