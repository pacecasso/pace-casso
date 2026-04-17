/**
 * Lightweight topology hints for photo line art (Step 1), independent of contour extraction.
 */

function labelInkBlobs4(binary: Uint8Array, w: number, h: number): Int32Array {
  const labels = new Int32Array(w * h);
  let nextLabel = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (binary[i] === 0 || labels[i] !== 0) continue;
      nextLabel++;
      const stack: number[] = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (labels[j] !== 0) continue;
        if (binary[j] === 0) continue;
        labels[j] = nextLabel;
        const jx = j % w;
        const jy = (j / w) | 0;
        if (jx > 0) stack.push(j - 1);
        if (jx < w - 1) stack.push(j + 1);
        if (jy > 0) stack.push(j - w);
        if (jy < h - 1) stack.push(j + w);
      }
    }
  }
  return labels;
}

export type LineMaskHealth = {
  inkBlobCount: number;
  largestBlobShare: number;
  hint: string;
};

/** Ink threshold matches Step 1 preview (`lineMask[i] > 80`). */
export function describeLineMaskHealth(
  mask: Uint8Array,
  w: number,
  h: number,
): LineMaskHealth {
  const bin = new Uint8Array(w * h);
  let ink = 0;
  for (let i = 0; i < bin.length; i++) {
    const v = mask[i]! > 80 ? 1 : 0;
    bin[i] = v;
    ink += v;
  }
  if (ink === 0) {
    return {
      inkBlobCount: 0,
      largestBlobShare: 0,
      hint: "No line yet — draw your shape on the middle canvas.",
    };
  }

  const labels = labelInkBlobs4(bin, w, h);
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]! > maxLabel) maxLabel = labels[i]!;
  }
  const counts = new Array<number>(maxLabel + 1).fill(0);
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i]!;
    if (L > 0) counts[L]!++;
  }
  const blobs = counts
    .map((c, label) => ({ label, c }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c);
  const inkBlobCount = blobs.length;
  const largest = blobs[0]?.c ?? 0;
  const largestBlobShare = largest / ink;

  let hint: string;
  if (inkBlobCount >= 4) {
    hint =
      "Many disconnected strokes — erase gaps or connect islands so one path can follow your art.";
  } else if (inkBlobCount === 2) {
    hint =
      "Two separate ink blobs — use draw to bridge them, or erase strays so the route follows one outline.";
  } else if (inkBlobCount === 3) {
    hint =
      "Three ink regions — consider merging with the pen or removing extras for a cleaner run.";
  } else if (largestBlobShare < 0.55 && inkBlobCount > 1) {
    hint =
      "Ink is split across regions — the largest stroke should carry most of your design.";
  } else {
    hint =
      "Line topology looks workable — refine thickness if the preview contour wanders.";
  }

  return { inkBlobCount, largestBlobShare, hint };
}
