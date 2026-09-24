/**
 * BLOCK PLAN — turn an upload's mask into the drawing a street grid can
 * actually carry: blocky outlines for solid mass, single centre lines for the
 * thin features blocks would swallow.
 *
 * This is the plan step behind the Sep 23 routes (heart 14.9 km, Strava
 * 29.5 km, cat 61.1 km, zero connectors), ported from the offline rig
 * (scripts/perceptual/blockplan.py). Three rules earned their place there:
 *
 *  1. Quantise mass onto the CITY'S BLOCK GRID before drawing. Cells are
 *     anisotropic (~270 m between avenues, ~80 m between streets), so every
 *     outline edge lands on a straight street run instead of a staircase.
 *  2. A thin feature INSIDE a shape (the gas hose) or a thin GAP between two
 *     parts of one shape (the Stones tongue against the lip, the space inside
 *     Chanel's C) is narrower than one cell. Cut the mass along those gaps and
 *     outline each part, and draw thin ink as its own centre line.
 *  3. An outline DRAWING (Ralph's cat) has no solid mass at all — detect it by
 *     mean ink thickness and draw its centre lines; blockifying it shatters it
 *     into fragments.
 *
 * Output is `Stroke[]` in the same unit space as makePlan, so routePlacement,
 * the stroke editor and /api/stroke-route all take it unchanged.
 */
import type { Stroke, UnitPt } from "./strokePainter";

export type BlockPlanOptions = {
  /** cells across the drawing (more cells = bigger drawing, finer features) */
  cols?: number;
  /** cell rows per column: NYC blocks are about 3x shorter than they are wide */
  aspect?: number;
  /** ink this thin (as a fraction of the drawing's span) is a line, not a mass */
  thinFrac?: number;
  /** a cell counts as inked above this coverage */
  fill?: number;
  /** drop centre lines shorter than this fraction of the span */
  minLenFrac?: number;
  /** drop a mass part smaller than this fraction of all mass */
  minPartFrac?: number;
};

export type BlockPlanResult = {
  strokes: Stroke[];
  /** true when the upload was an outline drawing and was drawn as centre lines */
  lineArt: boolean;
  parts: number;
  centrelines: number;
};

const ON = 255;

function bbox(mask: Uint8Array, w: number, h: number) {
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== ON) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

export function erodeMask(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let keep = true;
      for (let dy = -r; dy <= r && keep; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || m[ny * w + nx] !== ON) {
            keep = false;
            break;
          }
        }
      }
      if (keep) out[y * w + x] = ON;
    }
  }
  return out;
}

export function dilateMask(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m[y * w + x] !== ON) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = ON;
        }
      }
    }
  }
  return out;
}

/** 4-connected components of an ON mask, as pixel index lists */
export function maskComponents(m: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(w * h);
  const out: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (m[start] !== ON || seen[start]) continue;
    const comp: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && m[p - 1] === ON && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && m[p + 1] === ON && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && m[p - w] === ON && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && m[p + w] === ON && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    out.push(comp);
  }
  return out;
}

/** everything not reachable from the border is inside the shape */
export function filledMask(m: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (m[p] !== ON && !outside[p]) { outside[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (m[i] === ON || !outside[i]) out[i] = ON;
  return out;
}

/**
 * Rectilinear rings around a binary CELL grid, walked along cell edges.
 * Returns rings in cell coordinates (corner units), each closed, with only
 * real corners kept — so a routed edge is one long straight street run.
 */
export function cellRings(cells: Uint8Array, cw: number, ch: number): [number, number][][] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < cw && y < ch && cells[y * cw + x] === 1;
  // directed boundary edges, kept so the inked cell is on the left
  const edges = new Map<string, [number, number]>();
  const key = (x: number, y: number) => `${x},${y}`;
  const add = (ax: number, ay: number, bx: number, by: number) => edges.set(key(ax, ay) + ">" + key(bx, by), [bx, by]);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y);
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!on(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const rings: [number, number][][] = [];
  while (edges.size) {
    const first = edges.keys().next().value as string;
    const [fromStr] = first.split(">");
    const start = fromStr!.split(",").map(Number) as [number, number];
    const ring: [number, number][] = [start];
    let cur = start;
    for (let guard = 0; guard < 100000; guard++) {
      let nextKey: string | null = null;
      for (const k of edges.keys()) {
        if (k.startsWith(key(cur[0], cur[1]) + ">")) { nextKey = k; break; }
      }
      if (!nextKey) break;
      const nxt = edges.get(nextKey)!;
      edges.delete(nextKey);
      cur = [nxt[0], nxt[1]];
      if (cur[0] === start[0] && cur[1] === start[1]) break;
      ring.push(cur);
    }
    if (ring.length >= 4) rings.push(ring);
  }
  // keep corners only
  return rings.map((ring) => {
    const out: [number, number][] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i - 1 + ring.length) % ring.length]!;
      const b = ring[i]!;
      const c = ring[(i + 1) % ring.length]!;
      const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (turn !== 0) out.push(b);
    }
    return out.length >= 3 ? out : ring;
  });
}

/** thin a mask to 1-px centre lines (Zhang-Suen), then walk them into polylines */
function centrelines(m: Uint8Array, w: number, h: number, minLenPx: number): [number, number][][] {
  const img = m.slice();
  zhangSuen(img, w, h);
  const isOn = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && img[y * w + x] === ON;
  const nbrs = (x: number, y: number) => {
    const out: [number, number][] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && isOn(x + dx, y + dy)) out.push([x + dx, y + dy]);
    }
    return out;
  };
  const used = new Uint8Array(w * h);
  const lines: [number, number][][] = [];
  const starts: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (isOn(x, y) && nbrs(x, y).length === 1) starts.push([x, y]);
  }
  for (let y = 0; y < h && starts.length === 0; y++) for (let x = 0; x < w; x++) {
    if (isOn(x, y)) { starts.push([x, y]); break; }
  }
  for (const s of starts) {
    if (used[s[1] * w + s[0]]) continue;
    const line: [number, number][] = [s];
    used[s[1] * w + s[0]] = 1;
    let cur = s;
    for (let guard = 0; guard < w * h; guard++) {
      const next = nbrs(cur[0], cur[1]).filter((p) => !used[p[1] * w + p[0]]);
      if (!next.length) break;
      next.sort((a, b) => (Math.abs(a[0] - cur[0]) + Math.abs(a[1] - cur[1])) - (Math.abs(b[0] - cur[0]) + Math.abs(b[1] - cur[1])));
      cur = next[0]!;
      used[cur[1] * w + cur[0]] = 1;
      line.push(cur);
    }
    let len = 0;
    for (let i = 1; i < line.length; i++) len += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
    if (len >= minLenPx) lines.push(line);
  }
  return lines;
}

/** Zhang-Suen thinning (kept local so this file has no import cycle) */
function zhangSuen(img: Uint8Array, w: number, h: number): void {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x] === ON ? 1 : 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      const del: number[] = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!at(x, y)) continue;
          const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
          const b = p.reduce((a, v) => a + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) if (p[i] === 0 && p[(i + 1) % 8] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p[0] * p[2] * p[4] !== 0) continue;
            if (p[2] * p[4] * p[6] !== 0) continue;
          } else {
            if (p[0] * p[2] * p[6] !== 0) continue;
            if (p[0] * p[4] * p[6] !== 0) continue;
          }
          del.push(y * w + x);
        }
      }
      for (const i of del) img[i] = 0;
      if (del.length) changed = true;
    }
  }
}

function simplify(points: [number, number][], eps: number): [number, number][] {
  if (points.length < 3) return points;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const norm = Math.hypot(ux, uy) || 1e-9;
  let far = 0;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const d = Math.abs(ux * (a[1] - p[1]) - uy * (a[0] - p[0])) / norm;
    if (d > far) { far = d; idx = i; }
  }
  if (far <= eps) return [a, b];
  return [...simplify(points.slice(0, idx + 1), eps).slice(0, -1), ...simplify(points.slice(idx), eps)];
}

export function blockPlan(
  mask: Uint8Array,
  w: number,
  h: number,
  options: BlockPlanOptions = {},
): BlockPlanResult {
  const cols = Math.max(4, options.cols ?? 28);
  const aspect = options.aspect ?? 3;
  const thinFrac = options.thinFrac ?? 0.025;
  const fill = options.fill ?? 0.34;
  const minLenFrac = options.minLenFrac ?? 0.08;
  const minPartFrac = options.minPartFrac ?? 0.04;

  const { minX, maxX, minY, maxY } = bbox(mask, w, h);
  if (maxX < minX) return { strokes: [], lineArt: false, parts: 0, centrelines: 0 };
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toUnit = (x: number, y: number): UnitPt => [((x - cx) * 2) / span, ((cy - y) * 2) / span];

  // mean ink thickness = area / centre-line length: an outline drawing is thin
  // everywhere, and must never be blockified (it shatters into fragments).
  let inkPx = 0;
  for (let i = 0; i < w * h; i++) if (mask[i] === ON) inkPx++;
  const skel = mask.slice();
  zhangSuen(skel, w, h);
  let skelPx = 0;
  for (let i = 0; i < w * h; i++) if (skel[i] === ON) skelPx++;
  const thickness = inkPx / Math.max(1, skelPx);
  // floor of 3 px: on a small mask `thinFrac * span` can fall under one
  // stroke width, and a 2 px outline is still an outline drawing
  const lineArt = thickness < Math.max(3, thinFrac * span);

  const strokes: Stroke[] = [];
  const thinRadius = Math.max(1, Math.round((thinFrac * span) / 2));
  const mass = lineArt ? new Uint8Array(w * h) : dilateMask(erodeMask(mask, w, h, thinRadius), w, h, thinRadius);

  // thin ink (the gas hose) and thin GAPS (the Stones crease) both become
  // centre lines; gaps additionally cut the mass into separate parts
  const filled = filledMask(mask, w, h);
  const gap = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (filled[i] === ON && mask[i] !== ON) gap[i] = ON;
  const gapOpen = dilateMask(erodeMask(gap, w, h, thinRadius + 1), w, h, thinRadius + 1);
  const gapThin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (gap[i] === ON && gapOpen[i] !== ON) gapThin[i] = ON;

  const massGrown = dilateMask(mass, w, h, 1);
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if ((mask[i] === ON && massGrown[i] !== ON) || gapThin[i] === ON) thin[i] = ON;
  }

  // ---- mass, cut along thin gaps, one blocky outline per part
  const rows = Math.max(4, Math.round(cols * aspect));
  const cutGap = dilateMask(gapThin, w, h, 2);
  const cut = new Uint8Array(w * h);
  let massPx = 0;
  for (let i = 0; i < w * h; i++) {
    if (mass[i] === ON) massPx++;
    if (mass[i] === ON && cutGap[i] !== ON) cut[i] = ON;
  }
  let partList = maskComponents(cut, w, h).filter((c) => c.length >= minPartFrac * Math.max(1, massPx));
  if (partList.length < 2 && massPx > 0) {
    // nothing was separated by a gap: draw the mass as one part
    const all = maskComponents(mass, w, h).flat();
    partList = all.length ? [all] : [];
  }

  let parts = 0;
  for (const comp of partList) {
    if (!comp.length) continue;
    const part = new Uint8Array(w * h);
    for (const p of comp) part[p] = ON;
    // area-average the part onto the block grid
    const cells = new Uint8Array(cols * rows);
    const x0 = minX;
    const y0 = minY;
    const cellW = (maxX - minX + 1) / cols;
    const cellH = (maxY - minY + 1) / rows;
    for (let cyi = 0; cyi < rows; cyi++) {
      for (let cxi = 0; cxi < cols; cxi++) {
        let inside = 0;
        let total = 0;
        const px0 = Math.floor(x0 + cxi * cellW);
        const px1 = Math.max(px0 + 1, Math.floor(x0 + (cxi + 1) * cellW));
        const py0 = Math.floor(y0 + cyi * cellH);
        const py1 = Math.max(py0 + 1, Math.floor(y0 + (cyi + 1) * cellH));
        for (let y = py0; y < py1; y++) {
          for (let x = px0; x < px1; x++) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            total++;
            if (part[y * w + x] === ON) inside++;
          }
        }
        if (total && inside / total > fill) cells[cyi * cols + cxi] = 1;
      }
    }
    let filledCells = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i]) filledCells++;
    if (filledCells < 2) continue;
    for (const ring of cellRings(cells, cols, rows)) {
      const pts: UnitPt[] = ring.map(([gx, gy]) => toUnit(x0 + gx * cellW, y0 + gy * cellH));
      if (pts.length >= 3) {
        strokes.push({ kind: "outline", pts, closed: true, group: parts });
      }
    }
    parts++;
  }

  // ---- centre lines for thin ink and gaps
  const lines = centrelines(lineArt ? mask : thin, w, h, minLenFrac * span);
  for (const line of lines) {
    const eps = Math.max(1.5, span * 0.01);
    const simple = simplify(line, eps);
    if (simple.length < 2) continue;
    strokes.push({ kind: "thin", pts: simple.map(([x, y]) => toUnit(x, y)), closed: false });
  }

  return { strokes, lineArt, parts, centrelines: lines.length };
}
