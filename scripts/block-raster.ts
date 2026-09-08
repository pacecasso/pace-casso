/**
 * BLOCK RASTER RIG — the grid is the canvas (Sep 8, Ralph's $50 attempt).
 *
 * For each candidate seat on the NYC walk graph: read the local grid
 * (axis + block pitch along both directions), cut the upload's silhouette
 * into block-sized cells at the requested span, take the boundary loops of
 * the inked cells (holes kept, thin parts kept as one-cell corridors), map
 * the lattice corners onto real intersections and walk between them on
 * real streets. Retracing is allowed. No model calls unless --judge.
 *
 * Usage:
 *   npx tsx scripts/block-raster.ts gas.png --mask=blue --span=7000 [--name=gas-br]
 *      [--lat=40.60,40.80] [--lng=-74.02,-73.80] [--step=500] [--picks=8]
 *      [--seat=40.66,-73.94] [--thr=0.3] [--thin=0.1]
 *      [--judge --expect="gas pump,fuel,gasoline,petrol"]
 *
 * Spend ledger: tmp-blockraster/ledger.json — judge calls refuse past the cap.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { LatLng } from "../lib/streetGraphTrace";
import { localGridInfo, nearestNode, walk, meters, type PainterGraph } from "../lib/strokePainter";
import { rasterizeMask, boundaryLoops, cellStats, loopLength, type LatticePt, type Cells } from "../lib/blockRaster";
import { cleanupRouteSpurs } from "../lib/routeSpurCleanup";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
if (!IMG) {
  console.log("usage: npx tsx scripts/block-raster.ts <image> --mask=blue --span=7000");
  process.exit(1);
}
const NAME = opt("name", path.basename(IMG).replace(/\.[^.]+$/, "") + "-br");
const MASK_MODE = opt("mask", "ink");
const SPANS = opt("span", "7000").split(",").map(Number);
const [LAT0, LAT1] = opt("lat", "40.60,40.80").split(",").map(Number) as [number, number];
const [LNG0, LNG1] = opt("lng", "-74.02,-73.80").split(",").map(Number) as [number, number];
const STEP = Number(opt("step", "500"));
const PICKS = Number(opt("picks", "8"));
const SEAT = opt("seat", "");
const THR = Number(opt("thr", "0.3"));
const THIN = Number(opt("thin", "0.1"));
const VOIDMAX = Number(opt("voidmax", "0.05"));
const COVMIN = Number(opt("covmin", "0.9"));
const GRAPH = opt("graph", "tmp-painter/nyc-core-walk-graph.json");
const JUDGE = flag("judge");
const VERIFY = flag("verify");
const EXPECT = opt("expect", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const JUDGES = Number(opt("judges", "3"));
const MODEL = "claude-fable-5";
const CAP_USD = Number(opt("cap", "45"));
const OUT = path.join(process.cwd(), "tmp-blockraster", NAME);
const LEDGER = path.join(process.cwd(), "tmp-blockraster", "ledger.json");
const BOX = 400;

// ---------------------------------------------------------------------------
// mask + graph (same readers as the finisher rig)
// ---------------------------------------------------------------------------
async function loadMask(file: string, mode: string): Promise<{ mask: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(file)
    .resize(BOX, BOX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width as number;
  const h = info.height as number;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let ink = false;
    if (mode === "blue") ink = a > 128 && b > 60 && b > r * 1.25 && b > g * 1.25;
    else if (mode === "dark") ink = a > 128 && lum < 110;
    else ink = a > 128 && lum < 200;
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
/**
 * Snap grids restricted to the graph's giant connected component: a corner
 * that lands on a disconnected fragment (parking lot, pier, private road)
 * can never be walked to. Intersections (degree >= 3) first, any giant
 * node as a fallback.
 */
let INT_GRID: Map<string, number[]> | null = null;
let ANY_GRID: Map<string, number[]> | null = null;
function buildSnapGrids(g: PainterGraph): void {
  const n = g.coord.length;
  const comp = new Int32Array(n).fill(-1);
  let bestC = -1;
  let bestN = 0;
  let cid = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (comp[s0] >= 0) continue;
    const stack = [s0];
    comp[s0] = cid;
    let cnt = 0;
    while (stack.length) {
      const u = stack.pop()!;
      cnt++;
      for (const { to } of g.adj[u]!)
        if (comp[to] < 0) {
          comp[to] = cid;
          stack.push(to);
        }
    }
    if (cnt > bestN) {
      bestN = cnt;
      bestC = cid;
    }
    cid++;
  }
  INT_GRID = new Map();
  ANY_GRID = new Map();
  for (let i = 0; i < n; i++) {
    if (comp[i] !== bestC) continue;
    const k = `${Math.round(g.coord[i]![0] / CELL)}:${Math.round(g.coord[i]![1] / CELL)}`;
    if (!ANY_GRID.has(k)) ANY_GRID.set(k, []);
    ANY_GRID.get(k)!.push(i);
    if (g.adj[i]!.length < 3) continue;
    if (!INT_GRID.has(k)) INT_GRID.set(k, []);
    INT_GRID.get(k)!.push(i);
  }
  console.log(`giant component: ${bestN} of ${n} nodes`);
}
function nearestIn(grid: Map<string, number[]>, g: PainterGraph, p: LatLng, maxR: number): { id: number; d: number } {
  const clat = Math.round(p[0] / CELL);
  const clng = Math.round(p[1] / CELL);
  let best = -1;
  let bd = Infinity;
  for (let r = 1; r <= maxR && best < 0; r++)
    for (let dr = -r; dr <= r; dr++)
      for (let dc = -r; dc <= r; dc++)
        for (const id of grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
          const d = meters(p, g.coord[id]!);
          if (d < bd) {
            bd = d;
            best = id;
          }
        }
  return { id: best, d: bd };
}
function nearestIntersection(g: PainterGraph, p: LatLng): { id: number; d: number } {
  if (!INT_GRID || !ANY_GRID) buildSnapGrids(g);
  const a = nearestIn(INT_GRID!, g, p, 2);
  if (a.id >= 0) return a;
  const b = nearestIn(ANY_GRID!, g, p, 4);
  return b.id >= 0 ? b : nearestNode(g, p);
}

// ---------------------------------------------------------------------------
// local grid: axis and block pitch along a direction
// ---------------------------------------------------------------------------
const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);
type Vec = [number, number]; // east, north (meters)
const toLatLng = (c: LatLng, v: Vec): LatLng => [c[0] + v[1] / M_PER_LAT, c[1] + v[0] / mPerLng(c[0])];

function nodesNear(g: PainterGraph, c: LatLng, radiusM: number): number[] {
  const out: number[] = [];
  const clat = Math.round(c[0] / CELL);
  const clng = Math.round(c[1] / CELL);
  const r = Math.ceil(radiusM / 300) + 1;
  for (let dr = -r; dr <= r; dr++)
    for (let dc = -r; dc <= r; dc++)
      for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) if (meters(c, g.coord[id]!) <= radiusM) out.push(id);
  return out;
}

/**
 * Real street lines crossing direction `dir` inside a rectangle around c:
 * projections of intersection nodes (degree >= 3) onto `dir`, binned, peaks
 * kept. Returns line offsets in meters from c, ascending.
 */
function streetLines(g: PainterGraph, c: LatLng, dir: Vec, perp: Vec, halfAlong: number, halfPerp: number, ids: number[]): number[] {
  const BIN = 25;
  const bins = new Map<number, { n: number; sum: number }>();
  let maxN = 0;
  for (const id of ids) {
    if (g.adj[id]!.length < 3) continue;
    const p = g.coord[id]!;
    const dx = (p[1] - c[1]) * mPerLng(c[0]);
    const dy = (p[0] - c[0]) * M_PER_LAT;
    const t = dx * dir[0] + dy * dir[1];
    const u = dx * perp[0] + dy * perp[1];
    if (Math.abs(t) > halfAlong + 120 || Math.abs(u) > halfPerp) continue;
    const b = Math.round(t / BIN);
    const e = bins.get(b) ?? { n: 0, sum: 0 };
    e.n++;
    e.sum += t;
    bins.set(b, e);
    if (e.n > maxN) maxN = e.n;
  }
  // peaks: bins stronger than both neighbours and above a floor
  const floor = Math.max(4, 0.18 * maxN);
  const peaks: { t: number; n: number }[] = [];
  for (const [b, e] of bins) {
    if (e.n < floor) continue;
    const l = bins.get(b - 1)?.n ?? 0;
    const r = bins.get(b + 1)?.n ?? 0;
    if (e.n >= l && e.n >= r) peaks.push({ t: e.sum / e.n, n: e.n });
  }
  peaks.sort((a, b) => a.t - b.t);
  // merge peaks closer than 45 m (keep the stronger)
  const lines: { t: number; n: number }[] = [];
  for (const pk of peaks) {
    const last = lines[lines.length - 1];
    if (last && pk.t - last.t < 45) {
      if (pk.n > last.n) lines[lines.length - 1] = pk;
    } else lines.push(pk);
  }
  return lines.map((l) => l.t);
}

type Seat = {
  center: LatLng;
  span: number;
  up: Vec;
  right: Vec;
  /** column / row line offsets from center in meters */
  xs: number[];
  ys: number[];
  cols: number;
  rows: number;
  cells: Cells;
  loops: LatticePt[][];
  coverage: number;
  uniform: number;
  axisDeg: number;
  voidFrac: number;
};

function buildSeat(g: PainterGraph, c: LatLng, span: number, bbox: { w: number; h: number }, mask: { mask: Uint8Array; w: number; h: number }): Seat | null {
  const info = localGridInfo(g, c);
  if (!info) return null;
  const s = span / Math.max(bbox.w, bbox.h);
  const widthM = bbox.w * s;
  const heightM = bbox.h * s;
  const ids = nodesNear(g, c, Math.hypot(widthM, heightM) / 2 + 150);
  // refine the axis around the coarse estimate: the sharpest line peaks win
  let bestAxis = info.axis;
  let bestScore = -1;
  let bestLines: { xs: number[]; ys: number[]; up: Vec; right: Vec } | null = null;
  for (let da = -1.5; da <= 1.5; da += 0.5) {
    const a = ((info.axis + da) * Math.PI) / 180;
    const A: Vec = [Math.sin(a), Math.cos(a)];
    const B: Vec = [Math.cos(a), -Math.sin(a)];
    const cands: Vec[] = [A, [-A[0], -A[1]], B, [-B[0], -B[1]]];
    let up = cands[0]!;
    for (const v of cands) if (v[1] > up[1]) up = v;
    const right: Vec = [up[1], -up[0]];
    const xs = streetLines(g, c, right, up, widthM / 2, heightM / 2, ids);
    const ys = streetLines(g, c, up, right, heightM / 2, widthM / 2, ids);
    const score = xs.length + ys.length;
    if (score > bestScore) {
      bestScore = score;
      bestAxis = info.axis + da;
      bestLines = { xs, ys, up, right };
    }
  }
  if (!bestLines) return null;
  const { up, right } = bestLines;
  // the lines must span the whole footprint with no large gaps: a lattice
  // that only exists on one side of the center (shoreline) or skips a park
  // would silently squeeze or stretch the image
  const inside = (lines: number[], half: number) => {
    const inn = lines.filter((t) => Math.abs(t) <= half);
    if (inn.length < 5) return null;
    const gaps = inn.slice(1).map((t, i) => t - inn[i]!).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)]!;
    if (inn[0]! > -half + 1.2 * med || inn[inn.length - 1]! < half - 1.2 * med) return null;
    if (gaps[gaps.length - 1]! > 2.6 * med) return null;
    return inn;
  };
  const xs = inside(bestLines.xs, widthM / 2);
  const ys = inside(bestLines.ys, heightM / 2);
  if (!xs || !ys) return null;
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  const norm = (lines: number[]) => {
    const a = lines[0]!;
    const b = lines[lines.length - 1]!;
    return lines.map((t) => (t - a) / (b - a));
  };
  const cells = rasterizeMask(mask.mask, mask.w, mask.h, cols, rows, { threshold: THR, thinThreshold: THIN, xBreaks: norm(xs), yBreaks: norm(ys) });
  const loops = boundaryLoops(cells);
  if (!loops.length) return null;
  const seat: Seat = { center: c, span, up, right, xs, ys, cols, rows, cells, loops, coverage: 0, uniform: info.uniform, axisDeg: bestAxis, voidFrac: 1 };
  // corner coverage: each inked cell's corners must sit on real
  // intersections; a cell with two or more void corners is a park, water
  // or a grid change — one such cell in fifty sinks the seat
  let hit = 0;
  let total = 0;
  let voidCells = 0;
  let onCells = 0;
  const voidAt = new Map<number, boolean>();
  const isVoid = (x: number, y: number) => {
    const k = y * (cols + 1) + x;
    let v = voidAt.get(k);
    if (v === undefined) {
      v = nearestIntersection(g, latticeToLatLng(seat, x, y)).d > 45;
      voidAt.set(k, v);
      total++;
      if (!v) hit++;
    }
    return v;
  };
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (!cells.cells[j * cols + i]) continue;
      onCells++;
      let n = 0;
      if (isVoid(i, j)) n++;
      if (isVoid(i + 1, j)) n++;
      if (isVoid(i, j + 1)) n++;
      if (isVoid(i + 1, j + 1)) n++;
      if (n >= 2) voidCells++;
    }
  seat.coverage = total ? hit / total : 0;
  seat.voidFrac = onCells ? voidCells / onCells : 1;
  return seat;
}

function latticeToLatLng(seat: Seat, x: number, y: number): LatLng {
  const ex = seat.xs[x]!;
  const ey = seat.ys[y]!;
  const v: Vec = [ex * seat.right[0] + ey * seat.up[0], ex * seat.right[1] + ey * seat.up[1]];
  return toLatLng(seat.center, v);
}

// ---------------------------------------------------------------------------
// routing: lattice loops -> real streets, retracing allowed
// ---------------------------------------------------------------------------
const NODE_STRIDE = 1_000_000;
const pitchX = (s: Seat) => (s.xs[s.xs.length - 1]! - s.xs[0]!) / s.cols;
const pitchY = (s: Seat) => (s.ys[s.ys.length - 1]! - s.ys[0]!) / s.rows;
const edgeKey = (u: number, v: number) => (u < v ? u * NODE_STRIDE + v : v * NODE_STRIDE + u);
type Routed = { chain: LatLng[]; km: number; inkKm: number; connKm: number; detour: number; loops: number };
let lastFail = "";

function routeSeat(g: PainterGraph, seat: Seat): Routed | null {
  const painted = new Set<number>();
  const chain: number[] = [];
  let inkM = 0;
  let connM = 0;
  let latticeM = 0;
  const appendPath = (p: number[], ink: boolean) => {
    for (let i = 0; i < p.length; i++) {
      const id = p[i]!;
      const last = chain[chain.length - 1];
      if (last === id) continue;
      if (last !== undefined) {
        const m = meters(g.coord[last]!, g.coord[id]!);
        if (ink) inkM += m;
        else connM += m;
        painted.add(edgeKey(last, id));
      }
      chain.push(id);
    }
  };
  // snap each loop's corners
  const snapped = seat.loops.map((loop) => loop.map(([x, y]) => nearestIntersection(g, latticeToLatLng(seat, x, y)).id));
  // order loops: biggest first, then nearest unrouted loop to the current end
  const order = seat.loops.map((_, i) => i).sort((a, b) => loopLength(seat.loops[b]!, pitchX(seat), pitchY(seat)) - loopLength(seat.loops[a]!, pitchX(seat), pitchY(seat)));
  const done = new Set<number>();
  let cur = order[0]!;
  let loopsRouted = 0;
  while (done.size < order.length) {
    const ids = snapped[cur]!;
    const loop = seat.loops[cur]!;
    // start the loop at the corner nearest the current chain end
    let startK = 0;
    if (chain.length) {
      let best = Infinity;
      ids.forEach((id, k) => {
        const d = meters(g.coord[chain[chain.length - 1]!]!, g.coord[id]!);
        if (d < best) {
          best = d;
          startK = k;
        }
      });
      const conn = walk(g, chain[chain.length - 1]!, ids[startK]!, 6000, painted);
      if (!conn) {
        lastFail = `connector to loop ${cur} failed`;
        return null;
      }
      appendPath(conn, false);
    }
    for (let s = 0; s <= ids.length; s++) {
      const k0 = (startK + s) % ids.length;
      const k1 = (startK + s + 1) % ids.length;
      const a = ids[k0]!;
      const b = ids[k1]!;
      const straight = meters(g.coord[a]!, g.coord[b]!);
      const latM = Math.abs(seat.xs[loop[k1]![0]]! - seat.xs[loop[k0]![0]]!) + Math.abs(seat.ys[loop[k1]![1]]! - seat.ys[loop[k0]![1]]!);
      latticeM += latM;
      const p = walk(g, a, b, Math.max(300, 2.2 * straight + 200)) ?? walk(g, a, b, 4 * straight + 600);
      if (!p) {
        lastFail = `loop ${cur} edge ${s}/${ids.length} straight ${straight.toFixed(0)} m unwalkable`;
        return null;
      }
      appendPath(p, true);
      if (s === ids.length - 1) break;
    }
    loopsRouted++;
    done.add(cur);
    // next: nearest undone loop by corner distance to chain end
    let next = -1;
    let best = Infinity;
    for (const li of order) {
      if (done.has(li)) continue;
      for (const id of snapped[li]!) {
        const d = meters(g.coord[chain[chain.length - 1]!]!, g.coord[id]!);
        if (d < best) {
          best = d;
          next = li;
        }
      }
    }
    if (next < 0) break;
    cur = next;
  }
  const total = inkM + connM;
  // snap artefacts: a corner that landed one node off the lattice makes a
  // short out-and-back stub; trim those (short spurs only, so the raster's
  // own one-cell corridors survive)
  const raw = chain.map((id) => g.coord[id]!);
  const cleaned = cleanupRouteSpurs({ coordinates: raw }, { maxSpurMeters: 140, maxReturnMeters: 60, minSavingsMeters: 40, minSavingsRatio: 0.5 });
  return {
    chain: cleaned.route.coordinates,
    km: total / 1000,
    inkKm: inkM / 1000,
    connKm: connM / 1000,
    detour: latticeM ? inkM / latticeM : 9,
    loops: loopsRouted,
  };
}

// ---------------------------------------------------------------------------
// render (pale basemap, Strava-orange line) — same as the finisher rig
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
async function paleRender(chain: LatLng[], file: string): Promise<Buffer> {
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
  return sharp(file).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
}

// ---------------------------------------------------------------------------
// judge with a hard spend ledger
// ---------------------------------------------------------------------------
type Ledger = { calls: number; usd: number; log: string[] };
async function readLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await fs.readFile(LEDGER, "utf8")) as Ledger;
  } catch {
    return { calls: 0, usd: 0, log: [] };
  }
}
async function writeLedger(l: Ledger): Promise<void> {
  await fs.mkdir(path.dirname(LEDGER), { recursive: true });
  await fs.writeFile(LEDGER, JSON.stringify(l, null, 1));
}
let KEY = "";
async function claude(content: unknown[], maxTokens = 1200): Promise<string> {
  const ledger = await readLedger();
  if (ledger.usd >= CAP_USD) throw new Error(`SPEND CAP: ledger at $${ledger.usd.toFixed(2)} >= $${CAP_USD}`);
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, output_config: { effort: "low" }, messages: [{ role: "user", content }] }),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
        continue;
      }
      const j = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
        error?: { message?: string };
      };
      const u = j.usage ?? {};
      const usd = (u.input_tokens ?? 0) * 10e-6 + (u.output_tokens ?? 0) * 50e-6 + (u.cache_creation_input_tokens ?? 0) * 12.5e-6 + (u.cache_read_input_tokens ?? 0) * 1e-6;
      const l = await readLedger();
      l.calls++;
      l.usd += usd;
      l.log.push(`${new Date().toISOString()} ${NAME} in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} $${usd.toFixed(4)} total=$${l.usd.toFixed(2)}`);
      await writeLedger(l);
      if (j.error) throw new Error(j.error.message ?? "api error");
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    } catch (e) {
      if (String(e).includes("SPEND CAP")) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
    }
  }
  return "";
}
const COLD_PROMPT =
  "The orange line is a GPS route someone recorded while running; they were trying to draw a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or \"nothing recognizable\">\nCONFIDENCE: <0-10>";
async function coldName(renderJpg: Buffer, n: number): Promise<{ guess: string; conf: number }[]> {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: renderJpg.toString("base64") } };
  const out: { guess: string; conf: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = await claude([img, { type: "text", text: COLD_PROMPT }]);
    const guess = (t.match(/GUESS\**:?\**\s*(.+?)\s*(?:\n|\*|CONFIDENCE|$)/i)?.[1] ?? "").trim();
    out.push({ guess: guess || "?", conf: Number(t.match(/CONFIDENCE\**:?\**\s*(\d+)/i)?.[1] ?? 0) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapbox gate (same as the studio rig): every <=24-waypoint leg must route
// and the walked distance must stay within 12% of the chain
// ---------------------------------------------------------------------------
let MAPBOX = "";
async function mapboxVerify(chain: LatLng[]): Promise<{ ok: boolean; walkKm: number; chainKm: number; failedLegs: number }> {
  if (!MAPBOX) {
    const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
    MAPBOX = env.match(/^MAPBOX_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim() ?? env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
    if (!MAPBOX) throw new Error("no Mapbox token in .env.local");
  }
  let chainM = 0;
  for (let i = 1; i < chain.length; i++) chainM += meters(chain[i - 1]!, chain[i]!);
  const way: LatLng[] = [chain[0]!];
  let acc = 0;
  for (let i = 1; i < chain.length; i++) {
    acc += meters(chain[i - 1]!, chain[i]!);
    if (acc >= 180 || i === chain.length - 1) {
      way.push(chain[i]!);
      acc = 0;
    }
  }
  let walkM = 0;
  let failedLegs = 0;
  for (let i = 0; i < way.length - 1; i += 23) {
    const seg = way.slice(i, Math.min(way.length, i + 24));
    if (seg.length < 2) break;
    const coords = seg.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
    const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}?geometries=geojson&overview=false&access_token=${MAPBOX}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failedLegs++;
        continue;
      }
      const json = (await res.json()) as { code?: string; routes?: { distance: number }[] };
      if (json.code !== "Ok" || !json.routes?.[0]) {
        failedLegs++;
        continue;
      }
      walkM += json.routes[0].distance;
    } catch {
      failedLegs++;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  const walkKm = walkM / 1000;
  const chainKm = chainM / 1000;
  return { ok: failedLegs === 0 && walkKm > 0 && Math.abs(walkKm - chainKm) / chainKm < 0.12, walkKm, chainKm, failedLegs };
}

// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const m = await loadMask(IMG!, MASK_MODE);
  let minX = m.w, maxX = -1, minY = m.h, maxY = -1;
  for (let i = 0; i < m.w * m.h; i++) {
    if (m.mask[i] !== 255) continue;
    const x = i % m.w, y = (i / m.w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bbox = { w: maxX - minX + 1, h: maxY - minY + 1 };
  console.log(`mask ${m.w}x${m.h} ink bbox ${bbox.w}x${bbox.h}`);
  const g = await loadPackedGraph(GRAPH);
  console.log(`graph ${g.coord.length} nodes`);

  // seat sweep (no model calls)
  const centers: LatLng[] = [];
  if (SEAT) centers.push(SEAT.split(",").map(Number) as LatLng);
  else {
    const dLat = STEP / M_PER_LAT;
    for (let lat = LAT0; lat <= LAT1; lat += dLat) {
      const dLng = STEP / mPerLng(lat);
      for (let lng = LNG0; lng <= LNG1; lng += dLng) centers.push([lat, lng]);
    }
  }
  console.log(`sweeping ${centers.length} centers x ${SPANS.length} spans`);
  const t0 = Date.now();
  const seats: Seat[] = [];
  let bestRaw: Seat | null = null;
  let built = 0;
  const allSeats: Seat[] = [];
  for (const span of SPANS)
    for (const c of centers) {
      const s = buildSeat(g, c, span, bbox, m);
      if (!s) continue;
      built++;
      allSeats.push(s);
      if (!bestRaw || s.coverage - s.voidFrac > bestRaw.coverage - bestRaw.voidFrac) bestRaw = s;
      if (SEAT || (s.coverage >= COVMIN && s.voidFrac <= VOIDMAX)) seats.push(s);
    }
  if (bestRaw) console.log(`built ${built} seats; best raw: coverage ${(bestRaw.coverage * 100).toFixed(0)}% void ${(bestRaw.voidFrac * 100).toFixed(1)}% at ${bestRaw.center.map((v) => v.toFixed(4)).join(",")} span ${bestRaw.span} cells ${bestRaw.cols}x${bestRaw.rows}`);
  seats.sort((a, b) => b.coverage - b.voidFrac - (a.coverage - a.voidFrac) || b.uniform - a.uniform);
  allSeats.sort((a, b) => b.coverage - b.voidFrac - (a.coverage - a.voidFrac));
  for (const s of allSeats.slice(0, 6)) console.log(`  raw: cov ${(s.coverage * 100).toFixed(0)}% void ${(s.voidFrac * 100).toFixed(1)}% at ${s.center.map((v) => v.toFixed(4)).join(",")} span ${s.span} cells ${s.cols}x${s.rows} uni ${(s.uniform * 100).toFixed(0)}%`);
  console.log(`${seats.length} seats passing coverage/void floors in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (SEAT && seats.length) {
    const s = seats[0]!;
    console.log(`  xs (${s.xs.length}): ${s.xs.map((v) => v.toFixed(0)).join(" ")}`);
    console.log(`  ys (${s.ys.length}): ${s.ys.map((v) => v.toFixed(0)).join(" ")}`);
    console.log(`  up ${s.up.map((v) => v.toFixed(2)).join(",")} right ${s.right.map((v) => v.toFixed(2)).join(",")} axis ${s.axisDeg}`);
  }
  if (seats.length) {
    const s = seats[0]!;
    const st = cellStats(s.cells);
    console.log(`best coverage seat: ${s.center.map((v) => v.toFixed(4)).join(",")} span ${s.span} pitch ${pitchX(s).toFixed(0)}x${pitchY(s).toFixed(0)} axis ${s.axisDeg} cells ${s.cols}x${s.rows} on ${st.on} comps ${st.components} loops ${s.loops.length}`);
  }

  // route the best seats, keep diverse picks
  type Cand = { seat: Seat; r: Routed; score: number };
  const cands: Cand[] = [];
  const tried = { n: 0, failed: 0 };
  for (const seat of seats) {
    if (cands.length >= PICKS * 3 || tried.n >= 60) break;
    if (cands.some((c) => meters(c.seat.center, seat.center) < 1200 && c.seat.span === seat.span)) continue;
    tried.n++;
    const r = routeSeat(g, seat);
    if (!r || r.detour > 1.45) {
      tried.failed++;
      if (SEAT || tried.failed <= 3) console.log(`  seat ${seat.center.map((v) => v.toFixed(4)).join(",")} failed: ${r ? `detour ${r.detour.toFixed(2)}` : lastFail}`);
      continue;
    }
    // score: follow the lattice tightly, few connector km, dense grid
    const score = seat.coverage * 2 - (r.detour - 1) * 3 - r.connKm / Math.max(1, r.inkKm) + seat.uniform * 0.5;
    cands.push({ seat, r, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const picks = cands.slice(0, PICKS);
  console.log(`routed ${tried.n} seats, ${tried.failed} failed, ${picks.length} picks`);

  const summary: string[] = [];
  let ci = 0;
  for (const c of picks) {
    ci++;
    const tag = `cand-${String(ci).padStart(2, "0")}`;
    const st = cellStats(c.seat.cells);
    const jpg = await paleRender(c.r.chain, path.join(OUT, `${tag}.png`));
    const gpx = c.r.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(
      path.join(OUT, `${tag}.gpx`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso block raster" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${NAME} ${tag}</name><trkseg>\n${gpx}\n</trkseg></trk></gpx>\n`,
    );
    await fs.writeFile(path.join(OUT, `${tag}.json`), JSON.stringify({ seat: { ...c.seat, cells: undefined, loops: c.seat.loops }, routed: c.r }, null, 0));
    let line = `${tag}: ${c.seat.center.map((v) => v.toFixed(4)).join(",")} span ${c.seat.span} pitch ${pitchX(c.seat).toFixed(0)}x${pitchY(c.seat).toFixed(0)} axis ${c.seat.axisDeg} cells ${c.seat.cols}x${c.seat.rows} on ${st.on} comps ${st.components} loops ${c.r.loops} | ${c.r.km.toFixed(1)} km (ink ${c.r.inkKm.toFixed(1)}, conn ${c.r.connKm.toFixed(1)}) detour ${c.r.detour.toFixed(2)} cov ${(c.seat.coverage * 100).toFixed(0)}% void ${(c.seat.voidFrac * 100).toFixed(1)}% uni ${(c.seat.uniform * 100).toFixed(0)}% score ${c.score.toFixed(2)}`;
    if (JUDGE) {
      if (!KEY) {
        KEY = (await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8")).match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
        if (!KEY) throw new Error("ANTHROPIC_API_KEY missing in .env.local");
      }
      const names = await coldName(jpg, JUDGES);
      const ok = names.filter((n) => EXPECT.some((e) => n.guess.toLowerCase().includes(e)));
      const meanConf = names.reduce((s, n) => s + n.conf, 0) / Math.max(1, names.length);
      const pass = EXPECT.length > 0 && ok.length === names.length && meanConf >= 7;
      line += ` | cold: ${names.map((n) => `${n.guess} ${n.conf}`).join(" / ")} => ${pass ? "PASS" : `${ok.length}/${names.length} correct, conf ${meanConf.toFixed(1)}`}`;
    }
    if (VERIFY && (!JUDGE || line.includes("=> PASS"))) {
      const mv = await mapboxVerify(c.r.chain);
      line += ` | mapbox: ${mv.ok ? "OK" : "FAIL"} walk ${mv.walkKm.toFixed(1)} km vs chain ${mv.chainKm.toFixed(1)} km, ${mv.failedLegs} failed legs`;
    }
    console.log(line);
    summary.push(line);
  }
  await fs.writeFile(path.join(OUT, "summary.txt"), summary.join("\n") + "\n");
  if (JUDGE) {
    const l = await readLedger();
    console.log(`ledger: ${l.calls} calls, $${l.usd.toFixed(2)} of $${CAP_USD} cap`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
