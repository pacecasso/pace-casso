/**
 * Shared pieces of the finisher rigs (mask loading, packed walk graph,
 * Strava-style pale render, the edit moves). Extracted from finisher.ts so
 * finisher-geo.ts (zero-model-call variant) does not duplicate them.
 * finisher.ts itself is left untouched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { LatLng } from "../lib/streetGraphTrace";
import { meters, type PainterGraph, type Stroke, type UnitPt } from "../lib/strokePainter";

export const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
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
export async function loadMaskAuto(file: string): Promise<{ mask: Uint8Array; w: number; h: number; mode: string }> {
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

export async function loadMask(file: string, mode: string): Promise<{ mask: Uint8Array; w: number; h: number }> {
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

const CELL = 0.003;
export async function loadPackedGraph(file: string): Promise<PainterGraph> {
  const data = JSON.parse(await fs.readFile(file, "utf8")) as { scale: number; lat: number[]; lng: number[]; edges: number[] };
  const n = data.lat.length;
  const coord: LatLng[] = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = [data.lat[i]! / data.scale, data.lng[i]! / data.scale];
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < data.edges.length; e += 2) {
    const a = data.edges[e]!, b = data.edges[e + 1]!;
    const w = meters(coord[a]!, coord[b]!);
    adj[a]!.push({ to: b, w });
    adj[b]!.push({ to: a, w });
  }
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid };
}

// ---------------------------------------------------------------------------
// Strava-style render on a pale basemap (ArcGIS light gray tiles, free)
// ---------------------------------------------------------------------------
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const tileCache = new Map<string, Buffer | null>();
async function tile(z: number, x: number, y: number): Promise<Buffer | null> {
  const k = `${z}/${y}/${x}`;
  if (tileCache.has(k)) return tileCache.get(k)!;
  let buf: Buffer | null = null;
  try {
    const res = await fetch(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`, {
      headers: { "User-Agent": "pace-casso route preview (dev)" },
    });
    if (res.ok) buf = await sharp(Buffer.from(await res.arrayBuffer())).resize(TILE, TILE).toBuffer();
  } catch {
    /* missing tile */
  }
  tileCache.set(k, buf);
  return buf;
}
export async function paleRender(chain: LatLng[], file: string, basemap = true): Promise<Buffer> {
  const w = 1300, h = 1100;
  let zoom = 14;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.9 && Math.max(...ys) - Math.min(...ys) <= h * 0.9) {
      zoom = z;
      break;
    }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: object[] = [];
  if (basemap)
    for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++)
      for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
        const t = await tile(zoom, tx, ty);
        if (t) tiles.push({ input: t, left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
      }
  const d = chain.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="white" stroke-width="11" stroke-linejoin="round" opacity="0.9"/><path d="${d}" fill="none" stroke="#fc5200" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  );
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(file);
  return sharp(file).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
}

/** logo on the left, route render on the right — for a human eye, not a judge */
export async function sideBySide(imageFile: string, renderFile: string, outFile: string): Promise<void> {
  const H = 550;
  const left = await sharp(imageFile).flatten({ background: "#fff" }).resize({ height: H, width: 550, fit: "contain", background: "#fff" }).toBuffer();
  const right = await sharp(renderFile).resize({ height: H }).toBuffer();
  const rw = (await sharp(right).metadata()).width ?? 650;
  await sharp({ create: { width: 550 + rw + 20, height: H, channels: 3, background: "#fff" } })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: 570, top: 0 },
    ])
    .png()
    .toFile(outFile);
}

// ---------------------------------------------------------------------------
// the drawing state and the edit moves (Cameron-style small edits)
// ---------------------------------------------------------------------------
export type State = { strokes: Stroke[]; center: LatLng; scale: number; rot: number };
export type Rng = () => number;
export function makeRng(seed: number): Rng {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
export const cloneStrokes = (s: Stroke[]): Stroke[] => s.map((k) => ({ ...k, pts: k.pts.map((p) => [p[0], p[1]] as UnitPt) }));
export const strokeLen = (s: Stroke) => {
  let l = 0;
  for (let i = 1; i < s.pts.length; i++) l += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
  return l;
};
function pickStroke(strokes: Stroke[], rnd: Rng): number {
  const w = strokes.map((s) => Math.max(0.05, strokeLen(s)));
  const total = w.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i]!;
    if (r <= 0) return i;
  }
  return w.length - 1;
}
function turnAt(pts: UnitPt[], i: number): number {
  if (i <= 0 || i >= pts.length - 1) return 0;
  const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}
export function rdp(pts: UnitPt[], eps: number): UnitPt[] {
  if (pts.length < 3) return pts;
  const d2 = (p: UnitPt, a: UnitPt, b: UnitPt) => {
    const bx = b[0] - a[0], by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * bx + (p[1] - a[1]) * by) / (bx * bx + by * by || 1)));
    return Math.hypot(p[0] - a[0] - t * bx, p[1] - a[1] - t * by);
  };
  let idx = -1, md = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = d2(pts[i]!, pts[0]!, pts[pts.length - 1]!);
    if (d > md) { md = d; idx = i; }
  }
  if (md > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  return [pts[0]!, pts[pts.length - 1]!];
}

export type Move = { kind: string; detail: string };
/** one small edit; `placementMoves` false keeps the seat fixed (strokes only) */
export function propose(st: State, blockU: number, rnd: Rng, placementMoves = true): { next: State; move: Move } {
  const next: State = { strokes: cloneStrokes(st.strokes), center: [st.center[0], st.center[1]], scale: st.scale, rot: st.rot };
  const r = rnd() * (placementMoves ? 1 : 0.85);
  if (r < 0.6) {
    const si = pickStroke(next.strokes, rnd);
    const s = next.strokes[si]!;
    const pts = s.pts;
    if (pts.length < 3) return propose(st, blockU, rnd, placementMoves);
    const weights = pts.map((_, i) => 0.3 + turnAt(pts, i));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = rnd() * total, vi = 0;
    for (let i = 0; i < weights.length; i++) { acc -= weights[i]!; if (acc <= 0) { vi = i; break; } }
    const mag = blockU * (0.4 + rnd() * 1.8);
    const ang = rnd() * 2 * Math.PI;
    const dx = Math.cos(ang) * mag, dy = Math.sin(ang) * mag;
    const radius = blockU * 1.5;
    const dist = new Array<number>(pts.length).fill(Infinity);
    dist[vi] = 0;
    for (let i = vi + 1; i < pts.length; i++) dist[i] = dist[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    for (let i = vi - 1; i >= 0; i--) dist[i] = dist[i + 1]! + Math.hypot(pts[i]![0] - pts[i + 1]![0], pts[i]![1] - pts[i + 1]![1]);
    for (let i = 0; i < pts.length; i++) {
      const f = Math.exp(-((dist[i]! / radius) ** 2));
      if (f < 0.02) continue;
      pts[i] = [pts[i]![0] + dx * f, pts[i]![1] + dy * f];
    }
    if (s.closed) pts[pts.length - 1] = [pts[0]![0], pts[0]![1]];
    return { next, move: { kind: "drag", detail: `stroke ${si} v${vi} by ${(mag / blockU).toFixed(1)} blocks` } };
  }
  if (r < 0.72) {
    const si = pickStroke(next.strokes, rnd);
    const s = next.strokes[si]!;
    let cx = 0, cy = 0;
    for (const p of s.pts) { cx += p[0]; cy += p[1]; }
    cx /= s.pts.length; cy /= s.pts.length;
    if (rnd() < 0.5) {
      const dx = (rnd() - 0.5) * 2 * blockU, dy = (rnd() - 0.5) * 2 * blockU;
      s.pts = s.pts.map((p) => [p[0] + dx, p[1] + dy] as UnitPt);
      return { next, move: { kind: "shift-stroke", detail: `stroke ${si}` } };
    }
    const k = 1 + (rnd() - 0.5) * 0.3;
    s.pts = s.pts.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k] as UnitPt);
    return { next, move: { kind: "scale-stroke", detail: `stroke ${si} x${k.toFixed(2)}` } };
  }
  if (r < 0.8) {
    const si = pickStroke(next.strokes, rnd);
    const s = next.strokes[si]!;
    const eps = blockU * (0.3 + rnd() * 0.5);
    const before = s.pts.length;
    const pts = rdp(s.pts, eps);
    if (s.closed && pts.length > 2) pts[pts.length - 1] = [pts[0]![0], pts[0]![1]];
    if (pts.length >= (s.closed ? 4 : 2)) s.pts = pts;
    return { next, move: { kind: "simplify", detail: `stroke ${si} ${before}->${s.pts.length} pts` } };
  }
  if (r < 0.85 && next.strokes.length > 1) {
    const lens = next.strokes.map(strokeLen);
    const biggest = lens.indexOf(Math.max(...lens));
    const cands = next.strokes.map((_, i) => i).filter((i) => i !== biggest);
    const si = cands[Math.floor(rnd() * cands.length)]!;
    next.strokes.splice(si, 1);
    return { next, move: { kind: "drop", detail: `stroke ${si}` } };
  }
  if (r < 0.92) {
    next.center = [st.center[0] + ((rnd() - 0.5) * 2 * blockU * st.scale) / 111320, st.center[1] + ((rnd() - 0.5) * 2 * blockU * st.scale) / (111320 * Math.cos((st.center[0] * Math.PI) / 180))];
    return { next, move: { kind: "shift-all", detail: "" } };
  }
  if (r < 0.96) {
    next.rot = st.rot + (rnd() - 0.5) * 8;
    return { next, move: { kind: "rotate", detail: `${next.rot.toFixed(1)}°` } };
  }
  next.scale = Math.round(st.scale * (1 + (rnd() - 0.5) * 0.12));
  return { next, move: { kind: "rescale", detail: `${next.scale} m` } };
}

export function writeGpx(chain: LatLng[], name: string, creator: string): string {
  const pts = chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${pts}\n</trkseg></trk></gpx>\n`;
}
