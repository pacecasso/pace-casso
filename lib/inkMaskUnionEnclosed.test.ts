import assert from "node:assert";
import { fillLineMaskPrimaryPlusEnclosedHoles } from "./inkMaskUnionEnclosed";

/** Minimal 4-connectivity labeler inlined for test (same as Step1). */
function label4(binary: Uint8Array, w: number, h: number): Int32Array {
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

function entriesFromLabels(labels: Int32Array): { label: number; count: number }[] {
  let max = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > max) max = labels[i];
  }
  const counts = new Array<number>(max + 1).fill(0);
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i];
    if (L > 0) counts[L]++;
  }
  const out: { label: number; count: number }[] = [];
  for (let L = 1; L <= max; L++) {
    if (counts[L] > 0) out.push({ label: L, count: counts[L] });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

const w = 24;
const h = 24;
const binary = new Uint8Array(w * h);
// hollow square frame label 1
for (let y = 6; y <= 17; y++) {
  for (let x = 6; x <= 17; x++) {
    const edge = x === 6 || x === 17 || y === 6 || y === 17;
    if (edge) binary[y * w + x] = 1;
  }
}
// small blob inside hole (not touching frame)
for (let y = 10; y <= 13; y++) {
  for (let x = 10; x <= 13; x++) {
    binary[y * w + x] = 1;
  }
}

const labels = label4(binary, w, h);
const entries = entriesFromLabels(labels);
assert(entries.length >= 2, "expected frame + inner blob");

const lineMask = new Uint8Array(w * h);
fillLineMaskPrimaryPlusEnclosedHoles(labels, entries, 0, lineMask, w, h);

let innerKept = false;
for (let y = 10; y <= 13; y++) {
  for (let x = 10; x <= 13; x++) {
    if (lineMask[y * w + x] > 200) innerKept = true;
  }
}
assert(innerKept, "inner blob in hole should be merged into line mask");

console.log("inkMaskUnionEnclosed: ok");
