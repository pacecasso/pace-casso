/**
 * Block raster — the city grid is the canvas.
 *
 * The image is cut into cells the size of real city blocks (anisotropic:
 * a Manhattan block is ~80 m between streets and ~270 m between avenues),
 * and the drawing is the boundary of the cells that carry ink. Curves and
 * diagonals come out as stairs along real streets; thin parts (a hose, a
 * headphone band) survive as one-cell corridors whose boundary is a doubled
 * line — retracing a street is invisible on a Strava trace and is how the
 * reference pieces draw their detail. Holes (a pump window) are kept as
 * their own loops.
 *
 * Pure geometry, no map access: lattice coordinates in, lattice loops out.
 * The caller maps lattice vertices onto real intersections and walks
 * between them.
 */

export type Cells = { cells: Uint8Array; cols: number; rows: number };
/** Lattice vertex: x in [0, cols], y in [0, rows]; y grows with image "up". */
export type LatticePt = [number, number];

export type RasterOptions = {
  /** ink coverage a cell needs to be "on" (fraction of its pixels) */
  threshold?: number;
  /**
   * A weaker cell (coverage >= thinThreshold) is turned on when it joins two
   * on-cells that are otherwise not 4-connected through it — keeps thin
   * strokes (hose, arm) from breaking into dashes at block resolution.
   */
  thinThreshold?: number;
  /**
   * Column / row breakpoints in [0,1] across the ink bbox (length cols+1 /
   * rows+1, ascending, first 0 and last 1). Lets uneven real blocks map to
   * uneven slices of the image so corners still land on real streets.
   * yBreaks run from the BOTTOM of the bbox upward.
   */
  xBreaks?: number[];
  yBreaks?: number[];
};

/**
 * Rasterize a pixel mask (255 = ink) onto cols x rows cells covering the
 * mask's ink bounding box. Cell (i, j) covers image columns
 * [x0 + i*cw, x0 + (i+1)*cw) and image rows counted from the BOTTOM of the
 * bbox so that j grows with "up".
 */
export function rasterizeMask(mask: Uint8Array, w: number, h: number, cols: number, rows: number, opts: RasterOptions = {}): Cells {
  const thr = opts.threshold ?? 0.3;
  const thin = opts.thinThreshold ?? 0.1;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 255) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cells = new Uint8Array(cols * rows);
  if (maxX < 0) return { cells, cols, rows };
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const cover = new Float64Array(cols * rows);
  const count = new Float64Array(cols * rows);
  const slot = (u: number, n: number, breaks?: number[]): number => {
    if (!breaks) return Math.min(n - 1, Math.floor(u * n));
    let k = 0;
    while (k < n - 1 && u >= breaks[k + 1]!) k++;
    return k;
  };
  for (let y = minY; y <= maxY; y++) {
    const j = slot((maxY - y + 0.5) / bh, rows, opts.yBreaks);
    for (let x = minX; x <= maxX; x++) {
      const i = slot((x - minX + 0.5) / bw, cols, opts.xBreaks);
      const k = j * cols + i;
      count[k]++;
      if (mask[y * w + x] === 255) cover[k]++;
    }
  }
  for (let k = 0; k < cols * rows; k++) cover[k] = count[k] ? cover[k]! / count[k]! : 0;
  for (let k = 0; k < cols * rows; k++) if (cover[k]! >= thr) cells[k] = 1;
  // bridge rule: a weak cell that connects two on-neighbours across it
  // (left-right or down-up) turns on, so a thin stroke stays continuous
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (cells[k]) continue;
        const L = i > 0 && cells[k - 1] === 1;
        const R = i < cols - 1 && cells[k + 1] === 1;
        const D = j > 0 && cells[k - cols] === 1;
        const U = j < rows - 1 && cells[k + cols] === 1;
        const straight = cover[k]! >= thin && ((L && R) || (D && U));
        // corner contact: two on-cells touching only at a corner of this
        // cell become 4-connected through it. Of the two cells that could
        // bridge them, the one with more ink wins (ties: lower index).
        let diag = false;
        if (!straight && cover[k]! >= thin) {
          const pairs: [boolean, boolean, number, number][] = [
            [L, D, i - 1, j - 1],
            [L, U, i - 1, j + 1],
            [R, D, i + 1, j - 1],
            [R, U, i + 1, j + 1],
          ];
          for (const [p, q, ai, aj] of pairs) {
            if (!p || !q) continue;
            const ak = aj * cols + ai;
            const altOn = ai >= 0 && aj >= 0 && ai < cols && aj < rows && cells[ak] === 1;
            if (altOn) continue;
            const altCover = ai >= 0 && aj >= 0 && ai < cols && aj < rows ? cover[ak]! : -1;
            if (cover[k]! > altCover || (cover[k] === altCover && k < ak)) diag = true;
          }
        }
        if (straight || diag) {
          cells[k] = 1;
          changed = true;
        }
      }
    }
  }
  return { cells, cols, rows };
}

/**
 * Boundary of the on-cell union as closed loops over lattice vertices.
 * Outer loops run counter-clockwise (ink on the left), holes clockwise.
 * Every boundary edge appears in exactly one loop. Loops are returned
 * without the repeated closing vertex.
 */
export function boundaryLoops({ cells, cols, rows }: Cells): LatticePt[][] {
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows && cells[j * cols + i] === 1;
  const vid = (x: number, y: number) => y * (cols + 1) + x;
  // directed edges keyed by start vertex
  const out = new Map<number, number[]>();
  const push = (x0: number, y0: number, x1: number, y1: number) => {
    const a = vid(x0, y0);
    if (!out.has(a)) out.set(a, []);
    out.get(a)!.push(vid(x1, y1));
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!on(i, j)) continue;
      if (!on(i, j - 1)) push(i, j, i + 1, j); // south edge, eastward
      if (!on(i + 1, j)) push(i + 1, j, i + 1, j + 1); // east edge, northward
      if (!on(i, j + 1)) push(i + 1, j + 1, i, j + 1); // north edge, westward
      if (!on(i - 1, j)) push(i, j + 1, i, j); // west edge, southward
    }
  }
  const loops: LatticePt[][] = [];
  const toPt = (v: number): LatticePt => [v % (cols + 1), Math.floor(v / (cols + 1))];
  for (const [start, edges] of out) {
    while (edges.length) {
      const loop: number[] = [start];
      let cur = start;
      let prev = -1;
      for (;;) {
        const opts = out.get(cur);
        if (!opts || !opts.length) break;
        // at a pinch vertex hug the ink: ink is on the left, so a LEFT
        // turn stays on this region's boundary and the two corner-touching
        // regions keep separate loops
        let pick = 0;
        if (opts.length > 1 && prev >= 0) {
          const [px, py] = toPt(prev);
          const [cx, cy] = toPt(cur);
          const dx = cx - px;
          const dy = cy - py;
          const leftX = cx - dy;
          const leftY = cy + dx;
          const li = opts.indexOf(vid(leftX, leftY));
          if (li >= 0) pick = li;
        }
        const next = opts.splice(pick, 1)[0]!;
        prev = cur;
        cur = next;
        if (cur === start) break;
        loop.push(cur);
      }
      if (loop.length >= 4) loops.push(loop.map(toPt));
    }
  }
  return loops.map(simplifyLoop);
}

/** Drop vertices that sit on a straight run between their neighbours. */
export function simplifyLoop(loop: LatticePt[]): LatticePt[] {
  if (loop.length < 4) return loop;
  const n = loop.length;
  const keep: LatticePt[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n]!;
    const b = loop[i]!;
    const c = loop[(i + 1) % n]!;
    const collinear = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) === 0;
    if (!collinear) keep.push(b);
  }
  return keep.length >= 4 ? keep : loop;
}

/** Total lattice edge length of a loop in cell units, weighted per axis. */
export function loopLength(loop: LatticePt[], pitchX: number, pitchY: number): number {
  let m = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    m += Math.abs(b[0] - a[0]) * pitchX + Math.abs(b[1] - a[1]) * pitchY;
  }
  return m;
}

/** Count of on cells and of 4-connected components (for diagnostics). */
export function cellStats({ cells, cols, rows }: Cells): { on: number; components: number } {
  let on = 0;
  const seen = new Uint8Array(cols * rows);
  let components = 0;
  for (let k = 0; k < cols * rows; k++) {
    if (!cells[k]) continue;
    on++;
    if (seen[k]) continue;
    components++;
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const i = c % cols;
      const j = (c / cols) | 0;
      const nb = [
        [i - 1, j],
        [i + 1, j],
        [i, j - 1],
        [i, j + 1],
      ];
      for (const [x, y] of nb) {
        if (x! < 0 || y! < 0 || x! >= cols || y! >= rows) continue;
        const kk = y! * cols + x!;
        if (cells[kk] && !seen[kk]) {
          seen[kk] = 1;
          stack.push(kk);
        }
      }
    }
  }
  return { on, components };
}
