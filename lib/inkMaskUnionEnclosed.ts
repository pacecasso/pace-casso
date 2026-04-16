/**
 * Merge the primary ink blob with any other blobs that lie entirely in
 * topological holes of the primary (e.g. a hand-drawn counter ring inside
 * an outline letter). Without this, only the largest connected component
 * survives and inner detail is dropped.
 */

function neighbors4(i: number, w: number, h: number): number[] {
  const x = i % w;
  const y = Math.floor(i / w);
  const o: number[] = [];
  if (x > 0) o.push(i - 1);
  if (x < w - 1) o.push(i + 1);
  if (y > 0) o.push(i - w);
  if (y < h - 1) o.push(i + w);
  return o;
}

/** Flood-fill "outside" from image border through cells where primary has no ink. */
function floodOutsidePrimaryGaps(
  primaryInk: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const outside = new Uint8Array(w * h);
  const q: number[] = [];

  const tryPush = (i: number) => {
    if (i < 0 || i >= w * h) return;
    if (primaryInk[i] !== 0) return;
    if (outside[i] !== 0) return;
    outside[i] = 1;
    q.push(i);
  };

  for (let x = 0; x < w; x++) {
    tryPush(x);
    tryPush((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    tryPush(y * w);
    tryPush(y * w + (w - 1));
  }

  while (q.length) {
    const i = q.pop()!;
    for (const j of neighbors4(i, w, h)) {
      if (primaryInk[j] !== 0) continue;
      if (outside[j] !== 0) continue;
      outside[j] = 1;
      q.push(j);
    }
  }
  return outside;
}

const MIN_ENCLOSED_BLOB_PX = 14;
/** Fraction of a secondary blob's pixels that must lie in primary holes. */
const ENCLOSED_RATIO = 0.52;

function secondaryMostlyInPrimaryHoles(
  labels: Int32Array,
  secondaryLabel: number,
  primaryInk: Uint8Array,
  outside: Uint8Array,
  w: number,
  h: number,
): boolean {
  let inHole = 0;
  let total = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== secondaryLabel) continue;
    total++;
    if (primaryInk[i] === 0 && outside[i] === 0) inHole++;
  }
  if (total < MIN_ENCLOSED_BLOB_PX) return false;
  return inHole / total >= ENCLOSED_RATIO;
}

/**
 * Writes 255 into lineMask for the primary component and any secondary
 * components that sit in holes of the primary silhouette.
 */
export function fillLineMaskPrimaryPlusEnclosedHoles(
  labels: Int32Array,
  entries: { label: number; count: number }[],
  primaryIdx: number,
  lineMask: Uint8Array,
  w: number,
  h: number,
): void {
  if (!entries.length) {
    lineMask.fill(0);
    return;
  }
  const safeIdx = Math.min(primaryIdx, Math.max(0, entries.length - 1));
  const primaryLabel = entries[safeIdx]!.label;

  const primaryInk = new Uint8Array(w * h);
  for (let i = 0; i < labels.length; i++) {
    primaryInk[i] = labels[i] === primaryLabel ? 255 : 0;
  }

  const outside = floodOutsidePrimaryGaps(primaryInk, w, h);
  const keep = new Set<number>([primaryLabel]);

  for (const e of entries) {
    if (e.label === primaryLabel) continue;
    if (e.count < MIN_ENCLOSED_BLOB_PX) continue;
    if (
      secondaryMostlyInPrimaryHoles(
        labels,
        e.label,
        primaryInk,
        outside,
        w,
        h,
      )
    ) {
      keep.add(e.label);
    }
  }

  for (let i = 0; i < labels.length; i++) {
    lineMask[i] = keep.has(labels[i]) ? 255 : 0;
  }
}
