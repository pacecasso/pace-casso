/**
 * FINISHER EDIT — apply hand-specified stroke edits to a finisher result
 * (Ralph's taste, Sep 8: "make a window in the middle of the gas tank",
 * "the gas line could go up to the guy and connect to his headphone",
 * "add a little mouth and an eye" on the unicorn), re-route on real
 * streets, render. No model calls.
 *
 * Usage: npx tsx scripts/finisher-edit.ts <summary.json> <edits.json> --name=gas-edit
 *   edits.json: { "drop": [2], "add": [ { "kind": "outline"|"thin", "closed": bool, "group": n, "pts": [[x,y],...] } ] }
 *   Unit space: x,y in [-1,1], y up, before the seat rotation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { LatLng } from "../lib/streetGraphTrace";
import { orderStrokes, routePlacement, meters, setHugTolerance, setTraceProfile, type PainterGraph, type Stroke, type Routed } from "../lib/strokePainter";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const [SUMMARY, EDITS] = argv.filter((a) => !a.startsWith("--"));
if (!SUMMARY || !EDITS) {
  console.log("usage: npx tsx scripts/finisher-edit.ts <summary.json> <edits.json> --name=x");
  process.exit(1);
}
const NAME = opt("name", "edit");
const GRAPH = opt("graph", "tmp-painter/nyc-core-walk-graph.json");
const HUG_M = Number(opt("hug", "90"));
const OUT = path.join(process.cwd(), "tmp-finisher", NAME);

const CELL = 0.003;
async function loadPackedGraph(file: string): Promise<PainterGraph> {
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
async function paleRender(chain: LatLng[], file: string): Promise<void> {
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
}

type Summary = { strokes: Stroke[]; center: LatLng; scale: number; rot: number };
type Edits = { drop?: number[]; add?: Stroke[]; scale?: number; center?: LatLng; rot?: number };

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const prev = JSON.parse(await fs.readFile(SUMMARY!, "utf8")) as Summary;
  const edits = JSON.parse(await fs.readFile(EDITS!, "utf8")) as Edits;
  const drop = new Set(edits.drop ?? []);
  const strokes: Stroke[] = prev.strokes.filter((_, i) => !drop.has(i)).map((s) => ({ ...s, pts: s.pts.map((p) => [p[0], p[1]] as [number, number]) }));
  for (const s of edits.add ?? []) strokes.push({ ...s, pts: s.pts.map((p) => [p[0], p[1]] as [number, number]) });
  const center = edits.center ?? prev.center;
  const scale = edits.scale ?? prev.scale;
  const rot = edits.rot ?? prev.rot;
  setHugTolerance(HUG_M);
  setTraceProfile({ trimNubs: true });
  const g = await loadPackedGraph(GRAPH);
  const r: Routed | null = routePlacement(g, orderStrokes(strokes), center, scale, rot, false);
  if (!r) throw new Error("did not route");
  console.log(`${NAME}: ${r.km.toFixed(1)} km (ink ${r.inkKm.toFixed(1)}, connectors ${r.connectorKm.toFixed(1)}), dropped ${r.dropped}, max gap ${r.maxGap.toFixed(0)} m, strokes ${r.strokes}`);
  await paleRender(r.chain, path.join(OUT, "best.png"));
  const gpx = r.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  await fs.writeFile(
    path.join(OUT, "best.gpx"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso finisher edit" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${NAME}</name><trkseg>\n${gpx}\n</trkseg></trk></gpx>\n`,
  );
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify({ name: NAME, from: SUMMARY, edits: EDITS, km: r.km, center, scale, rot, strokes }, null, 0));
  console.log(`wrote ${path.join(OUT, "best.png")}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
