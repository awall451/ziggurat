// Positions for the agent tree: the lead on top, each tier below it, children
// centred under their parent. Pure function, no DOM.

const SIZE = [
  { w: 236, h: 88 }, // lead tile
  { w: 172, h: 82 }, // area lead tile
  { w: 64, h: 64 } // builder / scout circle (label sits under it)
];
const SLOT = [260, 190, 108]; // horizontal room a childless node takes
const TIER_Y = [72, 262, 452];
const TIER_STEP = 170;
const LABEL_H = 46; // room under a circle for its two-line label
const BAND_PAD = 30;
const BAND_STEP = 64; // each terrace is at least this much wider per side than the one above

const sizeOf = (d) => SIZE[Math.min(d, 2)];
const yOf = (d) => (d <= 2 ? TIER_Y[d] : TIER_Y[2] + (d - 2) * TIER_STEP);

/**
 * @param {{id:string,parent:string|null,depth:number,status:string}[]} nodes
 * @returns {{nodes:object[], edges:object[], bands:object[], width:number, height:number}}
 */
export function layoutTree(nodes) {
  if (!nodes.length) return { nodes: [], edges: [], bands: [], width: 0, height: 0 };
  const kids = new Map();
  for (const n of nodes) {
    if (n.parent == null) continue;
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }
  const pos = new Map();

  // Returns the width the subtree takes; assigns x to every node in it.
  function place(n, left) {
    const own = SLOT[Math.min(n.depth, 2)];
    const children = kids.get(n.id) || [];
    if (!children.length) {
      pos.set(n.id, { x: left + own / 2 });
      return own;
    }
    let cursor = left;
    for (const c of children) cursor += place(c, cursor);
    let width = cursor - left;
    if (width < own) {
      // Children are narrower than the parent: centre them under it.
      shift(children, (own - width) / 2);
      width = own;
    }
    const first = pos.get(children[0].id).x;
    const last = pos.get(children[children.length - 1].id).x;
    pos.set(n.id, { x: (first + last) / 2 });
    return width;
  }

  function shift(list, dx) {
    for (const c of list) {
      pos.get(c.id).x += dx;
      shift(kids.get(c.id) || [], dx);
    }
  }

  const roots = nodes.filter((n) => n.parent == null);
  let cursor = 0;
  for (const r of roots) cursor += place(r, cursor);

  const placed = nodes
    .filter((n) => pos.has(n.id))
    .map((n) => {
      const s = sizeOf(n.depth);
      return { ...n, x: pos.get(n.id).x, y: yOf(n.depth), w: s.w, h: s.h };
    });

  // Terrace bands: one per tier, each wider than the one above (the ziggurat).
  const byDepth = new Map();
  for (const n of placed) {
    const b = byDepth.get(n.depth) || { left: Infinity, right: -Infinity };
    b.left = Math.min(b.left, n.x - n.w / 2);
    b.right = Math.max(b.right, n.x + n.w / 2);
    byDepth.set(n.depth, b);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const centre = placed.find((n) => n.depth === 0)?.x ?? cursor / 2;
  const bands = [];
  let prevHalf = 0;
  for (const d of depths) {
    const b = byDepth.get(d);
    // Symmetric around the lead so the silhouette reads as a stepped pyramid.
    let half = Math.max(centre - b.left, b.right - centre) + BAND_PAD + (d === 0 ? 40 : 0);
    if (bands.length) half = Math.max(half, prevHalf + BAND_STEP);
    prevHalf = half;
    const s = sizeOf(d);
    bands.push({
      depth: d,
      x: centre - half,
      y: yOf(d) - 34,
      w: half * 2,
      h: s.h + 64 + (d >= 2 ? LABEL_H : 0)
    });
  }

  // Move everything so the widest band starts at a small left margin.
  const minX = Math.min(...bands.map((b) => b.x), ...placed.map((n) => n.x - n.w / 2));
  const dx = 24 - minX;
  for (const n of placed) n.x += dx;
  for (const b of bands) b.x += dx;

  const byId = new Map(placed.map((n) => [n.id, n]));
  const edges = [];
  for (const n of placed) {
    const p = n.parent != null ? byId.get(n.parent) : null;
    if (!p) continue;
    const x1 = p.x;
    const y1 = p.y + p.h;
    const x2 = n.x;
    const y2 = n.y;
    const my = (y1 + y2) / 2;
    edges.push({
      id: `${p.id}>${n.id}`,
      to: n.id,
      status: n.status,
      x1,
      y1,
      x2,
      y2,
      d: x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`
    });
  }

  const width = Math.max(...bands.map((b) => b.x + b.w), ...placed.map((n) => n.x + n.w / 2)) + 24;
  const last = bands[bands.length - 1];
  const height = last.y + last.h + 24;
  return { nodes: placed, edges, bands, width, height };
}
