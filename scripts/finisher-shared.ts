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
import { meters, type PainterGraph } from "../lib/strokePainter";

export const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");

export { BOX, loadMask, loadMaskAuto } from "../lib/geoMask";

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

export { cloneStrokes, makeRng, propose, rdp, strokeLen, type Move, type Rng, type State } from "../lib/geoDraft";

export function writeGpx(chain: LatLng[], name: string, creator: string): string {
  const pts = chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${pts}\n</trkseg></trk></gpx>\n`;
}
