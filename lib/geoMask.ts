import sharp from "sharp";

/**
 * Mask extraction for the geo draft (moved from scripts/finisher-shared.ts).
 * 320 px box; modes: dark, ink, fill, blue, edges, auto (unattended pick).
 */
export const BOX = 320;

/** connected components (4-neighbour) of a 255-mask, largest first, as pixel counts */
function componentSizes(mask: Uint8Array, w: number, h: number): number[] {
  const seen = new Uint8Array(w * h);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 255 || seen[i]) continue;
    let n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      n++;
      const x = j % w, y = (j / w) | 0;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] || mask[k] !== 255) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        if ((k === j - w && y === 0) || (k === j + w && y === h - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}

/**
 * Unattended extraction: no human picks the mode. Try dark, ink, fill and
 * keep the ones whose ink is a real shape: at least 3 % of the box, not a
 * near-solid slab (largest component under 60 % of its own bounding box),
 * and at least 70 % of the ink in the biggest four pieces. Of those, take
 * the mode with the largest single piece (the whole silhouette beats its
 * stripes). Falls back to fill. Returns the mode chosen for the report.
 */
export async function loadMaskAuto(file: string | Buffer): Promise<{ mask: Uint8Array; w: number; h: number; mode: string }> {
  let fallback: { mask: Uint8Array; w: number; h: number } | null = null;
  let best: { mask: Uint8Array; w: number; h: number; mode: string; biggest: number } | null = null;
  for (const mode of ["dark", "ink", "fill"]) {
    const m = await loadMask(file, mode);
    if (mode === "fill") fallback = m;
    let ink = 0, minX = m.w, maxX = 0, minY = m.h, maxY = 0;
    for (let i = 0; i < m.w * m.h; i++) {
      if (m.mask[i] !== 255) continue;
      ink++;
      const x = i % m.w, y = (i / m.w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (ink < 0.03 * m.w * m.h) continue;
    const bbox = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    const sizes = componentSizes(m.mask, m.w, m.h);
    const big4 = sizes.slice(0, 4).reduce((a, b) => a + b, 0);
    if (sizes[0]! / bbox > 0.6) continue;
    if (big4 / ink < 0.7) continue;
    if (!best || sizes[0]! > best.biggest * 1.15) best = { ...m, mode, biggest: sizes[0]! };
  }
  if (best) return { mask: best.mask, w: best.w, h: best.h, mode: best.mode };
  return { ...(fallback ?? (await loadMask(file, "fill"))), mode: "fill" };
}

export async function loadMask(file: string | Buffer, mode: string): Promise<{ mask: Uint8Array; w: number; h: number }> {
  if (mode === "auto") return loadMaskAuto(file);
  const { data, info } = await sharp(file)
    .resize(BOX, BOX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width as number;
  const h = info.height as number;
  const mask = new Uint8Array(w * h);
  if (mode === "edges") {
    const label = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a < 128 || lum > 235) label[i] = 0;
      else if (lum < 70) label[i] = 1;
      else {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx ? (mx - mn) / mx : 0;
        if (sat < 0.25) label[i] = 2;
        else {
          let hue = 0;
          if (mx === r) hue = ((g - b) / (mx - mn + 1e-9) + 6) % 6;
          else if (mx === g) hue = (b - r) / (mx - mn + 1e-9) + 2;
          else hue = (r - g) / (mx - mn + 1e-9) + 4;
          label[i] = 3 + Math.floor(hue);
        }
      }
    }
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = label[i];
        if (label[i + 1] !== l || label[i + w] !== l) {
          mask[i] = 255;
          mask[i + 1] = 255;
          mask[i + w] = 255;
        }
      }
    return { mask, w, h };
  }
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let ink = false;
    if (mode === "blue") ink = a > 128 && b > 60 && b > r * 1.25 && b > g * 1.25;
    else if (mode === "dark") ink = a > 128 && lum < 110;
    else if (mode === "fill") ink = a > 128 && lum < 240; // any non-white pixel: colour emoji / pale logos
    else ink = a > 128 && lum < 200;
    if (ink) mask[i] = 255;
  }
  return { mask, w, h };
}


/**
 * Fill what a closed outline encloses: flood the background in from the border,
 * and every non-ink pixel it cannot reach is inside the drawing.
 *
 * Line art arrives as a thin ribbon. Measured Sep 18, 2026 on Ralph's
 * catpic.jpg: the outline is 7 px thick in the 320 box, and strokePainter's
 * 60 m morphological opening uses a 6 px erode radius at the size the drawing
 * gets placed - ZERO pixels survive, so the planner sees no silhouette at all
 * and falls back to a skeleton that has no ears. Filling first turns the ribbon
 * into a solid shape that survives the opening.
 *
 * A drawing whose outline is not closed (an open curve, or a line drawing with
 * gaps) encloses nothing, so this returns the mask unchanged rather than
 * flooding the whole box.
 */
export function fillEnclosed(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (mask[i] !== 255 && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const j = stack.pop()!;
    const x = j % w;
    const y = (j / w) | 0;
    if (x > 0) push(j - 1);
    if (x < w - 1) push(j + 1);
    if (y > 0) push(j - w);
    if (y < h - 1) push(j + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i] === 255 || !outside[i]) out[i] = 255;
  return out;
}

/**
 * How thin the ink is, as the median run of consecutive ink pixels across a
 * row. Below about twice the planner's erode radius the drawing is line art and
 * will be erased by the opening unless it is filled first.
 */
export function medianInkRun(mask: Uint8Array, w: number, h: number): number {
  const runs: number[] = [];
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 255) run++;
      else {
        if (run) runs.push(run);
        run = 0;
      }
    }
    if (run) runs.push(run);
  }
  if (!runs.length) return 0;
  runs.sort((a, b) => a - b);
  return runs[runs.length >> 1]!;
}
