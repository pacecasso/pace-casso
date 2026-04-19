/**
 * Moore–neighbor boundary tracing on the largest ink component of the line mask,
 * plus inner boundaries of enclosed background holes (thick letters with counters).
 *
 * Coordinates are pixel centers in the same space as the 300×300 line canvas.
 */

const INK = 200;
const MIN_HOLE_PIXELS = 14;

function isInk(v: number): boolean {
  return v > INK;
}

/** 8-neighbor offsets in counter-clockwise order starting at North. */
const DX8_CCW = [0, -1, -1, -1, 0, 1, 1, 1];
const DY8_CCW = [-1, -1, 0, 1, 1, 1, 0, -1];

function largestComponentBinaryMask(
  src: Uint8Array,
  w: number,
  h: number,
): Uint8Array | null {
  const bin = new Uint8Array(w * h);
  let inkCount = 0;
  for (let i = 0; i < src.length; i++) {
    if (isInk(src[i])) {
      bin[i] = 1;
      inkCount++;
    }
  }
  if (inkCount === 0) return null;

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

function padBinary(
  bin: Uint8Array,
  w: number,
  h: number,
): { buf: Uint8Array; pw: number; ph: number } {
  const pw = w + 2;
  const ph = h + 2;
  const buf = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x]) buf[(y + 1) * pw + (x + 1)] = 1;
    }
  }
  return { buf, pw, ph };
}

function inkAt(
  buf: Uint8Array,
  pw: number,
  ph: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= pw || y >= ph) return false;
  return buf[y * pw + x] !== 0;
}

/**
 * Moore trace on a padded 0/1 buffer (ink = 1). Returns closed polyline in
 * **unpadded** image coordinates (pixel centers).
 */
function mooreTracePaddedInk(
  buf: Uint8Array,
  pw: number,
  ph: number,
): [number, number][] | null {
  let sx = -1;
  let sy = -1;
  outer: for (let y = 1; y < ph - 1; y++) {
    for (let x = 1; x < pw - 1; x++) {
      if (!inkAt(buf, pw, ph, x, y)) continue;
      if (!inkAt(buf, pw, ph, x - 1, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null;

  const path: [number, number][] = [];
  let cx = sx;
  let cy = sy;
  /** Direction from current pixel toward the previous boundary pixel (CCW index). */
  let back = 2;

  const maxSteps = pw * ph * 24;
  for (let step = 0; step < maxSteps; step++) {
    path.push([cx - 1 + 0.5, cy - 1 + 0.5]);

    let nx = -1;
    let ny = -1;
    for (let t = 0; t < 8; t++) {
      const id = (back + t + 1) % 8;
      const tx = cx + DX8_CCW[id]!;
      const ty = cy + DY8_CCW[id]!;
      if (inkAt(buf, pw, ph, tx, ty)) {
        nx = tx;
        ny = ty;
        back = (id + 4) % 8;
        break;
      }
    }
    if (nx < 0) break;

    cx = nx;
    cy = ny;

    if (cx === sx && cy === sy && path.length > 2) {
      break;
    }
  }

  if (path.length < 4) return null;
  return path;
}

function floodExteriorZeros(
  inkPadded: Uint8Array,
  pw: number,
  ph: number,
): Uint8Array {
  const ext = new Uint8Array(pw * ph);
  const q: number[] = [0];
  ext[0] = 1;
  while (q.length) {
    const i = q.pop()!;
    const x = i % pw;
    const y = (i / pw) | 0;
    const nbs = [i - 1, i + 1, i - pw, i + pw];
    for (const j of nbs) {
      if (j < 0 || j >= pw * ph) continue;
      if (ext[j] || inkPadded[j]) continue;
      ext[j] = 1;
      q.push(j);
    }
  }
  return ext;
}

function labelHoleComponents(
  inkPadded: Uint8Array,
  exterior: Uint8Array,
  pw: number,
  ph: number,
): { labels: Int32Array; maxLabel: number; counts: number[] } {
  const labels = new Int32Array(pw * ph);
  let maxLabel = 0;
  const counts: number[] = [0];

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = y * pw + x;
      if (inkPadded[i] || exterior[i] || labels[i] !== 0) continue;
      maxLabel++;
      if (counts.length <= maxLabel) counts.push(0);
      const stack: number[] = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (labels[j] !== 0) continue;
        const jx = j % pw;
        const jy = (j / pw) | 0;
        if (inkPadded[j] || exterior[j]) continue;
        labels[j] = maxLabel;
        counts[maxLabel] = (counts[maxLabel] ?? 0) + 1;
        if (jx > 0) stack.push(j - 1);
        if (jx < pw - 1) stack.push(j + 1);
        if (jy > 0) stack.push(j - pw);
        if (jy < ph - 1) stack.push(j + pw);
      }
    }
  }
  return { labels, maxLabel, counts };
}

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

/**
 * Outer boundary of largest ink component, then inner hole boundaries (largest
 * hole area first). Rings are in image pixel-center coordinates.
 */
export function mooreContourRingsFromLineMask(
  lineMask: Uint8Array,
  w: number,
  h: number,
): [number, number][][] | null {
  const comp = largestComponentBinaryMask(lineMask, w, h);
  if (!comp) return null;

  const { buf, pw, ph } = padBinary(comp, w, h);
  const outer = mooreTracePaddedInk(buf, pw, ph);
  if (!outer) return null;

  const exterior = floodExteriorZeros(buf, pw, ph);
  const { labels, maxLabel, counts } = labelHoleComponents(buf, exterior, pw, ph);

  const innerCandidates: { label: number; area: number }[] = [];
  for (let L = 1; L <= maxLabel; L++) {
    const c = counts[L] ?? 0;
    if (c >= MIN_HOLE_PIXELS) innerCandidates.push({ label: L, area: c });
  }
  innerCandidates.sort((a, b) => b.area - a.area);

  const rings: [number, number][][] = [outer];
  const holeBuf = new Uint8Array(pw * ph);

  for (const { label } of innerCandidates) {
    holeBuf.fill(0);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === label) holeBuf[i] = 1;
    }
    const inner = mooreTracePaddedInk(holeBuf, pw, ph);
    if (inner && inner.length >= 4) rings.push(inner);
  }

  if (rings.length > 1) {
    const [o, ...rest] = rings;
    rest.sort((a, b) => ringAreaAbs(b) - ringAreaAbs(a));
    rings.length = 0;
    rings.push(o!, ...rest);
  }

  return rings;
}

/**
 * Label every ink component on the line mask and return per-component pixel
 * counts, so the caller can decide which "sibling" components are worth
 * bridging into the main shape.
 */
function labelAllInkComponents(
  src: Uint8Array,
  w: number,
  h: number,
): { labels: Int32Array; counts: number[] } {
  const labels = new Int32Array(w * h);
  const counts: number[] = [0];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isInk(src[i]!) || labels[i] !== 0) continue;
      const next = counts.length;
      counts.push(0);
      const stack: number[] = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (labels[j] !== 0) continue;
        if (!isInk(src[j]!)) continue;
        labels[j] = next;
        counts[next] = (counts[next] ?? 0) + 1;
        const jx = j % w;
        const jy = (j / w) | 0;
        if (jx > 0) stack.push(j - 1);
        if (jx < w - 1) stack.push(j + 1);
        if (jy > 0) stack.push(j - w);
        if (jy < h - 1) stack.push(j + w);
      }
    }
  }
  return { labels, counts };
}

/**
 * Outer boundary rings of every SIGNIFICANT ink component EXCEPT the largest.
 * Used by the contour extractor to bridge multiple disconnected pieces (e.g.,
 * two side-by-side letters) into one continuous path. Returns rings in
 * pixel-center image coordinates, sorted largest-first.
 *
 * A sibling is "significant" if its pixel area is above both an absolute
 * floor (`minPixels`) and a relative threshold (`minRelativeToLargest`).
 * This rejects small noise blobs while keeping real disjoint features.
 */
export function mooreSiblingOuterRings(
  src: Uint8Array,
  w: number,
  h: number,
  minPixels = 150,
  minRelativeToLargest = 0.18,
): [number, number][][] {
  const { labels, counts } = labelAllInkComponents(src, w, h);
  if (counts.length <= 2) return []; // no siblings

  let largestLabel = 1;
  let largestCount = 0;
  for (let L = 1; L < counts.length; L++) {
    if ((counts[L] ?? 0) > largestCount) {
      largestCount = counts[L]!;
      largestLabel = L;
    }
  }
  const threshold = Math.max(minPixels, largestCount * minRelativeToLargest);

  type SiblingEntry = { ring: [number, number][]; area: number };
  const siblings: SiblingEntry[] = [];

  for (let L = 1; L < counts.length; L++) {
    if (L === largestLabel) continue;
    const c = counts[L] ?? 0;
    if (c < threshold) continue;

    const compMask = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === L) compMask[i] = 1;
    }
    const { buf, pw, ph } = padBinary(compMask, w, h);
    const outer = mooreTracePaddedInk(buf, pw, ph);
    if (outer && outer.length >= 4) {
      siblings.push({ ring: outer, area: ringAreaAbs(outer) });
    }
  }

  siblings.sort((a, b) => b.area - a.area);
  return siblings.map((s) => s.ring);
}

/** Single outer ring only (backwards-compatible helper). */
export function mooreBoundaryPixelCenters(
  lineMask: Uint8Array,
  w: number,
  h: number,
): [number, number][] | null {
  const rings = mooreContourRingsFromLineMask(lineMask, w, h);
  return rings?.[0] ?? null;
}
