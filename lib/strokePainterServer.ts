import sharp from "sharp";
import { getStreetGraph, type NormalizedPoint } from "./streetGraphTrace";
import { filledMaskFromContour, paintOnStreets, type PainterGraph, type PaintCandidate } from "./strokePainter";

/**
 * The instant first draft: paint the upload as a filled silhouette on the
 * cached Manhattan walk graph — outline, sparse hatching, centerlines —
 * seated where the street grid is uniform. No Mapbox, no language model;
 * a request finishes in well under a minute. The mask comes from the
 * uploaded image when we have it (alpha or dark ink), else from the
 * approved Step 1 line art with its enclosed regions filled.
 */

const MAX_POINTS = 600;
const BOX = 320;
export const PAINT_TIME_BUDGET_MS = 55_000;

export type PaintRouteResult = {
  ok: boolean;
  reason?: string;
  layout?: "keep" | "stack" | "none";
  chain?: [number, number][];
  km?: number;
  fidelity?: number;
  visibleConnectorKm?: number;
  picks?: { chain: [number, number][]; km: number; fidelity: number; scaleM: number; rotDeg: number }[];
  legalSeats?: number;
  ms?: number;
};

function cleanContour(raw: unknown): NormalizedPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedPoint[] = [];
  for (const p of raw) {
    if (p && typeof p === "object" && Number.isFinite((p as { x?: number }).x) && Number.isFinite((p as { y?: number }).y)) {
      out.push({
        x: Math.min(1, Math.max(0, (p as { x: number }).x)),
        y: Math.min(1, Math.max(0, (p as { y: number }).y)),
      });
      if (out.length >= MAX_POINTS) break;
    }
  }
  return out;
}

/**
 * Silhouette mask from the uploaded image: transparent pixels are paper;
 * on an opaque image, ink is anything darker than mid-grey. A dominant
 * saturated backdrop (badge discs) is treated as paper too.
 */
export async function maskFromImage(imageBase64: string): Promise<{ mask: Uint8Array; w: number; h: number } | null> {
  try {
    const data = imageBase64.includes(",") ? imageBase64.slice(imageBase64.indexOf(",") + 1) : imageBase64;
    const buf = Buffer.from(data, "base64");
    const { data: px, info } = await sharp(buf)
      .resize(BOX, BOX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const n = w * h;
    // border colour = paper; count how much of the image is transparent
    let transparent = 0;
    for (let i = 0; i < n; i++) if (px[i * 4 + 3]! < 128) transparent++;
    const hasAlpha = transparent > n * 0.05;
    // dominant opaque colour (coarse histogram) — a badge disc is paper, not ink
    const hist = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (px[i * 4 + 3]! < 128) continue;
      const key = ((px[i * 4]! >> 5) << 6) | ((px[i * 4 + 1]! >> 5) << 3) | (px[i * 4 + 2]! >> 5);
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
    const ranked = [...hist.entries()].sort((a, b) => b[1] - a[1]);
    const opaque = n - transparent;
    const paperKeys = new Set<number>();
    // the most common colour is paper when it covers most of the opaque area;
    // a second colour is paper too when it is light (white/cream)
    if (ranked[0] && ranked[0][1] > opaque * 0.35) paperKeys.add(ranked[0][0]);
    const mask = new Uint8Array(n);
    let ink = 0;
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3]!;
      if (a < 128) continue;
      const r = px[i * 4]!;
      const g = px[i * 4 + 1]!;
      const b = px[i * 4 + 2]!;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let isInk: boolean;
      if (hasAlpha) isInk = lum < 235 || !paperKeys.has(key);
      else if (paperKeys.size) isInk = !paperKeys.has(key) && !(lum > 225);
      else isInk = lum < 128;
      if (isInk) {
        mask[i] = 255;
        ink++;
      }
    }
    if (ink < n * 0.01 || ink > n * 0.8) return null;
    return { mask, w, h };
  } catch {
    return null;
  }
}

export async function runPaint(
  body: { contour?: unknown; imageBase64?: unknown; cityId?: unknown },
  onProgress: (detail: string) => void,
): Promise<PaintRouteResult> {
  const started = Date.now();
  const contour = cleanContour(body.contour);
  let masked: { mask: Uint8Array; w: number; h: number } | null = null;
  if (typeof body.imageBase64 === "string" && body.imageBase64.length > 100) {
    onProgress("Reading your image as a filled shape…");
    masked = await maskFromImage(body.imageBase64);
  }
  if (!masked && contour.length >= 8) masked = filledMaskFromContour(contour, BOX);
  if (!masked) return { ok: false, reason: "no-shape" };

  onProgress("Loading the street grid…");
  const g = (await getStreetGraph()) as unknown as PainterGraph;
  const res = paintOnStreets(g, masked.mask, masked.w, masked.h, {
    timeBudgetMs: PAINT_TIME_BUDGET_MS,
    picks: 3,
    onProgress,
  });
  const best: PaintCandidate | undefined = res.candidates[0];
  if (!best || best.chain.length < 8) {
    return { ok: false, reason: res.legalSeats ? "no-route" : "no-seat", legalSeats: res.legalSeats, ms: Date.now() - started };
  }
  return {
    ok: true,
    layout: res.layout,
    chain: best.chain,
    km: best.km,
    fidelity: best.fidelity,
    visibleConnectorKm: best.visibleConnKm,
    picks: res.candidates.map((c) => ({ chain: c.chain, km: c.km, fidelity: c.fidelity, scaleM: c.scaleM, rotDeg: c.rotDeg })),
    legalSeats: res.legalSeats,
    ms: Date.now() - started,
  };
}
