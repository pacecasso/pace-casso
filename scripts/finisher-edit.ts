/**
 * FINISHER EDIT — apply hand-specified stroke edits to a finisher result
 * (Ralph's taste, Sep 8: "make a window in the middle of the gas tank",
 * "the gas line could go up to the guy and connect to his headphone",
 * "add a little mouth and an eye" on the unicorn), re-route on real
 * streets, render. No model calls.
 *
 * Usage: npx tsx scripts/finisher-edit.ts <summary.json> <edits.json> --name=gas-edit
 *   edits.json: { "drop": [2], "add": [ { "kind": "outline"|"thin", "closed": bool, "group": n, "pts": [[x,y],...] } ],
 *                 "cut": [ { "i": 0, "at": [[x,y],[x,y]] } ],          // cut a ring at the vertices nearest these points → arcs "cut0.0", "cut0.1", ...
 *                 "sequence": [ { "i": "cut0.0" }, { "i": 1, "near": [x,y] }, { "i": 4 } ] }  // explicit draw order; rings start at the vertex nearest `near` (or the pen); open strokes reverse toward the pen
 *   Unit space: x,y in [-1,1], y up, before the seat rotation. Indices refer to the array after drop+add.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { LatLng } from "../lib/streetGraphTrace";
import { orderStrokes, routePlacement, meters, setHugTolerance, setTraceProfile, type PainterGraph, type Stroke, type Routed } from "../lib/strokePainter";
import { buildTarget, likenessAgainst } from "../lib/strokeLikeness";

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
const IMAGE = opt("image", ""); // optional: score the result against the drawing (--image=gas.png --mask=blue)
const MASK_MODE = opt("mask", "ink");
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
type Cut = { i: number; at: [number, number][] };
type Seq = { i: number | string; near?: [number, number] };
type Edits = { drop?: number[]; add?: Stroke[]; cut?: Cut[]; sequence?: Seq[]; scale?: number; center?: LatLng; rot?: number };
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** ring vertices without the repeated closing point */
const ringPts = (s: Stroke) => (s.closed && dist(s.pts[0]!, s.pts[s.pts.length - 1]!) < 1e-9 ? s.pts.slice(0, -1) : s.pts.slice());
/** insert a vertex at the point of the ring nearest q (rings are corner-only, so vertex snapping would miss the edges); returns its index */
function insertNearest(ring: [number, number][], q: [number, number]): number {
  let best = 0, bd = Infinity, bp: [number, number] = ring[0]!;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const bx = b[0] - a[0], by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * bx + (q[1] - a[1]) * by) / (bx * bx + by * by || 1)));
    const p: [number, number] = [a[0] + t * bx, a[1] + t * by];
    const d = dist(p, q);
    if (d < bd) { bd = d; best = i; bp = p; }
  }
  if (dist(bp, ring[best]!) < 1e-6) return best;
  const next = (best + 1) % ring.length;
  if (dist(bp, ring[next]!) < 1e-6) return next;
  ring.splice(best + 1, 0, bp);
  return best + 1;
}
function cutRing(s: Stroke, at: [number, number][]): Stroke[] {
  const ring = ringPts(s);
  const cuts = at.map((q) => insertNearest(ring, q));
  const arcs: Stroke[] = [];
  for (let k = 0; k < cuts.length; k++) {
    const a = cuts[k]!, b = cuts[(k + 1) % cuts.length]!;
    const pts: [number, number][] = [];
    for (let i = a; ; i = (i + 1) % ring.length) {
      pts.push([ring[i]![0], ring[i]![1]]);
      if (i === b) break;
    }
    arcs.push({ ...s, closed: false, pts });
  }
  return arcs;
}
function compose(strokes: Stroke[], edits: Edits): Stroke[] {
  const arcs = new Map<string, Stroke>();
  for (const [ci, c] of (edits.cut ?? []).entries()) cutRing(strokes[c.i]!, c.at).forEach((arc, k) => arcs.set(`cut${ci}.${k}`, arc));
  if (!edits.sequence) return strokes;
  const out: Stroke[] = [];
  let pen: [number, number] | null = null;
  for (const step of edits.sequence) {
    const src = typeof step.i === "string" ? arcs.get(step.i) : strokes[step.i];
    if (!src) throw new Error(`sequence: no stroke ${step.i}`);
    let pts = src.pts.map((p) => [p[0], p[1]] as [number, number]);
    if (src.closed) {
      const ring = ringPts(src);
      const q = step.near ?? pen;
      const k = q ? insertNearest(ring, q) : 0;
      pts = [...ring.slice(k), ...ring.slice(0, k)];
      pts.push([pts[0]![0], pts[0]![1]]);
    } else if (pen && dist(pts[pts.length - 1]!, pen) < dist(pts[0]!, pen)) pts.reverse();
    out.push({ ...src, pts });
    pen = pts[pts.length - 1]!;
  }
  return out;
}

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
  const laid = edits.sequence ? compose(strokes, edits) : orderStrokes(strokes);
  const r: Routed | null = routePlacement(g, laid, center, scale, rot, false);
  if (!r) throw new Error("did not route");
  // drop the builder's walk back to the start: it rides adjacent streets and reads as a stray line
  let last = r.chain.length - 1;
  while (last > 0 && !r.isInk[last]) last--;
  if (last < r.chain.length - 1) {
    r.chain = r.chain.slice(0, last + 1);
    r.isInk = r.isInk.slice(0, last + 1);
    let m = 0;
    for (let i = 1; i < r.chain.length; i++) m += meters(r.chain[i - 1]!, r.chain[i]!);
    r.km = m / 1000;
  }
  console.log(`${NAME}: ${r.km.toFixed(1)} km (ink ${r.inkKm.toFixed(1)}), dropped ${r.dropped}, max gap ${r.maxGap.toFixed(0)} m, strokes ${r.strokes}`);
  if (IMAGE) {
    const { loadMask } = await import("./finisher-shared");
    const { mask, w, h } = await loadMask(IMAGE, MASK_MODE);
    const lk = likenessAgainst(buildTarget(mask, w, h), r.chain, { center, scale, rot });
    console.log(`  likeness ${lk.score.toFixed(1)} (recall ${lk.recall.toFixed(2)} precision ${lk.precision.toFixed(2)} crossings ${lk.crossings})`);
  }
  await paleRender(r.chain, path.join(OUT, "best.png"));
  const gpx = r.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  await fs.writeFile(
    path.join(OUT, "best.gpx"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso finisher edit" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${NAME}</name><trkseg>\n${gpx}\n</trkseg></trk></gpx>\n`,
  );
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify({ name: NAME, from: SUMMARY, edits: EDITS, km: r.km, center, scale, rot, strokes: laid, composed: Boolean(edits.sequence) }, null, 0));
  console.log(`wrote ${path.join(OUT, "best.png")}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
