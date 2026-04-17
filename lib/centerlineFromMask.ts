/**
 * Centerline from line-art ink: morphological gap-bridging (nearby strokes → one
 * region), Zhang–Suen thinning, then an Eulerian walk on the 1px skeleton graph
 * so T-junctions and letters are fully traversed (no greedy “one branch only”).
 */

const INK = 200;
/** 8-neighborhood closing iterations: bridges white gaps of a few pixels. */
const GAP_CLOSE_ITERS = 3;

function isInk(v: number): boolean {
  return v > INK;
}

function largestComponentOfBinary(
  bin: Uint8Array,
  w: number,
  h: number,
): Uint8Array | null {
  let any = false;
  for (let i = 0; i < bin.length; i++) {
    if (bin[i]) {
      any = true;
      break;
    }
  }
  if (!any) return null;

  const labels = new Int32Array(w * h);
  let next = 0;
  let bestLabel = 0;
  let bestCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bin[i] === 0 || labels[i] !== 0) continue;
      next++;
      let cnt = 0;
      const stack: number[] = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (labels[j] !== 0) continue;
        if (bin[j] === 0) continue;
        labels[j] = next;
        cnt++;
        const jx = j % w;
        const jy = (j / w) | 0;
        if (jx > 0) stack.push(j - 1);
        if (jx < w - 1) stack.push(j + 1);
        if (jy > 0) stack.push(j - w);
        if (jy < h - 1) stack.push(j + w);
      }
      if (cnt > bestCount) {
        bestCount = cnt;
        bestLabel = next;
      }
    }
  }

  if (bestLabel === 0) return null;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === bestLabel) out[i] = 1;
  }
  return out;
}

const DX8 = [0, 1, 1, 1, 0, -1, -1, -1];
const DY8 = [-1, -1, 0, 1, 1, 1, 0, -1];

function dilate8(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (src[i] === 0) {
        let hit = false;
        for (let k = 0; k < 8; k++) {
          const nx = x + DX8[k]!;
          const ny = y + DY8[k]!;
          if (src[ny * w + nx]) {
            hit = true;
            break;
          }
        }
        dst[i] = hit ? 1 : 0;
      } else {
        dst[i] = 1;
      }
    }
  }
  return dst;
}

function erode8(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (src[i] === 0) {
        dst[i] = 0;
        continue;
      }
      let ok = true;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k]!;
        const ny = y + DY8[k]!;
        if (src[ny * w + nx] === 0) {
          ok = false;
          break;
        }
      }
      dst[i] = ok ? 1 : 0;
    }
  }
  return dst;
}

/** 8-connected morphological closing: fills narrow white gaps between ink. */
function morphClose8(
  bin: Uint8Array,
  w: number,
  h: number,
  iterations: number,
): Uint8Array {
  let cur = new Uint8Array(bin);
  for (let t = 0; t < iterations; t++) {
    cur = new Uint8Array(dilate8(cur, w, h));
  }
  for (let t = 0; t < iterations; t++) {
    cur = new Uint8Array(erode8(cur, w, h));
  }
  return cur;
}

/**
 * Binarize → close small gaps → largest 4-connected component.
 * Export for Step1 so Moore/d3 use the same “one route unless well separated” mask.
 */
export function prepareTracedBinaryMask(
  lineMask: Uint8Array,
  w: number,
  h: number,
  gapCloseIterations = GAP_CLOSE_ITERS,
): Uint8Array | null {
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < lineMask.length; i++) {
    raw[i] = isInk(lineMask[i]) ? 1 : 0;
  }
  const closed = morphClose8(raw, w, h, gapCloseIterations);
  return largestComponentOfBinary(closed, w, h);
}

function zhangSuenNeighbors(
  img: Uint8Array,
  w: number,
  y: number,
  x: number,
): [number, number, number, number, number, number, number, number] {
  const i = y * w + x;
  const p2 = img[i - w] ? 1 : 0;
  const p3 = img[i - w + 1] ? 1 : 0;
  const p4 = img[i + 1] ? 1 : 0;
  const p5 = img[i + w + 1] ? 1 : 0;
  const p6 = img[i + w] ? 1 : 0;
  const p7 = img[i + w - 1] ? 1 : 0;
  const p8 = img[i - 1] ? 1 : 0;
  const p9 = img[i - w - 1] ? 1 : 0;
  return [p2, p3, p4, p5, p6, p7, p8, p9];
}

function zhangSuenTransitions(
  p2: number,
  p3: number,
  p4: number,
  p5: number,
  p6: number,
  p7: number,
  p8: number,
  p9: number,
): number {
  const s = [p2, p3, p4, p5, p6, p7, p8, p9];
  let a = 0;
  for (let k = 0; k < 8; k++) {
    if (s[k] === 0 && s[(k + 1) % 8] === 1) a++;
  }
  return a;
}

export function zhangSuenThinInPlace(img: Uint8Array, w: number, h: number): void {
  let changed = true;
  while (changed) {
    changed = false;
    const del1: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (img[i] === 0) continue;
        const [p2, p3, p4, p5, p6, p7, p8, p9] = zhangSuenNeighbors(img, w, y, x);
        const bp = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (bp < 2 || bp > 6) continue;
        if (zhangSuenTransitions(p2, p3, p4, p5, p6, p7, p8, p9) !== 1) continue;
        if (p2 * p4 * p6 !== 0) continue;
        if (p4 * p6 * p8 !== 0) continue;
        del1.push(i);
      }
    }
    for (const i of del1) {
      img[i] = 0;
      changed = true;
    }

    const del2: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (img[i] === 0) continue;
        const [p2, p3, p4, p5, p6, p7, p8, p9] = zhangSuenNeighbors(img, w, y, x);
        const bp = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (bp < 2 || bp > 6) continue;
        if (zhangSuenTransitions(p2, p3, p4, p5, p6, p7, p8, p9) !== 1) continue;
        if (p2 * p4 * p8 !== 0) continue;
        if (p2 * p6 * p8 !== 0) continue;
        del2.push(i);
      }
    }
    for (const i of del2) {
      img[i] = 0;
      changed = true;
    }
  }
}

function distanceToBackground4(bin: Uint8Array, w: number, h: number): Int32Array {
  const INF = 1_000_000;
  const dist = new Int32Array(w * h);
  const q: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bin[i] === 0) {
        dist[i] = 0;
        continue;
      }
      let boundary = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (!boundary) {
        if (
          bin[i - 1] === 0 ||
          bin[i + 1] === 0 ||
          bin[i - w] === 0 ||
          bin[i + w] === 0
        ) {
          boundary = true;
        }
      }
      if (boundary) {
        dist[i] = 1;
        q.push(i);
      } else {
        dist[i] = INF;
      }
    }
  }
  let qi = 0;
  while (qi < q.length) {
    const i = q[qi++]!;
    const d = dist[i]!;
    const nd = d + 1;
    const nbs = [i - 1, i + 1, i - w, i + w];
    for (const j of nbs) {
      if (j < 0 || j >= w * h) continue;
      if (bin[j] === 0) continue;
      if (dist[j]! > nd) {
        dist[j] = nd;
        q.push(j);
      }
    }
  }
  return dist;
}

function cloneAdj(adj: Map<number, number[]>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [k, vs] of adj) out.set(k, [...vs]);
  return out;
}

function addUndirectedEdge(adj: Map<number, number[]>, u: number, v: number): void {
  if (u === v) return;
  if (!adj.has(u)) adj.set(u, []);
  if (!adj.has(v)) adj.set(v, []);
  adj.get(u)!.push(v);
  adj.get(v)!.push(u);
}

function removeOneUndirectedEdge(adj: Map<number, number[]>, u: number, v: number): void {
  const lu = adj.get(u);
  const lv = adj.get(v);
  if (!lu || !lv) return;
  const iu = lu.indexOf(v);
  const iv = lv.indexOf(u);
  if (iu >= 0) lu.splice(iu, 1);
  if (iv >= 0) lv.splice(iv, 1);
}

function buildSkeletonAdjacency(
  skel: Uint8Array,
  w: number,
  h: number,
): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k]!;
        const ny = y + DY8[k]!;
        if (!skel[ny * w + nx]) continue;
        const j = ny * w + nx;
        if (j <= i) continue;
        addUndirectedEdge(adj, i, j);
      }
    }
  }
  return adj;
}

function collectOddVertices(adj: Map<number, number[]>): number[] {
  const odds: number[] = [];
  for (const [v, ns] of adj) {
    if (ns.length % 2 === 1) odds.push(v);
  }
  odds.sort((a, b) => a - b);
  return odds;
}

function bfsSkeletonPath(
  skel: Uint8Array,
  w: number,
  h: number,
  src: number,
  dst: number,
): number[] | null {
  if (src === dst) return [src];
  const prev = new Int32Array(w * h);
  prev.fill(-1);
  const q: number[] = [src];
  prev[src] = src;
  let qi = 0;
  while (qi < q.length) {
    const i = q[qi++]!;
    if (i === dst) break;
    const x = i % w;
    const y = (i / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k]!;
      const ny = y + DY8[k]!;
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
      const ni = ny * w + nx;
      if (!skel[ni] || prev[ni] >= 0) continue;
      prev[ni] = i;
      q.push(ni);
    }
  }
  if (prev[dst] < 0) return null;
  const path: number[] = [];
  let cur = dst;
  while (true) {
    path.push(cur);
    if (cur === src) break;
    cur = prev[cur]!;
  }
  path.reverse();
  return path;
}

/** Duplicate each edge along a vertex path (multigraph). */
function duplicatePathEdges(adj: Map<number, number[]>, path: number[]): void {
  for (let t = 0; t + 1 < path.length; t++) {
    const a = path[t]!;
    const b = path[t + 1]!;
    addUndirectedEdge(adj, a, b);
  }
}

function reduceOddVerticesWithGreedyPairing(
  adj: Map<number, number[]>,
  skel: Uint8Array,
  w: number,
  h: number,
): void {
  for (let guard = 0; guard < 4096; guard++) {
    const odds = collectOddVertices(adj);
    if (odds.length <= 2) return;
    const o0 = odds[0]!;
    let bestPath: number[] | null = null;
    for (let k = 1; k < odds.length; k++) {
      const p = bfsSkeletonPath(skel, w, h, o0, odds[k]!);
      if (!p) continue;
      if (!bestPath || p.length < bestPath.length) bestPath = p;
    }
    if (!bestPath || bestPath.length < 2) return;
    duplicatePathEdges(adj, bestPath);
  }
}

function collapseConsecutiveDupes(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/**
 * Hierholzer Eulerian trail / circuit on undirected multigraph `adj`.
 * Pre: 0 or 2 odd-degree vertices. Mutates `adj` (consumes edges).
 */
function hierholzerVertexSequence(
  adj: Map<number, number[]>,
  start: number,
): number[] {
  const stack: number[] = [start];
  const circuit: number[] = [];
  while (stack.length) {
    const v = stack[stack.length - 1]!;
    const nbs = adj.get(v);
    if (!nbs || nbs.length === 0) {
      circuit.push(v);
      stack.pop();
    } else {
      const u = nbs.pop()!;
      removeOneUndirectedEdge(adj, u, v);
      stack.push(u);
    }
  }
  circuit.reverse();
  return circuit;
}

function largestSkelComponent(img: Uint8Array, w: number, h: number): Uint8Array {
  const labels = new Int32Array(w * h);
  let next = 0;
  let bestLabel = 0;
  let bestCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (img[i] === 0 || labels[i] !== 0) continue;
      next++;
      let cnt = 0;
      const stack: number[] = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (labels[j] !== 0) continue;
        if (img[j] === 0) continue;
        labels[j] = next;
        cnt++;
        const jx = j % w;
        const jy = (j / w) | 0;
        for (let k = 0; k < 8; k++) {
          const nx = jx + DX8[k]!;
          const ny = jy + DY8[k]!;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nj = ny * w + nx;
          if (img[nj] && labels[nj] === 0) stack.push(nj);
        }
      }
      if (cnt > bestCount) {
        bestCount = cnt;
        bestLabel = next;
      }
    }
  }

  const out = new Uint8Array(w * h);
  if (bestLabel === 0) return out;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === bestLabel) out[i] = 1;
  }
  return out;
}

function eulerianSkeletonPolyline(
  skel: Uint8Array,
  dt: Int32Array,
  w: number,
  h: number,
): [number, number][] | null {
  let total = 0;
  let firstIdx = -1;
  for (let i = 0; i < skel.length; i++) {
    if (skel[i]) {
      total++;
      if (firstIdx < 0) firstIdx = i;
    }
  }
  if (total < 2 || firstIdx < 0) return null;

  const adj = buildSkeletonAdjacency(skel, w, h);
  if (adj.size === 0) return null;

  reduceOddVerticesWithGreedyPairing(adj, skel, w, h);

  const odds = collectOddVertices(adj);
  let start = firstIdx;
  if (odds.length === 2) {
    start = odds[0]!;
  } else if (odds.length !== 0) {
    return null;
  } else {
    let best = start;
    let bestDt = dt[start] ?? 0;
    for (const v of adj.keys()) {
      const d = dt[v] ?? 0;
      if (d > bestDt) {
        bestDt = d;
        best = v;
      }
    }
    start = best;
  }

  const adjW = cloneAdj(adj);
  if ((adjW.get(start)?.length ?? 0) === 0 && odds.length === 2) {
    start = odds[1]!;
  }
  const verts = hierholzerVertexSequence(adjW, start);
  if (verts.length < 2) return null;

  let pts: [number, number][] = verts.map((idx) => {
    const x = idx % w;
    const y = (idx / w) | 0;
    return [x + 0.5, y + 0.5];
  });
  pts = collapseConsecutiveDupes(pts);
  if (pts.length < 2) return null;

  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const closed =
    Math.hypot(a[0] - b[0], a[1] - b[1]) < 2.5 && pts.length > 3;
  if (closed && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) {
    return pts;
  }
  if (closed && pts.length > 3) {
    pts.push([a[0], a[1]]);
  }
  return pts;
}

/**
 * Prepared binary (0/1) → centerline in image coordinates (pixel centers).
 */
export function centerlinePolylineFromPreparedBinary(
  comp: Uint8Array,
  w: number,
  h: number,
): [number, number][] | null {
  const pw = w + 2;
  const ph = h + 2;
  const padded = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (comp[y * w + x]) padded[(y + 1) * pw + (x + 1)] = 1;
    }
  }

  const dt = distanceToBackground4(padded, pw, ph);
  const work = new Uint8Array(padded);
  zhangSuenThinInPlace(work, pw, ph);

  let skelCount = 0;
  for (let i = 0; i < work.length; i++) {
    if (work[i]) skelCount++;
  }
  if (skelCount < 2) return null;

  const skel = largestSkelComponent(work, pw, ph);
  const pathPad = eulerianSkeletonPolyline(skel, dt, pw, ph);
  if (!pathPad) return null;
  return pathPad.map(([x, y]) => [x - 1, y - 1]);
}

export function centerlinePolylineFromLineMask(
  lineMask: Uint8Array,
  w: number,
  h: number,
): [number, number][] | null {
  const comp = prepareTracedBinaryMask(lineMask, w, h);
  if (!comp) return null;
  return centerlinePolylineFromPreparedBinary(comp, w, h);
}
