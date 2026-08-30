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
  if (inkBlobCount >= 5) {
    // Lots of separate blobs almost always means lettering (a word is one
    // blob per letter). Bridging them "works" and then produces an
    // unreadable tangle once the route follows real streets — letter shapes
    // are far smaller than a city block. Say so instead of sending the user
    // through six more steps to find out.
    hint =
      "Your drawing is in lots of separate pieces — usually words or fine detail, which don't survive being drawn on real streets. Keep one bold symbol and erase the rest.";
  } else if (inkBlobCount === 4) {
    hint =
      "Your drawing is in a few separate pieces. Connect them with the Draw tool — or erase the extras — so one running path can follow it.";
  } else if (inkBlobCount === 2) {
    hint =
      "Your drawing is in two separate pieces. Connect them with the Draw tool, or erase the smaller one, so the route can follow one outline.";
  } else if (inkBlobCount === 3) {
    hint =
      "Your drawing is in three separate pieces. Connect them with the Draw tool, or erase the extras, for a cleaner route.";
  } else if (largestBlobShare < 0.55 && inkBlobCount > 1) {
    hint =
      "Most of your design should be one main shape — right now it's split into pieces. Erase the small extras or connect them.";
  } else {
    hint =
      "Looking good — this can be run as one continuous line. Touch it up with Draw and Erase if anything looks off.";
  }

  return { inkBlobCount, largestBlobShare, hint };
}
