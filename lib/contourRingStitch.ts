/**
 * When d3-contour returns a large outer ring plus a smaller inner ring that
 * encloses a letter hole (counter), merge them into one closed polyline by
 * inserting short bridge segments at the closest pair of points. This matches
 * how runners want one GPS path that visits both the outer silhouette and the
 * inner bowl edge.
 */

function ringAreaAbs(ring: [number, number][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % n]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

export function ringCentroid(ring: [number, number][]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  const n = ring.length || 1;
  return [sx / n, sy / n];
}

/** Even-odd ray test; ring is treated as closed polygon (first vertex repeated ok). */
export function pointInRingPolygon(
  pt: [number, number],
  ring: [number, number][],
): boolean {
  const [x, y] = pt;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Median min distance from sampled points on `a` to any vertex on `b`. */
export function medianMinDistBetweenRings(
  a: [number, number][],
  b: [number, number][],
): number {
  const step = Math.max(1, Math.floor(a.length / 100));
  const ds: number[] = [];
  for (let i = 0; i < a.length; i += step) {
    const p = a[i]!;
    let md = Infinity;
    for (let j = 0; j < b.length; j++) {
      const q = b[j]!;
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < md) md = d;
    }
    ds.push(md);
  }
  if (!ds.length) return Infinity;
  ds.sort((x, y) => x - y);
  return ds[Math.floor(ds.length / 2)]!;
}

function innerCentroidInOuterBBox(
  inner: [number, number][],
  outer: [number, number][],
): boolean {
  let minOx = Infinity;
  let maxOx = -Infinity;
  let minOy = Infinity;
  let maxOy = -Infinity;
  for (const [x, y] of outer) {
    if (x < minOx) minOx = x;
    if (x > maxOx) maxOx = x;
    if (y < minOy) minOy = y;
    if (y > maxOy) maxOy = y;
  }
  const [cx, cy] = ringCentroid(inner);
  return (
    cx > minOx + 1.5 &&
    cx < maxOx - 1.5 &&
    cy > minOy + 1.5 &&
    cy < maxOy - 1.5
  );
}

export function isLikelyNestedHoleRing(
  outer: [number, number][],
  inner: [number, number][],
): boolean {
  const ao = ringAreaAbs(outer);
  const ai = ringAreaAbs(inner);
  if (ao < 120 || ai < 20) return false;
  const ratio = ai / ao;
  if (ratio > 0.52 || ratio < 0.0002) return false;
  const c = ringCentroid(inner);
  const insidePoly = pointInRingPolygon(c, outer);
  const insideBBox = innerCentroidInOuterBBox(inner, outer);
  if (!insidePoly && !insideBBox) return false;
  const med = medianMinDistBetweenRings(outer, inner);
  if (med < 2.2) return false;
  return true;
}

function interp(
  p: [number, number],
  q: [number, number],
  steps: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let t = 1; t < steps; t++) {
    const f = t / steps;
    out.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]);
  }
  return out;
}

/**
 * One closed polyline: full outer loop, micro-bridge to inner, full inner
 * loop, micro-bridge back to outer start seam.
 */
export function weaveInnerRingIntoOuter(
  outer: [number, number][],
  inner: [number, number][],
  microSteps = 7,
): [number, number][] {
  const stO = Math.max(1, Math.floor(outer.length / 180));
  const stI = Math.max(1, Math.floor(inner.length / 180));
  let best = Infinity;
  let io = 0;
  let ii = 0;
  for (let a = 0; a < outer.length; a += stO) {
    for (let b = 0; b < inner.length; b += stI) {
      const d = Math.hypot(outer[a]![0] - inner[b]![0], outer[a]![1] - inner[b]![1]);
      if (d < best) {
        best = d;
        io = a;
        ii = b;
      }
    }
  }
  const po = outer[io]!;
  const pi = inner[ii]!;

  const out: [number, number][] = [];
  for (let k = 0; k < outer.length; k++) {
    out.push(outer[(io + k) % outer.length]!);
  }
  out.push(...interp(po, pi, microSteps));
  for (let k = 0; k < inner.length; k++) {
    out.push(inner[(ii + k) % inner.length]!);
  }
  out.push(...interp(pi, po, microSteps));
  return out;
}

/**
 * If rings[1] is a nested hole contour relative to rings[0], replace them with
 * a single stitched ring. Repeats while the pattern holds (outer grows).
 */
export function stitchNestedHoleRingsInPlace(
  rings: [number, number][][],
): void {
  while (rings.length >= 2) {
    const outer = rings[0]!;
    const inner = rings[1]!;
    if (!isLikelyNestedHoleRing(outer, inner)) break;
    rings[0] = weaveInnerRingIntoOuter(outer, inner);
    rings.splice(1, 1);
  }
}
