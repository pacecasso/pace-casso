// GAS FINAL — the converged pipeline. Ralph's order: finalize the gas logo.
// Everything learned, in one file:
//  - hose SIMPLIFIED per Ralph (no coil; droop and rise)
//  - HYBRID compilation: pump+window corridor-snapped to the street lattice
//    (clean single-street edges), figure/hose/headphones fine-traced
//  - zone-uniformity check (lattices don't survive grid boundaries)
//  - piece-local nudges, joint ring rotation, street connectors
//  - gate: likeness-to-upload min ≥ 8 (3 samples) + Mapbox 0 failed legs
// Usage: npx tsx scripts/gas-final.ts [sweep|probe lat lng scale]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { traceContour, place, toUnit, type LatLng, type NormalizedPoint } from "../lib/streetGraphTrace";
import { renderMap } from "./trace-contour";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const OUT = "tmp-studio/gas-final";
let KEY = "";
let MAPBOX = "";

type P = [number, number];

// ---- the composition (blockified, Ralph's hose simplification) ----------
const pumpRing: P[] = [
  [0.07, 0.40], [0.33, 0.40], [0.33, 0.62],
  [0.28, 0.62], [0.28, 0.70], [0.33, 0.70],
  [0.33, 0.88], [0.37, 0.88], [0.37, 0.93], [0.03, 0.93], [0.03, 0.88], [0.07, 0.88],
  [0.07, 0.40],
];
const windowRing: P[] = [
  [0.105, 0.445], [0.295, 0.445], [0.295, 0.565], [0.105, 0.565], [0.105, 0.445],
];
const figRing: P[] = [
  [0.775, 0.36], [0.762, 0.325],
  [0.752, 0.325], [0.752, 0.245],
  [0.772, 0.215], [0.858, 0.215],
  [0.878, 0.245], [0.878, 0.325],
  [0.868, 0.325], [0.852, 0.36],
  [0.888, 0.40], [0.898, 0.60], [0.868, 0.60],
  [0.868, 0.885], [0.820, 0.885], [0.820, 0.625],
  [0.790, 0.625],
  [0.790, 0.885], [0.742, 0.885], [0.742, 0.60],
  [0.718, 0.60], [0.726, 0.46],
  [0.688, 0.455], [0.664, 0.408], [0.688, 0.372],
  [0.700, 0.352], [0.712, 0.318], [0.716, 0.286],
  [0.742, 0.286], [0.742, 0.322], [0.730, 0.352], [0.726, 0.382],
  [0.752, 0.402], [0.775, 0.36],
];
// Ralph, Aug 23: "the hose from the tank to the man is unnecessarily
// complicated" — no coil; one confident droop and rise.
const hose: P[] = [
  [0.305, 0.66],
  [0.38, 0.755], [0.47, 0.79], [0.55, 0.775],
  [0.615, 0.70], [0.648, 0.56], [0.664, 0.44], [0.678, 0.385], [0.694, 0.352],
];
const headphones: P[] = [
  [0.744, 0.330], [0.726, 0.330], [0.726, 0.240],
  [0.740, 0.192], [0.890, 0.192],
  [0.904, 0.240], [0.904, 0.330], [0.886, 0.330],
];
const PIECES: { name: string; pts: P[]; mode: "corridor" | "trace"; optional: boolean }[] = [
  { name: "pump", pts: pumpRing, mode: "corridor", optional: false },
  { name: "window", pts: windowRing, mode: "corridor", optional: true },
  { name: "hose", pts: hose, mode: "trace", optional: false },
  { name: "figure", pts: figRing, mode: "trace", optional: false },
  { name: "headphones", pts: headphones, mode: "trace", optional: true },
];

// ---- infra ---------------------------------------------------------------
function meters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180, dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2));
}
async function loadBrooklyn(): Promise<any> {
  const data = JSON.parse(await fs.readFile("tmp-wow/brooklyn-walk-graph.json", "utf8"));
  const n = data.lat.length;
  const coord: LatLng[] = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = [data.lat[i] / data.scale, data.lng[i] / data.scale];
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < data.edges.length; e += 2) {
    const a = data.edges[e], b = data.edges[e + 1];
    const w = meters(coord[a], coord[b]);
    adj[a].push({ to: b, w });
    adj[b].push({ to: a, w });
  }
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i][0] / 0.003)}:${Math.round(coord[i][1] / 0.003)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid };
}
function nearestNode(g: any, p: LatLng): { id: number; d: number } {
  let best = -1, bd = Infinity;
  const CELL = 0.003;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const k = `${Math.round(p[0] / CELL) + dy}:${Math.round(p[1] / CELL) + dx}`;
    for (const i of (g.grid.get(k) ?? [])) {
      const d = meters(g.coord[i], p);
      if (d < bd) { bd = d; best = i; }
    }
  }
  return { id: best, d: bd };
}
function shortestPath(g: any, a: number, b: number): LatLng[] | null {
  if (a < 0 || b < 0) return null;
  const dist = new Map<number, number>([[a, 0]]);
  const came = new Map<number, number>();
  const open = new Map<number, number>([[a, meters(g.coord[a], g.coord[b])]]);
  const done = new Set<number>();
  let guard = 0;
  while (open.size && guard++ < 200000) {
    let cur = -1, cf = Infinity;
    for (const [n, f] of open) if (f < cf) { cf = f; cur = n; }
    if (cur === b) {
      const out = [b];
      let w = b;
      while (came.has(w)) { w = came.get(w)!; out.push(w); }
      return out.reverse().map((n) => g.coord[n]);
    }
    open.delete(cur);
    done.add(cur);
    for (const { to, w } of g.adj[cur] ?? []) {
      if (done.has(to)) continue;
      const t = dist.get(cur)! + w;
      if (t < (dist.get(to) ?? Infinity)) {
        dist.set(to, t);
        came.set(to, cur);
        open.set(to, t + meters(g.coord[to], g.coord[b]));
      }
    }
  }
  return null;
}
async function api(content: any[], mt = 1024): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-fable-5", max_tokens: mt, messages: [{ role: "user", content }] }),
      });
    } catch {
      await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    const json: any = await res.json();
    return (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
  }
  return "";
}

// ---- bearing + lattice ---------------------------------------------------
function bearingAt(g: any, center: LatLng, radiusM: number): number | null {
  const bins = new Array(90).fill(0);
  const CELL = 0.003;
  const span = Math.ceil(radiusM / 300);
  for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
    const k = `${Math.round(center[0] / CELL) + dy}:${Math.round(center[1] / CELL) + dx}`;
    for (const i of (g.grid.get(k) ?? [])) {
      if (meters(g.coord[i], center) > radiusM) continue;
      for (const { to, w } of g.adj[i] ?? []) {
        if (to < i || w < 40) continue;
        const dN = (g.coord[to][0] - g.coord[i][0]) * 111320;
        const dE = (g.coord[to][1] - g.coord[i][1]) * 111320 * Math.cos((g.coord[i][0] * Math.PI) / 180);
        const deg = ((Math.atan2(dE, dN) * 180) / Math.PI % 90 + 90) % 90;
        bins[Math.min(89, Math.floor(deg))] += w;
      }
    }
  }
  const total = bins.reduce((a, b) => a + b, 0);
  if (total < 5000) return null;
  let bestDeg = 0;
  for (let i = 1; i < 90; i++) if (bins[i] > bins[bestDeg]) bestDeg = i;
  const d = bestDeg + 0.5;
  return d <= 45 ? d : d - 90;
}

function compileAt(g: any, center: LatLng, scale: number): any {
  // zone uniformity: bearing must agree at center and 4 quadrant points
  const b0 = bearingAt(g, center, 900);
  if (b0 === null) return { fail: "sparse" };
  const off = scale * 0.55;
  for (const [dn, de] of [[off, off], [off, -off], [-off, off], [-off, -off]]) {
    const q: LatLng = [center[0] + dn / 111320, center[1] + de / (111320 * Math.cos((center[0] * Math.PI) / 180))];
    const bq = bearingAt(g, q, 700);
    if (bq === null) return { fail: "sparse" };
    let diff = Math.abs(bq - b0);
    if (diff > 45) diff = 90 - diff;
    if (diff > 4) return { fail: "zones" };
  }
  const rot = b0;
  const bearingRad = (rot * Math.PI) / 180;
  const mLat = 111320, mLng = 111320 * Math.cos((center[0] * Math.PI) / 180);
  const toUV = (p: LatLng): [number, number] => {
    const dN = (p[0] - center[0]) * mLat, dE = (p[1] - center[1]) * mLng;
    return [dE * Math.cos(bearingRad) - dN * Math.sin(bearingRad), dE * Math.sin(bearingRad) + dN * Math.cos(bearingRad)];
  };
  const fromUV = (u: number, v: number): LatLng => {
    const dE = u * Math.cos(bearingRad) + v * Math.sin(bearingRad);
    const dN = -u * Math.sin(bearingRad) + v * Math.cos(bearingRad);
    return [center[0] + dN / mLat, center[1] + dE / mLng];
  };
  // lattice from nodes within radius
  const RADIUS = scale * 1.5;
  const us: number[] = [], vs: number[] = [];
  {
    const CELL = 0.003;
    const span = Math.ceil(RADIUS / 300);
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
      const k = `${Math.round(center[0] / CELL) + dy}:${Math.round(center[1] / CELL) + dx}`;
      for (const i of (g.grid.get(k) ?? [])) {
        if (meters(g.coord[i], center) > RADIUS) continue;
        const [u, v] = toUV(g.coord[i]);
        us.push(u);
        vs.push(v);
      }
    }
  }
  if (us.length < 3000) return { fail: "sparse" };
  const lines = (vals: number[], other: number[]): number[] => {
    const min = Math.min(...vals);
    const b2 = new Map<number, { c: number; lo: number; hi: number }>();
    for (let i = 0; i < vals.length; i++) {
      const b = Math.round((vals[i] - min) / 20);
      const e = b2.get(b) ?? { c: 0, lo: Infinity, hi: -Infinity };
      e.c++;
      e.lo = Math.min(e.lo, other[i]);
      e.hi = Math.max(e.hi, other[i]);
      b2.set(b, e);
    }
    const cand: { pos: number; score: number }[] = [];
    for (const [b, e] of b2) {
      if (e.c < 25 || e.hi - e.lo < RADIUS * 0.8) continue;
      cand.push({ pos: min + b * 20, score: e.c });
    }
    cand.sort((a, x) => a.pos - x.pos);
    const out: { pos: number; score: number }[] = [];
    for (const c of cand) {
      const last = out[out.length - 1];
      if (last && c.pos - last.pos < 100) {
        if (c.score > last.score) out[out.length - 1] = c;
      } else out.push(c);
    }
    return out.map((c) => c.pos);
  };
  const uLines = lines(us, vs), vLines = lines(vs, us);
  if (uLines.length < 8 || vLines.length < 8) return { fail: "lattice" };
  const snapTo = (val: number, ls: number[]) => ls.reduce((a, b) => (Math.abs(b - val) < Math.abs(a - val) ? b : a));

  // shared frame
  const all = PIECES.flatMap((p) => p.pts.map(([x, y]) => ({ x, y })));
  const unit = toUnit(all as NormalizedPoint[]);
  const unitPieces: any[] = [];
  {
    let offIdx = 0;
    for (const p of PIECES) {
      unitPieces.push(unit.slice(offIdx, offIdx + p.pts.length));
      offIdx += p.pts.length;
    }
  }
  const nudge = (target: LatLng[], dN: number, dE: number): LatLng[] =>
    target.map((p) => [p[0] + dN / 111320, p[1] + dE / (111320 * Math.cos((p[0] * Math.PI) / 180))] as LatLng);
  const tryTrace = (target: LatLng[], corridorM = 90): LatLng[] | null => {
    const closed = meters(target[0], target[target.length - 1]) < 40;
    let bestChain: LatLng[] | null = null, bestScore = -1;
    for (const anchorM of [110, 300]) {
      const r = traceContour(g, target as any, { anchorM, lambda: 12, corridorM, closeLoop: closed });
      if (!r.chain.length || r.coverage < 0.999999 || r.maxGapM > 0) continue;
      const lenM = r.chain.slice(1).reduce((a, p, i) => a + meters(r.chain[i] as any, p as any), 0);
      const targetM = target.slice(1).reduce((a, p, i) => a + meters(target[i], p), 0);
      const economy = targetM > 0 ? Math.min(1, targetM / Math.max(1, lenM)) : 0;
      if (economy > bestScore) { bestScore = economy; bestChain = r.chain as any; }
    }
    return bestChain;
  };
  const corridorCompile = (target: LatLng[]): LatLng[] | null => {
    const snapped: LatLng[] = target.map((p) => {
      const [u, v] = toUV(p);
      return fromUV(snapTo(u, uLines), snapTo(v, vLines));
    });
    const corners: LatLng[] = [];
    for (const p of snapped) {
      const last = corners[corners.length - 1];
      if (!last || meters(last, p) > 30) corners.push(p);
    }
    if (corners.length < 4) return null;
    let chain: LatLng[] = [];
    for (let i = 0; i < corners.length; i++) {
      const { id, d } = nearestNode(g, corners[i]);
      if (id < 0 || d > 120) return null;
      if (i === 0) { chain = [g.coord[id]]; continue; }
      const prev = nearestNode(g, corners[i - 1]).id;
      const pth = shortestPath(g, prev, id);
      if (!pth) return null;
      const direct = meters(corners[i - 1], corners[i]);
      const legM = pth.slice(1).reduce((a, p, j) => a + meters(pth[j], p), 0);
      if (legM > direct * 1.6 + 220) return null;
      chain = [...chain, ...pth.slice(1)];
    }
    return chain;
  };

  // FIGURE first (traced, own nudge)
  const idx = Object.fromEntries(PIECES.map((p, i) => [p.name, i]));
  let figChain: LatLng[] | null = null, figDN = 0, figDE = 0;
  figOuter: for (const dN of [0, 130, -130, 260, -260]) {
    for (const dE of [0, 130, -130]) {
      const c = tryTrace(nudge(place(unitPieces[idx.figure], center, scale, rot) as any, dN, dE));
      if (c) { figChain = c; figDN = dN; figDE = dE; break figOuter; }
    }
  }
  if (!figChain) return { fail: "figure" };
  // PUMP corridor-compiled, with layout-flex nudge
  let pumpChain: LatLng[] | null = null, pumpDN = 0, pumpDE = 0;
  pumpOuter: for (const dN of [0, 130, -130, 260, -260]) {
    for (const dE of [0, 130, -130, 260, -260]) {
      const c = corridorCompile(nudge(place(unitPieces[idx.pump], center, scale, rot) as any, dN, dE));
      if (c) { pumpChain = c; pumpDN = dN; pumpDE = dE; break pumpOuter; }
    }
  }
  if (!pumpChain) return { fail: "pump" };
  // WINDOW corridor-compiled with the pump's nudge (optional)
  let winChain: LatLng[] | null = null;
  winOuter: for (const wdN of [0, 130, -130]) {
    for (const wdE of [0, 130, -130]) {
      winChain = corridorCompile(nudge(place(unitPieces[idx.window], center, scale, rot) as any, pumpDN + wdN, pumpDE + wdE));
      if (winChain) break winOuter;
    }
  }
  // HOSE traced, warped between pump and figure nudges
  const hosePlaced = place(unitPieces[idx.hose], center, scale, rot) as any as LatLng[];
  const hn = hosePlaced.length;
  const hoseWarped = hosePlaced.map((p, i) => {
    const t = i / (hn - 1);
    const dN = (1 - t) * pumpDN + t * figDN;
    const dE = (1 - t) * pumpDE + t * figDE;
    return [p[0] + dN / 111320, p[1] + dE / (111320 * Math.cos((p[0] * Math.PI) / 180))] as LatLng;
  });
  const hoseChain = tryTrace(hoseWarped, 120);
  if (!hoseChain) return { fail: "hose" };
  // HEADPHONES traced with the figure's nudge (optional)
  const hpChain = tryTrace(nudge(place(unitPieces[idx.headphones], center, scale, rot) as any, figDN, figDE));

  const chains: { name: string; chain: LatLng[] }[] = [
    { name: "pump", chain: pumpChain },
    ...(winChain ? [{ name: "window", chain: winChain }] : []),
    { name: "hose", chain: hoseChain },
    { name: "figure", chain: figChain },
    ...(hpChain ? [{ name: "headphones", chain: hpChain }] : []),
  ];
  const OPTIONAL = new Set(["window", "headphones"]);
  const rotChain = (chain: LatLng[], near: LatLng): LatLng[] => {
    if (meters(chain[0], chain[chain.length - 1]) > 60) return chain;
    const core = chain.slice(0, -1);
    let k = 0, bd = Infinity;
    for (let i = 0; i < core.length; i++) {
      const d = meters(core[i], near);
      if (d < bd) { bd = d; k = i; }
    }
    const out = [...core.slice(k), ...core.slice(0, k)];
    out.push(out[0]);
    return out;
  };
  if (chains[1]?.name === "window") {
    const win = chains[1].chain.slice(0, -1);
    const pump0 = chains[0].chain.slice(0, -1);
    const hoseStart = chains[2].chain[0];
    let bestK = 0, bestCost = Infinity, bestPumpPt: LatLng = pump0[0];
    for (let k = 0; k < win.length; k++) {
      let pd = Infinity, pp: LatLng = pump0[0];
      for (const q of pump0) {
        const d = meters(q, win[k]);
        if (d < pd) { pd = d; pp = q; }
      }
      const cost = pd + meters(win[k], hoseStart);
      if (cost < bestCost) { bestCost = cost; bestK = k; bestPumpPt = pp; }
    }
    chains[1].chain = rotChain(chains[1].chain, win[bestK]);
    chains[0].chain = rotChain(chains[0].chain, bestPumpPt);
  } else {
    chains[0].chain = rotChain(chains[0].chain, chains[1].chain[0]);
  }
  const full: LatLng[] = [...chains[0].chain];
  for (let i = 1; i < chains.length; i++) {
    chains[i].chain = rotChain(chains[i].chain, full[full.length - 1]);
    const conn = shortestPath(g, nearestNode(g, full[full.length - 1]).id, nearestNode(g, chains[i].chain[0]).id);
    if (!conn) return { fail: "conn" };
    const connM = conn.slice(1).reduce((a, p, j) => a + meters(conn[j], p), 0);
    const hopCap = OPTIONAL.has(chains[i].name) || OPTIONAL.has(chains[i - 1].name) ? 1100 : 600;
    if (connM > hopCap) return { fail: `conn:${chains[i].name}` };
    full.push(...conn.slice(1), ...chains[i].chain.slice(1));
  }
  const km = full.slice(1).reduce((a, p, i) => a + meters(full[i], p), 0) / 1000;
  if (km < 10 || km > 62) return { fail: "km" };
  return { chain: full, km, parts: chains.map((c) => c.name).join("+"), rot };
}

async function judge(png: string) {
  const upload = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("gas.png").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(png).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
  const likes: number[] = [];
  const colds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await api([upload, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as a thin orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color; the badge circle is background, judge the figures. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }], 512);
    likes.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  for (let i = 0; i < 3; i++) {
    const t = await api([img, { type: "text", text: 'The orange line is a GPS route someone recorded while running - they were trying to "draw" a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words>\nCONFIDENCE: <0-10>' }]);
    colds.push(`"${(t.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? "").trim()}" ${t.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? 0}`);
  }
  return { likes, colds };
}

async function mapboxVerify(chain: LatLng[]): Promise<{ ok: boolean; walkKm: number; failedLegs: number; delta: number }> {
  let chainM = 0;
  for (let i = 1; i < chain.length; i++) chainM += meters(chain[i - 1], chain[i]);
  const way: LatLng[] = [chain[0]];
  let acc = 0;
  for (let i = 1; i < chain.length; i++) {
    acc += meters(chain[i - 1], chain[i]);
    if (acc >= 180 || i === chain.length - 1) { way.push(chain[i]); acc = 0; }
  }
  let walkM = 0, failedLegs = 0;
  for (let i = 0; i < way.length - 1; i += 23) {
    const seg = way.slice(i, Math.min(way.length, i + 24));
    if (seg.length < 2) break;
    const cs = seg.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
    let json: any = null;
    try {
      const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/walking/${cs}?geometries=geojson&overview=false&access_token=${MAPBOX}`);
      json = res.ok ? await res.json() : null;
    } catch { /* retry once */
      try {
        const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/walking/${cs}?geometries=geojson&overview=false&access_token=${MAPBOX}`);
        json = res.ok ? await res.json() : null;
      } catch { json = null; }
    }
    if (!json || json.code !== "Ok" || !json.routes?.[0]) { failedLegs++; continue; }
    walkM += json.routes[0].distance;
    await new Promise((r) => setTimeout(r, 350));
  }
  const delta = (100 * Math.abs(walkM - chainM)) / chainM;
  return { ok: failedLegs === 0 && delta < 12, walkKm: walkM / 1000, failedLegs, delta };
}

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  MAPBOX = env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });
  const g = await loadBrooklyn();

  const results: any[] = [];
  const fails: Record<string, number> = {};
  for (const scale of [1900, 2300, 2700]) {
    for (let lat = 40.6; lat <= 40.735; lat += 0.009) {
      for (let lng = -74.0; lng <= -73.89; lng += 0.009) {
        const r = compileAt(g, [lat, lng], scale);
        if (r.fail) { fails[r.fail] = (fails[r.fail] ?? 0) + 1; continue; }
        results.push({ ...r, center: [lat, lng], scale });
      }
    }
  }
  console.log(`compiled: ${results.length}; fails ${JSON.stringify(fails)}`);
  if (!results.length) return;
  results.sort((a, b) => b.parts.length - a.parts.length || b.scale - a.scale);
  const diverse: any[] = [];
  for (const r of results) {
    if (diverse.some((d) => d.scale === r.scale && meters(d.center, r.center) < 2500)) continue;
    diverse.push(r);
    if (diverse.length >= 12) break;
  }
  for (let c = 0; c < diverse.length; c++) {
    const r = diverse[c];
    const png = path.join(OUT, `final-${c}.png`);
    await renderMap(r.chain as any, [], png, 1200, 1000);
    const { likes, colds } = await judge(png);
    (r as any).judged = likes;
    console.log(`final-${c}: [${r.parts}] rot=${r.rot.toFixed(1)} scale=${r.scale} km=${r.km.toFixed(1)} likeness=${likes.join("/")} cold=${colds.join(" | ")}`);
    if (Math.min(...likes) >= 8) {
      const mv = await mapboxVerify(r.chain);
      console.log(`  mapbox: ok=${mv.ok} walk=${mv.walkKm.toFixed(1)}km failedLegs=${mv.failedLegs} delta=${mv.delta.toFixed(1)}%`);
      if (mv.ok) {
        const pts = r.chain.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
        await fs.writeFile(path.join(OUT, "GAS-FINAL.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas logo</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
        console.log(`GAS FINAL KEEPER: final-${c} — likeness ${likes.join("/")}, ${r.km.toFixed(1)} km, Mapbox verified`);
        return;
      }
    }
  }
  const judged = diverse.filter((d: any) => d.judged);
  if (judged.length) {
    judged.sort((a: any, b: any) => Math.min(...b.judged) - Math.min(...a.judged));
    const best: any = judged[0];
    const pts = best.chain.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(path.join(OUT, "best.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
    console.log(`no keeper at the bar; best judged: likeness ${best.judged.join("/")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
