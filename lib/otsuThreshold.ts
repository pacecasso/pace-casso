/**
 * Threshold for tracing an uploaded image's ink. Otsu splits the histogram
 * into two classes — right for photos, wrong for light artwork on a white
 * page: it lands BETWEEN the artwork's dark and light tones and erases
 * every light stroke (a grey 3D swoosh lost its entire tail this way).
 * When a dominant near-white background exists, everything that isn't
 * background is ink — threshold sits just under white.
 */
export function inkThresholdForUpload(
  values: Float32Array | number[],
): number {
  const otsu = otsuInkThreshold(values);
  let white = 0;
  let valid = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    valid++;
    if (v >= 0.92) white++;
  }
  if (valid === 0) return otsu;
  if (white / valid >= 0.35) {
    return Math.max(otsu, 0.85);
  }
  return otsu;
}

export function otsuInkThreshold(
  values: Float32Array | number[],
  options: { bins?: number; min?: number; max?: number } = {},
): number {
  const bins = Math.max(16, Math.floor(options.bins ?? 256));
  const min = options.min ?? 0.1;
  const max = options.max ?? 0.9;
  if (values.length === 0) return 0.5;

  const hist = new Float64Array(bins);
  let valid = 0;
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (!Number.isFinite(raw)) continue;
    const v = Math.max(0, Math.min(1, raw));
    const b = Math.min(bins - 1, Math.max(0, Math.floor(v * (bins - 1))));
    hist[b]++;
    valid++;
  }
  if (valid === 0) return 0.5;

  let totalWeighted = 0;
  for (let i = 0; i < bins; i++) totalWeighted += i * hist[i]!;

  let bgWeight = 0;
  let bgWeighted = 0;
  let bestBin = Math.floor((bins - 1) / 2);
  let bestVariance = -1;

  for (let i = 0; i < bins; i++) {
    bgWeight += hist[i]!;
    if (bgWeight <= 0) continue;
    const fgWeight = valid - bgWeight;
    if (fgWeight <= 0) break;

    bgWeighted += i * hist[i]!;
    const bgMean = bgWeighted / bgWeight;
    const fgMean = (totalWeighted - bgWeighted) / fgWeight;
    const delta = bgMean - fgMean;
    const variance = bgWeight * fgWeight * delta * delta;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestBin = i;
    }
  }

  const threshold = bestBin / (bins - 1);
  return Math.max(min, Math.min(max, threshold));
}
