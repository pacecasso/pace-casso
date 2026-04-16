/**
 * Otsu threshold on ink-strength values in [0, 1] (higher = darker / more ink).
 * Picks a binarization threshold that separates foreground ink from paper
 * for high-contrast logos and outline letters.
 */
export function otsuInkThreshold01(values: Float32Array): number {
  const bins = 64;
  const hist = new Uint32Array(bins);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const b = Math.min(bins - 1, Math.max(0, Math.floor(v * bins)));
    hist[b]++;
    n++;
  }
  if (n < 64) return 0.35;

  const invN = 1 / n;
  let sumAll = 0;
  for (let t = 0; t < bins; t++) {
    sumAll += t * hist[t];
  }

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let bestT = 16;

  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF) * invN * invN;
    if (between > maxVar) {
      maxVar = between;
      bestT = t;
    }
  }

  if (maxVar < 1e-8) return 0.35;
  return (bestT + 0.5) / bins;
}

/** Clamp to sane UI range for Step1 photo threshold slider. */
export function clampInkThreshold(t: number): number {
  return Math.min(0.88, Math.max(0.12, t));
}
