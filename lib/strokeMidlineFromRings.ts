/** Shoelace area (pixel²). */
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

function ringPerimeter(ring: [number, number][]): number {
  const n = ring.length;
  if (n < 2) return 0;
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

function ringCentroid(ring: [number, number][]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  const n = ring.length || 1;
  return [sx / n, sy / n];
}

/** Ray-cast point in polygon (closed ring). */
function pointInRing(pt: [number, number], ring: [number, number][]): boolean {
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

function resampleRingClosed(
  ring: [number, number][],
  target: number,
): [number, number][] {
  const n = ring.length;
  if (n < 3 || target < 3) return ring.slice() as [number, number][];
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segLen.push(len);
    total += len;
  }
  if (total < 1e-6) return ring.slice(0, 3) as [number, number][];

  const out: [number, number][] = [];
  for (let k = 0; k < target; k++) {
    let d = (k / target) * total;
    for (let i = 0; i < n; i++) {
      const len = segLen[i]!;
      if (d <= len || i === n - 1) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        const f = len < 1e-8 ? 0 : d / len;
        out.push([
          a[0] + f * (b[0] - a[0]),
          a[1] + f * (b[1] - a[1]),
        ]);
        break;
      }
      d -= len;
    }
  }
  return out;
}

function meanDistSq(
  a: [number, number][],
  b: [number, number][],
  shift: number,
): number {
  const n = a.length;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = a[i]!;
    const q = b[(i + shift) % n]!;
    const dx = p[0] - q[0];
    const dy = p[1] - q[1];
    s += dx * dx + dy * dy;
  }
  return s / n;
}

/**
 * Two closed contours from a blurred outline stroke often look like parallel
 * curves with similar perimeter (outer vs inner edge of the pen stroke).
 * This is different from a letter hole (counter), where the inner loop is
 * much shorter than the outer silhouette.
 */
export function likelyStrokeSandwichRings(
  outer: [number, number][],
  inner: [number, number][],
): boolean {
  const po = ringPerimeter(outer);
  const pi = ringPerimeter(inner);
  if (po < 40 || pi < 40) return false;
  const ratio = pi / po;
  if (ratio < 0.82 || ratio > 1.05) return false;

  const ao = ringAreaAbs(outer);
  const ai = ringAreaAbs(inner);
  if (ao < 200 || ai < 80) return false;
  if (ai >= ao * 0.92) return false;

  const cInner = ringCentroid(inner);
  if (!pointInRing(cInner, outer)) return false;

  return true;
}

export function mergeStrokeMidlineRing(
  outer: [number, number][],
  inner: [number, number][],
  samples: number,
): [number, number][] {
  const a = resampleRingClosed(outer, samples);
  const b = resampleRingClosed(inner, samples);
  let best = 0;
  let bestScore = Infinity;
  const step = Math.max(1, Math.floor(samples / 96));
  for (let s = 0; s < samples; s += step) {
    const sc = meanDistSq(a, b, s);
    if (sc < bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  for (let d = -step; d <= step; d++) {
    const ss = (best + d + samples * 5) % samples;
    const sc = meanDistSq(a, b, ss);
    if (sc < bestScore) {
      bestScore = sc;
      best = ss;
    }
  }

  const mid: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const p = a[i]!;
    const q = b[(i + best) % samples]!;
    mid.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
  }
  return mid;
}
