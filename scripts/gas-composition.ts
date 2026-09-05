/**
 * COMPOSITION SEARCH (Sep 4) — draw a multi-part logo the way the reference
 * lion/tiger are drawn: BIG, across boroughs, each body seated on its own
 * street grid, the link (hose) routed between the seated attachment points
 * over whatever bridge the walk graph offers.
 *
 *   split bodies + links ──► global placement (center, scale, orientation)
 *     ──► per-body seat search near its nominal spot (own grid rotation)
 *     ──► route each body with the painter ──► walk the link A→B
 *     ──► stitch, render, blind-judge
 *
 * Usage: npx tsx scripts/gas-composition.ts gas.png --mask=blue [--scales=3200,3800,4400]
 *        [--graph=tmp-painter/nyc-core-walk-graph.json] [--lat=40.70,40.80] [--lng=-74.00,-73.90]
 *        [--picks=3] [--nojudge] [--name=gas-comp]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { place, type LatLng } from "../lib/streetGraphTrace";
import {
  splitBodies,
  makePlan,
  orderStrokes,
  routePlacement,
  localGridInfo,
  nearestNode,
  walk,
  meters,
  type PainterGraph,
  type Plan,
  type Routed,
  type UnitPt,
  setHugTolerance,
  setBlockify,
} from "../lib/strokePainter";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
if (!IMG) {
  console.log("usage: npx tsx scripts/gas-composition.ts <image> [--mask=blue]");
  process.exit(1);
}
const NAME = opt("name", "gas-comp");
const MASK_MODE = opt("mask", "blue");
const SCALES = opt("scales", "3200,3800,4400").split(",").map(Number);
const [LAT0, LAT1] = opt("lat", "40.70,40.80").split(",").map(Number);
const [LNG0, LNG1] = opt("lng", "-74.00,-73.90").split(",").map(Number);
const PICKS = Number(opt("picks", "3"));
const JUDGE = !argv.includes("--nojudge");
const ROT0 = Number(opt("rot", "-29")); // composition orientation: up along Manhattan/Astoria avenues
const ROWS = Number(opt("rows", "3"));
const OPEN_M = Number(opt("open", "60"));
const DRIFT_CAP = Number(opt("drift", "1400"));
const MAX_ROUTE = Number(opt("route", "10"));
const STEP = Number(opt("step", "0.008"));
const DISC = argv.includes("--disc"); // draw the badge disc around the composition
const FIG_BOOST = Number(opt("figscale", "1.0")); // smaller bodies drawn this much larger (the person carries the identity) // compositions routed per scale
const JUDGE_TOP = Number(opt("judge", "12")); // compositions scored by the likeness judge // meters a body may slide from the logo's arrangement
const OUT = path.join(process.cwd(), "tmp-painter", NAME);
setHugTolerance(Number(opt("hug", "90")));
setBlockify(!argv.includes("--noblockify"));
const BOX = 320;

// ---------------------------------------------------------------------------
// mask + graph
// ---------------------------------------------------------------------------
async function loadMask(file: string, mode: string): Promise<{ mask: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(file)
    .resize(BOX, BOX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const ink = mode === "blue" ? a > 128 && b > 60 && b > r * 1.25 && b > g * 1.25 : a > 128 && lum < 200;
    if (ink) mask[i] = 255;
  }
  return { mask, w, h };
}
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
    adj[a]!.push({ to: b, w }); adj[b]!.push({ to: a, w });
  }
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid };
}
const PARK: LatLng[] = [[40.7638, -73.9722], [40.7676, -73.9828], [40.801, -73.9585], [40.7973, -73.9482]];
// Prospect Park + Botanic Garden + Green-Wood (bodies may not enter; links may)
const PARKS: LatLng[][] = [
  PARK,
  [[40.6740, -73.9705], [40.6615, -73.9760], [40.6490, -73.9640], [40.6570, -73.9540], [40.6690, -73.9600]],
  [[40.6600, -73.9950], [40.6480, -73.9980], [40.6440, -73.9800], [40.6560, -73.9760]],
];
function inPoly(p: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i]![0], xi = poly[i]![1], yj = poly[j]![0], xj = poly[j]![1];
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// render + judge (same as the painter rig)
// ---------------------------------------------------------------------------
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
async function paleRender(chain: LatLng[], file: string, isInk?: boolean[]): Promise<Buffer> {
  const w = 1400, h = 1100;
  let zoom = 14;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.9 && Math.max(...ys) - Math.min(...ys) <= h * 0.9) { zoom = z; break; }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: object[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++)
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      try {
        const res = await fetch(`https://services.arcgisonline.com/ArcGis/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${zoom}/${ty}/${tx}`, { headers: { "User-Agent": "pace-casso route preview (dev)" } });
        if (!res.ok) continue;
        tiles.push({ input: await sharp(Buffer.from(await res.arrayBuffer())).resize(TILE, TILE).toBuffer(), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
      } catch { /* tile missing */ }
    }
  let svg = "";
  if (isInk) {
    for (let i = 1; i < chain.length; i++) svg += `<line x1="${(xs[i - 1]! - vx).toFixed(1)}" y1="${(ys[i - 1]! - vy).toFixed(1)}" x2="${(xs[i]! - vx).toFixed(1)}" y2="${(ys[i]! - vy).toFixed(1)}" stroke="${isInk[i] ? "#fc5200" : "#2266dd"}" stroke-width="${isInk[i] ? 5 : 3}" stroke-linecap="round"/>`;
  } else {
    const d = chain.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
    svg = `<path d="${d}" fill="none" stroke="white" stroke-width="11" stroke-linejoin="round" opacity="0.9"/><path d="${d}" fill="none" stroke="#fc5200" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  const overlay = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } }).composite([...tiles, { input: overlay, left: 0, top: 0 }]).png().toFile(file);
  return sharp(file).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
}
let KEY = "";
async function claude(content: unknown[], maxTokens = 2500): Promise<string> {
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-fable-5", max_tokens: maxTokens, messages: [{ role: "user", content }] }),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 4000 * (a + 1))); continue; }
      const j = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    } catch { await new Promise((r) => setTimeout(r, 4000 * (a + 1))); }
  }
  return "";
}
async function judge(renderJpg: Buffer, upload: string) {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: renderJpg.toString("base64") } };
  const cold: { guess: string; conf: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await claude([img, { type: "text", text: "The orange line is a GPS route someone recorded while running; they were trying to draw a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or \"nothing recognizable\">\nCONFIDENCE: <0-10>" }]);
    cold.push({ guess: (t.match(/GUESS\**:?\**\s*(.+?)\s*(?:\n|\*|CONFIDENCE|$)/i)?.[1] ?? "?").trim(), conf: Number(t.match(/CONFIDENCE\**:?\**\s*(\d+)/i)?.[1] ?? 0) });
  }
  const up = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(upload).flatten({ background: "#fff" }).resize({ width: 700 }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const like: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await claude([up, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as an orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1 to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color or background. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }]);
    like.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  return { cold, like };
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------
type Seat = { center: LatLng; rot: number; score: number };
type BodyCtx = {
  idx: number;
  plan: Plan;
  scaleM: number;
  unitCenter: UnitPt; // in the global unit frame
  spanPx: number;
  cxPx: number;
  cyPx: number;
  samples: UnitPt[];
  ext: [number, number];
};

function bodySeats(g: PainterGraph, b: BodyCtx, nominal: LatLng, radiusLat = 0.012, radiusLng = 0.015): Seat[] {
  const seats: Seat[] = [];
  for (let dl = -radiusLat; dl <= radiusLat + 1e-9; dl += 0.003) {
    for (let dg = -radiusLng; dg <= radiusLng + 1e-9; dg += 0.0035) {
      const c: LatLng = [nominal[0] + dl, nominal[1] + dg];
      const info = localGridInfo(g, c);
      if (!info || info.uniform < 0.6) continue;
      const rot = info.rot;
      let mixed = false;
      for (const fx of [-1, 0, 1]) {
        for (const fy of [-1, 0, 1]) {
          if (!fx && !fy) continue;
          const pr = place([[fx * b.ext[0], fy * b.ext[1]]], c, b.scaleM, rot)[0]!;
          const q = localGridInfo(g, pr);
          if (!q || q.uniform < 0.5) { mixed = true; break; }
          const da = Math.min(Math.abs(q.axis - info.axis), 90 - Math.abs(q.axis - info.axis));
          if (da > 10) { mixed = true; break; }
        }
        if (mixed) break;
      }
      if (mixed) continue;
      const placed = place(b.samples, c, b.scaleM, rot);
      let sum = 0, miss = 0, bad = false;
      const cap = Math.max(3, Math.floor(placed.length * 0.03));
      for (const p of placed) {
        if (PARKS.some((poly) => inPoly(p, poly))) { bad = true; break; }
        if (p[1] < -73.999 && p[0] > 40.742 && p[0] < 40.778) { bad = true; break; } // Hudson Yards / piers
        const { d } = nearestNode(g, p);
        if (d > 130) { miss++; if (miss > cap) { bad = true; break; } }
        sum += Math.min(d, 130);
      }
      if (bad) continue;
      seats.push({ center: c, rot, score: sum / placed.length });
    }
  }
  seats.sort((a, b) => a.score - b.score);
  return seats;
}

function bodyBox(b: BodyCtx, seat: Seat): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const pts = place(b.samples, seat.center, b.scaleM, seat.rot);
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of pts) { if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0]; if (p[1] < minLng) minLng = p[1]; if (p[1] > maxLng) maxLng = p[1]; }
  return { minLat, maxLat, minLng, maxLng };
}
function boxesOverlap(a: ReturnType<typeof bodyBox>, b: ReturnType<typeof bodyBox>, gapM = 150): boolean {
  const gLat = gapM / 111320, gLng = gapM / (111320 * Math.cos((a.minLat * Math.PI) / 180));
  return !(a.maxLat + gLat < b.minLat || b.maxLat + gLat < a.minLat || a.maxLng + gLng < b.minLng || b.maxLng + gLng < a.minLng);
}
function attach(b: BodyCtx, seat: Seat, px: [number, number]): LatLng {
  return place([[((px[0] - b.cxPx) * 2) / b.spanPx, ((b.cyPx - px[1]) * 2) / b.spanPx]], seat.center, b.scaleM, seat.rot)[0]!;
}
/**
 * The hose: the logo's own link curve, similarity-mapped from its original
 * attachment points onto the seated ones, then traced organically (stairs
 * on a grid, bridges over water). Falls back to the shortest walk.
 */
function routeLink(g: PainterGraph, poly: [number, number][], A0: [number, number], B0: [number, number], A: LatLng, B: LatLng): LatLng[] | null {
  const nA = nearestNode(g, A).id, nB = nearestNode(g, B).id;
  if (poly.length >= 4) {
    // local meters frame at A, x east y north
    const mPerLat = 111320, mPerLng = 111320 * Math.cos((A[0] * Math.PI) / 180);
    // which end of the skeleton touches A0? use the skeleton's own endpoints as the source pair
    // the Eulerian walk is a closed circuit; take the single pass between the
    // point nearest the nozzle (A0) and the point nearest the hand (B0)
    let aI = 0, ad = Infinity, bI = 0, bd = Infinity;
    poly.forEach((pt, i) => {
      const da = Math.hypot(pt[0] - A0[0], pt[1] - A0[1]); if (da < ad) { ad = da; aI = i; }
      const db = Math.hypot(pt[0] - B0[0], pt[1] - B0[1]); if (db < bd) { bd = db; bI = i; }
    });
    const lo = Math.min(aI, bI), hi = Math.max(aI, bI);
    let src: [number, number][] = poly.slice(lo, hi + 1);
    if (aI > bI) src = src.slice().reverse();
    if (src.length < 4) src = poly;
    const S0 = src[0]!, S1 = src[src.length - 1]!;
    const nx = (B[1] - A[1]) * mPerLng, ny = (B[0] - A[0]) * mPerLat;
    const ox = S1[0] - S0[0], oy = -(S1[1] - S0[1]); // px y is down
    const ol = Math.hypot(ox, oy) || 1, nl = Math.hypot(nx, ny) || 1;
    const sc = nl / ol;
    const ang = Math.atan2(ny, nx) - Math.atan2(oy, ox);
    const cs = Math.cos(ang), sn = Math.sin(ang);
    let srcLenPx = 0;
    for (let i = 1; i < src.length; i++) srcLenPx += Math.hypot(src[i]![0] - src[i - 1]![0], src[i]![1] - src[i - 1]![1]);
    let target: LatLng[] = src.map(([x, y]) => {
      const px = x - S0[0], py = -(y - S0[1]);
      const rx = sc * (px * cs - py * sn), ry = sc * (px * sn + py * cs);
      return [A[0] + ry / mPerLat, A[1] + rx / mPerLng] as LatLng;
    });
    const needDroop = srcLenPx * sc > 2.2 * nl + 600 || sc > 1.3 * HOSE_M_PER_PX || nl > 1500;
    const candidates: LatLng[][] = needDroop ? [] : [target];
    if (needDroop) {
      // the bodies sit farther apart than the logo's hose reaches: draw a
      // droop between them (down like the logo's hose), trying several
      // depths and both sides so one of them finds streets
      for (const [depth, side] of [[0.45, -1], [0.3, -1], [0.65, -1], [0.3, 1], [0.45, 1]] as [number, number][]) {
        const droop = side * Math.max(400, depth * nl);
        const c1: LatLng = [A[0] + droop / mPerLat, A[1] + (0.25 * nx) / mPerLng];
        const c2: LatLng = [B[0] + droop / mPerLat, B[1] - (0.25 * nx) / mPerLng];
        const arc: LatLng[] = [];
        for (let t = 0; t <= 1.0001; t += 1 / 20) {
          const u = 1 - t;
          arc.push([u * u * u * A[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * B[0], u * u * u * A[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * B[1]]);
        }
        candidates.push(arc);
      }
    }
    for (const target of candidates) {
      if (!needDroop) {
        const strokes = [{ kind: "thin" as const, pts: target.map((p) => [(p[1] - A[1]) * mPerLng / 1000, (p[0] - A[0]) * mPerLat / 1000] as UnitPt), closed: false, link: true }];
        const r = routePlacement(g, strokes, A, 1000, 0, false);
        LINKLOG.push(`link: logo curve traced ${r ? `${r.chain.length}n dropped ${r.dropped} start ${meters(r.chain[0]!, A).toFixed(0)}m end ${meters(r.chain[r.chain.length - 1]!, B).toFixed(0)}m` : "null"}`);
        if (r && r.chain.length >= 4 && r.dropped === 0 && meters(r.chain[0]!, A) < 250 && meters(r.chain[r.chain.length - 1]!, B) < 300) {
          const head = walk(g, nA, nearestNode(g, r.chain[0]!).id, 800) ?? [];
          const tail = walk(g, nearestNode(g, r.chain[r.chain.length - 1]!).id, nB, 800) ?? [];
          return [...head.map((k) => g.coord[k]!), ...r.chain, ...tail.map((k) => g.coord[k]!)];
        }
        continue;
      }
      // droop: waypoints along the arc, joined by shortest walks — always connected
      const ids: number[] = [nA];
      let okWp = true;
      for (const t of [0.2, 0.4, 0.6, 0.8]) {
        const pt = target[Math.round(t * (target.length - 1))]!;
        const n = nearestNode(g, pt);
        if (n.d > 220) { okWp = false; break; }
        if (n.id !== ids[ids.length - 1]) ids.push(n.id);
      }
      if (!okWp) { LINKLOG.push("link: droop waypoint off-street"); continue; }
      ids.push(nB);
      const chain: LatLng[] = [];
      let total = 0, straight = meters(A, B);
      for (let i = 1; i < ids.length; i++) {
        const seg = walk(g, ids[i - 1]!, ids[i]!, 4000);
        if (!seg) { okWp = false; break; }
        const pts = seg.map((k) => g.coord[k]!);
        for (let j = 1; j < pts.length; j++) total += meters(pts[j - 1]!, pts[j]!);
        chain.push(...(chain.length ? pts.slice(1) : pts));
      }
      if (!okWp || total > straight * 3.2 + 1500) { LINKLOG.push(`link: droop walk ${okWp ? "too long" : "broken"}`); continue; }
      LINKLOG.push(`link: droop via waypoints ${(total / 1000).toFixed(1)} km`);
      return chain;
    }
  }
  LINKLOG.push(`link: skeleton ${poly.length} pts -> walk fallback`);
  const wpath = walk(g, nA, nB, meters(A, B) * 3 + 2500);
  return wpath ? wpath.map((k) => g.coord[k]!) : null;
}
const LINKLOG: string[] = [];
let HOSE_M_PER_PX = 15;

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  try { KEY = (await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8")).match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? ""; } catch { /* no key */ }
  const { mask, w, h } = await loadMask(IMG!, MASK_MODE);
  const split = splitBodies(mask, w, h);
  if (!split) { console.log("fewer than 2 bodies — use the plain painter"); return; }
  console.log(`bodies: ${split.bodies.map((b) => `${b.px}px [${b.x0}-${b.x1} x ${b.y0}-${b.y1}]`).join(" | ")}; links: ${split.links.map((l) => `${l.a}->${l.b}`).join(", ")}`);
  console.log("loading graph…");
  const g = await loadPackedGraph(opt("graph", "tmp-painter/nyc-core-walk-graph.json"));
  console.log(`graph: ${g.coord.length} nodes`);

  // global unit frame from the whole mask
  let gx0 = w, gx1 = 0, gy0 = h, gy1 = 0;
  for (let i = 0; i < w * h; i++) if (mask[i] === 255) { const x = i % w, y = (i / w) | 0; if (x < gx0) gx0 = x; if (x > gx1) gx1 = x; if (y < gy0) gy0 = y; if (y > gy1) gy1 = y; }
  const gspan = Math.max(gx1 - gx0, gy1 - gy0) || 1;
  const gcx = (gx0 + gx1) / 2, gcy = (gy0 + gy1) / 2;
  const toGlobalUnit = (x: number, y: number): UnitPt => [((x - gcx) * 2) / gspan, ((gcy - y) * 2) / gspan];

  const results: { scale: number; center: LatLng; routed: Routed; bodiesRouted: { seat: Seat; r: Routed }[]; linkKm: number; km: number; fidelity: number }[] = [];

  for (const scale of SCALES) {
    const mPerPx = (2 * scale) / gspan;
    HOSE_M_PER_PX = mPerPx;
    // per-body plans at this scale
    const biggestPx = Math.max(...split.bodies.map((b) => b.px));
    const bodies: BodyCtx[] = split.bodies.map((b, idx) => {
      const spanPx = Math.max(b.x1 - b.x0, b.y1 - b.y0) || 1;
      const scaleM = (spanPx / 2) * mPerPx * (b.px === biggestPx ? 1 : FIG_BOOST);
      const plan = makePlan(b.mask, b.w, b.h, scaleM, { pitchM: 160, rows: b.px === biggestPx ? ROWS : 0, openM: OPEN_M });
      const samples: UnitPt[] = [];
      for (const s of plan.strokes) for (let i = 1; i < s.pts.length; i++) {
        const a = s.pts[i - 1]!, c = s.pts[i]!;
        const n = Math.max(1, Math.round((Math.hypot(c[0] - a[0], c[1] - a[1]) * scaleM) / 60));
        for (let k = 0; k <= n; k++) samples.push([a[0] + ((c[0] - a[0]) * k) / n, a[1] + ((c[1] - a[1]) * k) / n]);
      }
      const ext: [number, number] = [Math.max(...samples.map((p) => Math.abs(p[0]))) * 0.85, Math.max(...samples.map((p) => Math.abs(p[1]))) * 0.85];
      return { idx, plan, scaleM, unitCenter: toGlobalUnit((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), spanPx, cxPx: (b.x0 + b.x1) / 2, cyPx: (b.y0 + b.y1) / 2, samples, ext };
    });
    console.log(`scale ${scale}: ${bodies.map((b) => `body${b.idx} ${(b.scaleM * 2).toFixed(0)}m wide-ish, ${b.plan.strokes.length} strokes`).join("; ")}`);

    // global sweep
    type Comp = { center: LatLng; seats: Seat[][]; score: number; linkM: number };
    const comps: Comp[] = [];
    let tried = 0, noSeat = 0, noLink = 0;
    for (let lat = LAT0; lat <= LAT1; lat += STEP) {
      for (let lng = LNG0; lng <= LNG1; lng += STEP * 1.25) {
        tried++;
        const seatsPerBody: Seat[][] = [];
        let ok = true;
        for (const b of bodies) {
          const nominal = place([b.unitCenter], [lat, lng], scale, ROT0)[0]!;
          const seats = bodySeats(g, b, nominal);
          if (!seats.length) { ok = false; break; }
          seatsPerBody.push(seats);
        }
        if (!ok) { noSeat++; continue; }
        seatsPerBody.forEach((arr, i) => (seatsPerBody[i] = arr.slice(0, 12)));
        // joint choice: best-scoring seat pair whose footprints do not overlap
        if (bodies.length === 2) {
          const n0 = place([bodies[0]!.unitCenter], [lat, lng], scale, ROT0)[0]!;
          const n1 = place([bodies[1]!.unitCenter], [lat, lng], scale, ROT0)[0]!;
          const relNominal: [number, number] = [n1[0] - n0[0], n1[1] - n0[1]];
          let bestPair: [Seat, Seat] | null = null, bestScore = Infinity;
          for (const s0 of seatsPerBody[0]!) for (const s1 of seatsPerBody[1]!) {
            if (boxesOverlap(bodyBox(bodies[0]!, s0), bodyBox(bodies[1]!, s1))) continue;
            // drift from the logo's own arrangement costs like a bad street fit
            const drift = meters([s0.center[0] + relNominal[0], s0.center[1] + relNominal[1]], s1.center);
            if (drift > DRIFT_CAP) continue;
            const sc = s0.score + s1.score + drift * 0.03;
            if (sc < bestScore) { bestScore = sc; bestPair = [s0, s1]; }
          }
          if (!bestPair) { noSeat++; continue; }
          seatsPerBody[0] = [bestPair[0]];
          seatsPerBody[1] = [bestPair[1]];
        }
        // link feasibility on the chosen seats
        let linkM = 0, linkOk = true;
        for (const l of split.links) {
          const ba = bodies[l.a]!, bb = bodies[l.b]!;
          const sa = seatsPerBody[l.a]![0]!, sb = seatsPerBody[l.b]![0]!;
          const A = attach(ba, sa, l.A);
          const B = attach(bb, sb, l.B);
          const straight = meters(A, B);
          const path = walk(g, nearestNode(g, A).id, nearestNode(g, B).id, straight * 3 + 2500);
          if (!path) { linkOk = false; break; }
          let m = 0;
          for (let i = 1; i < path.length; i++) m += meters(g.coord[path[i - 1]!]!, g.coord[path[i]!]!);
          if (m > straight * 2.6 + 800) { linkOk = false; break; }
          linkM += m;
        }
        if (!linkOk) { noLink++; continue; }
        comps.push({ center: [lat, lng], seats: seatsPerBody, score: seatsPerBody.reduce((s, arr) => s + arr[0]!.score, 0) + linkM / 200, linkM });
      }
    }
    console.log(`  compositions tried ${tried}: no seat ${noSeat}, no link ${noLink}, legal ${comps.length}`);
    comps.sort((a, b) => a.score - b.score);
    const shortlist: Comp[] = [];
    for (const c of comps) {
      if (shortlist.length >= MAX_ROUTE) break;
      if (shortlist.some((p) => meters(p.center, c.center) < 1000)) continue;
      shortlist.push(c);
    }

    for (const comp of shortlist) {
      // route each body at its best seats
      const bodiesRouted: { seat: Seat; r: Routed }[] = [];
      let fail = false;
      for (const b of bodies) {
        let best: { seat: Seat; r: Routed } | null = null;
        for (const seat of comp.seats[b.idx]!.slice(0, 2)) {
          const r = routePlacement(g, orderStrokes(b.plan.strokes), seat.center, b.scaleM, seat.rot);
          if (r && r.dropped <= 1 && (!best || r.fidelity < best.r.fidelity)) best = { seat, r };
        }
        if (!best) { console.log(`   body${b.idx}: no clean seat (strokes dropped)`); fail = true; break; }
        bodiesRouted.push(best);
      }
      if (fail) continue;
      // stitch: body order = link order (a then b), link walked between attachments
      const chain: LatLng[] = [];
      const isInk: boolean[] = [];
      const append = (pts: LatLng[], ink: boolean) => { for (const p of pts) { const last = chain[chain.length - 1]; if (last && last[0] === p[0] && last[1] === p[1]) continue; chain.push(p); isInk.push(ink); } };
      const order: number[] = [];
      for (const l of split.links) { if (!order.includes(l.a)) order.push(l.a); if (!order.includes(l.b)) order.push(l.b); }
      for (const b of bodies) if (!order.includes(b.idx)) order.push(b.idx);
      let linkM = 0, connM = 0;
      for (let oi = 0; oi < order.length; oi++) {
        const bi = order[oi]!;
        const br = bodiesRouted[bi]!;
        if (chain.length) {
          // connector: previous body end -> link A -> walk -> link B -> this body start
          const prev = order[oi - 1]!;
          const l = split.links.find((x) => (x.a === prev && x.b === bi) || (x.a === bi && x.b === prev));
          const from = nearestNode(g, chain[chain.length - 1]!).id;
          if (l) {
            const ba = bodies[l.a]!, bb = bodies[l.b]!;
            const sa = bodiesRouted[l.a]!.seat, sb = bodiesRouted[l.b]!.seat;
            const A = attach(ba, sa, l.A);
            const B = attach(bb, sb, l.B);
            const [P, Q, P0, Q0] = l.a === prev ? [A, B, l.A, l.B] : [B, A, l.B, l.A];
            const w1 = walk(g, from, nearestNode(g, P).id, 6000);
            const c2 = routeLink(g, l.polyline, P0, Q0, P, Q);
            const w3 = c2 ? walk(g, nearestNode(g, c2[c2.length - 1]!).id, nearestNode(g, br.r.chain[0]!).id, 6000) : null;
            if (!w1 || !c2 || !w3) { fail = true; break; }
            const c1 = w1.map((k) => g.coord[k]!), c3 = w3.map((k) => g.coord[k]!);
            for (let i = 1; i < c1.length; i++) connM += meters(c1[i - 1]!, c1[i]!);
            for (let i = 1; i < c2.length; i++) linkM += meters(c2[i - 1]!, c2[i]!);
            for (let i = 1; i < c3.length; i++) connM += meters(c3[i - 1]!, c3[i]!);
            append(c1, false); append(c2, true); append(c3, false);
          } else {
            const wpath = walk(g, from, nearestNode(g, br.r.chain[0]!).id, 12000);
            if (!wpath) { fail = true; break; }
            const c = wpath.map((k) => g.coord[k]!);
            for (let i = 1; i < c.length; i++) connM += meters(c[i - 1]!, c[i]!);
            append(c, false);
          }
        }
        for (let i = 0; i < br.r.chain.length; i++) append([br.r.chain[i]!], br.r.isInk[i] ?? true);
      }
      if (fail || chain.length < 20) continue;
      if (DISC) {
        // badge disc: a circle enclosing both bodies, drawn last as a closed ring
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        for (const p of chain) { if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0]; if (p[1] < minLng) minLng = p[1]; if (p[1] > maxLng) maxLng = p[1]; }
        const cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
        const halfH = ((maxLat - minLat) / 2) * 111320, halfW = ((maxLng - minLng) / 2) * 111320 * Math.cos((cLat * Math.PI) / 180);
        const radius = Math.hypot(halfW, halfH) * 0.92 + 250;
        const circle: UnitPt[] = [];
        for (let i = 0; i <= 48; i++) { const a = (i / 48) * 2 * Math.PI; circle.push([Math.cos(a), Math.sin(a)]); }
        const info = localGridInfo(g, [cLat, cLng]);
        const ring = routePlacement(g, [{ kind: "outline", pts: circle, closed: true }], [cLat, cLng], radius, info?.rot ?? 0, true);
        if (ring && ring.dropped === 0 && ring.maxGap < 400) {
          const from = nearestNode(g, chain[chain.length - 1]!).id;
          const w1 = walk(g, from, nearestNode(g, ring.chain[0]!).id, 6000);
          if (w1) {
            const c1 = w1.map((k) => g.coord[k]!);
            for (let i = 1; i < c1.length; i++) connM += meters(c1[i - 1]!, c1[i]!);
            append(c1, false);
            for (let i = 0; i < ring.chain.length; i++) append([ring.chain[i]!], true);
          }
        } else console.log("   disc: could not route the ring");
      }
      let km = 0;
      for (let i = 1; i < chain.length; i++) km += meters(chain[i - 1]!, chain[i]!);
      km /= 1000;
      const fidelity = bodiesRouted.reduce((s, x) => s + x.r.fidelity, 0) / bodiesRouted.length + connM / 300;
      const routed: Routed = { chain, isInk, km, inkKm: 0, connectorKm: connM / 1000, visibleConnKm: 0, dropped: bodiesRouted.reduce((s, x) => s + x.r.dropped, 0), strokes: 0, maxGap: 0, devM: 0, fidelity };
      results.push({ scale, center: comp.center, routed, bodiesRouted, linkKm: linkM / 1000, km, fidelity });
      if (LINKLOG.length) { console.log(`   ${LINKLOG.join(" | ")}`); LINKLOG.length = 0; }
      {
        const n0 = place([bodies[0]!.unitCenter], comp.center, scale, ROT0)[0]!, n1 = place([bodies[1]!.unitCenter], comp.center, scale, ROT0)[0]!;
        const s0 = bodiesRouted[0]!.seat.center, s1 = bodiesRouted[1]!.seat.center;
        console.log(`   seats: body0 drift ${meters(n0, s0).toFixed(0)} m, body1 drift ${meters(n1, s1).toFixed(0)} m, gap ${meters(s0, s1).toFixed(0)} m (nominal ${meters(n0, n1).toFixed(0)} m)`);
      }
      console.log(`  comp @${comp.center.map((v) => v.toFixed(3)).join(",")} scale ${scale}: ${km.toFixed(1)} km (link ${(linkM / 1000).toFixed(1)}, connectors ${(connM / 1000).toFixed(1)}), bodies ${bodiesRouted.map((x) => `fid ${x.r.fidelity.toFixed(0)} rot ${x.seat.rot}`).join(" / ")}, fidelity ${fidelity.toFixed(1)}`);
    }
  }

  results.sort((a, b) => a.fidelity - b.fidelity);
  if (!results.length) { console.log("no legal composition"); return; }
  // the blind judge picks, not the proxy: score the top candidates by likeness
  const scored: { r: (typeof results)[number]; like: number[]; jpg: Buffer }[] = [];
  if (JUDGE && KEY) {
    const up = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(IMG!).flatten({ background: "#fff" }).resize({ width: 700 }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
    for (const r of results.slice(0, JUDGE_TOP)) {
      const jpg = await paleRender(r.routed.chain, path.join(OUT, `cand-${scored.length}.png`));
      const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } };
      const like: number[] = [];
      const reasons: string[] = [];
      for (let i = 0; i < 3; i++) {
        const t = await claude([up, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as an orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1 to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color or background. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }]);
        like.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
        reasons.push((t.match(/REASON:\s*(.+)/i)?.[1] ?? "").trim());
      }
      console.log(`  cand ${scored.length}: scale ${r.scale} @${r.center.map((v) => v.toFixed(3)).join(",")} ${r.km.toFixed(1)} km fid ${r.fidelity.toFixed(0)} -> likeness ${like.join("/")}  [${reasons.join(" | ")}]`);
      scored.push({ r, like, jpg });
    }
    scored.sort((a, b) => b.like.reduce((x, y) => x + y, 0) - a.like.reduce((x, y) => x + y, 0));
  }
  const picks = scored.length ? scored.slice(0, PICKS).map((x) => x.r) : results.slice(0, PICKS);
  const summary: object[] = [];
  for (let k = 0; k < picks.length; k++) {
    const pk = picks[k]!;
    const tag = `${NAME}-${k}`;
    const gpx = pk.routed.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(path.join(OUT, `${tag}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso composition" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${tag}</name><trkseg>\n${gpx}\n</trkseg></trk></gpx>\n`);
    const jpg = await paleRender(pk.routed.chain, path.join(OUT, `${tag}.png`));
    await paleRender(pk.routed.chain, path.join(OUT, `${tag}-dbg.png`), pk.routed.isInk);
    console.log(`pick ${k}: scale ${pk.scale} @${pk.center.map((v) => v.toFixed(3)).join(",")} | ${pk.km.toFixed(1)} km, link ${pk.linkKm.toFixed(1)} km, fidelity ${pk.fidelity.toFixed(1)}`);
    let j: { cold: { guess: string; conf: number }[]; like: number[] } | null = null;
    if (JUDGE && KEY) {
      j = await judge(jpg, IMG!);
      console.log(`   cold: ${j.cold.map((c) => `${c.guess} (${c.conf})`).join(" / ")}   likeness: ${j.like.join("/")}`);
    }
    summary.push({ pick: k, scale: pk.scale, center: pk.center, km: pk.km, linkKm: pk.linkKm, fidelity: pk.fidelity, bodies: pk.bodiesRouted.map((x) => ({ seat: x.seat, fidelity: x.r.fidelity, km: x.r.km })), judge: j });
  }
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
