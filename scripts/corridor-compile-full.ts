// COMPOSITION→CORRIDOR compiler, full gas composition.
// Every piece's vertices snap to the local street-line lattice; edges
// become streets, corners become intersections; pieces join via the
// proven connector machinery. Expected to close the 2-4 point trace
// degradation measured on gas and the tongue.
// Usage: npx tsx scripts/corridor-compile-full.ts [probe|sweep]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { place, toUnit, type LatLng, type NormalizedPoint } from "../lib/streetGraphTrace";
import { renderMap } from "./trace-contour";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const OUT = "tmp-studio/corridor-full";
let KEY = "";

type P = [number, number];

// ---- the gas composition (the 9/9/9-sketch era pieces, blockified) ------
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
const hose: P[] = [
  [0.305, 0.66],
  [0.36, 0.66], [0.36, 0.745], [0.44, 0.745], [0.44, 0.775],
  [0.53, 0.775],
  [0.53, 0.635], [0.60, 0.635], [0.60, 0.755], [0.475, 0.755], [0.475, 0.70],
  [0.545, 0.70],
  [0.545, 0.575], [0.585, 0.575], [0.585, 0.475], [0.625, 0.475], [0.625, 0.40], [0.665, 0.40], [0.665, 0.352], [0.694, 0.352],
];
const headphones: P[] = [
  [0.744, 0.330], [0.726, 0.330], [0.726, 0.240],
  [0.740, 0.192], [0.890, 0.192],
  [0.904, 0.240], [0.904, 0.330], [0.886, 0.330],
];
const PIECES: { name: string; pts: P[] }[] = [
  { name: "pump", pts: pumpRing },
  { name: "window", pts: windowRing },
  { name: "hose", pts: hose },
  { name: "figure", pts: figRing },
  { name: "headphones", pts: headphones },
];
const OPTIONAL = new Set(["window", "headphones"]);

// ---- helpers -------------------------------------------------------------
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
function nearestNodeId(g: any, p: LatLng): { id: number; d: number } {
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

// ---- corridor compile at one placement -----------------------------------
function compileAt(g: any, center: LatLng, scale: number): { chain: LatLng[]; km: number; parts: string; rot: number } | { fail: string } {
  // local bearing
  const bins = new Array(90).fill(0);
  const CELL = 0.003;
  const nearIds: number[] = [];
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
    const k = `${Math.round(center[0] / CELL) + dy}:${Math.round(center[1] / CELL) + dx}`;
    for (const i of (g.grid.get(k) ?? [])) nearIds.push(i);
  }
  for (const i of nearIds) {
    for (const { to, w } of g.adj[i] ?? []) {
      if (to < i || w < 40) continue;
      const dN = (g.coord[to][0] - g.coord[i][0]) * 111320;
      const dE = (g.coord[to][1] - g.coord[i][1]) * 111320 * Math.cos((g.coord[i][0] * Math.PI) / 180);
      const deg = ((Math.atan2(dE, dN) * 180) / Math.PI % 90 + 90) % 90;
      bins[Math.min(89, Math.floor(deg))] += w;
    }
  }
  let bestDeg = 0;
  for (let i = 1; i < 90; i++) if (bins[i] > bins[bestDeg]) bestDeg = i;
  const rot = (bestDeg + 0.5) <= 45 ? bestDeg + 0.5 : bestDeg + 0.5 - 90;
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
  // lattice
  const RADIUS = scale * 1.5;
  const us: number[] = [], vs: number[] = [];
  for (const i of nearIds) {
    if (meters(g.coord[i], center) > RADIUS) continue;
    const [u, v] = toUV(g.coord[i]);
    us.push(u);
    vs.push(v);
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

  // compile pieces
  const all = PIECES.flatMap((p) => p.pts.map(([x, y]) => ({ x, y })));
  const unit = toUnit(all as NormalizedPoint[]);
  const unitPieces: any[] = [];
  let off = 0;
  for (const p of PIECES) {
    unitPieces.push(unit.slice(off, off + p.pts.length));
    off += p.pts.length;
  }
  const chains: { name: string; chain: LatLng[] }[] = [];
  for (let pi = 0; pi < PIECES.length; pi++) {
    const name = PIECES[pi].name;
    const target = place(unitPieces[pi], center, scale, rot) as any as LatLng[];
    const snapped: LatLng[] = target.map((p) => {
      const [u, v] = toUV(p);
      return fromUV(snapTo(u, uLines), snapTo(v, vLines));
    });
    // dedupe consecutive identical snapped corners
    const corners: LatLng[] = [];
    for (const p of snapped) {
      const last = corners[corners.length - 1];
      if (!last || meters(last, p) > 30) corners.push(p);
    }
    // every corner must sit on a real node (not water/parkway margins)
    let chain: LatLng[] = [];
    let ok = true;
    for (let i = 0; i < corners.length; i++) {
      const { id, d } = nearestNodeId(g, corners[i]);
      if (id < 0 || d > 120) { ok = false; break; }
      if (i === 0) { chain = [g.coord[id]]; continue; }
      const prev = nearestNodeId(g, corners[i - 1]).id;
      const pth = shortestPath(g, prev, id);
      if (!pth) { ok = false; break; }
      // corridor guard: the leg between same-line corners must not detour
      const direct = meters(corners[i - 1], corners[i]);
      const legM = pth.slice(1).reduce((a, p, j) => a + meters(pth[j], p), 0);
      if (legM > direct * 1.6 + 220) { ok = false; break; }
      chain = [...chain, ...pth.slice(1)];
    }
    if (!ok || chain.length < 3) {
      if (OPTIONAL.has(name)) continue;
      return { fail: name };
    }
    chains.push({ name, chain });
  }
  if (chains.length < 3) return { fail: "pieces" };

  // joint rotation (pump→window→hose) + connectors — proven machinery
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
  } else if (chains.length > 1) {
    chains[0].chain = rotChain(chains[0].chain, chains[1].chain[0]);
  }
  const full: LatLng[] = [...chains[0].chain];
  for (let i = 1; i < chains.length; i++) {
    chains[i].chain = rotChain(chains[i].chain, full[full.length - 1]);
    const conn = shortestPath(g, nearestNodeId(g, full[full.length - 1]).id, nearestNodeId(g, chains[i].chain[0]).id);
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

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });
  const g = await loadBrooklyn();

  if (process.argv[2] === "probe") {
    const r = compileAt(g, [40.62, -73.96], 2300);
    if ("fail" in r) {
      console.log("probe fail:", r.fail);
      return;
    }
    console.log(`probe: [${r.parts}] rot=${r.rot.toFixed(1)} km=${r.km.toFixed(1)}`);
    const png = path.join(OUT, "probe.png");
    await renderMap(r.chain as any, [], png, 1200, 1000);
    const { likes, colds } = await judge(png);
    console.log(`probe judged: likeness ${likes.join("/")} | cold ${colds.join(" | ")} → ${png}`);
    return;
  }

  // sweep
  const results: any[] = [];
  const failCounts: Record<string, number> = {};
  for (const scale of [1900, 2300, 2700]) {
    for (let lat = 40.6; lat <= 40.735; lat += 0.009) {
      for (let lng = -74.0; lng <= -73.89; lng += 0.009) {
        const r = compileAt(g, [lat, lng], scale);
        if ("fail" in r) {
          failCounts[r.fail] = (failCounts[r.fail] ?? 0) + 1;
          continue;
        }
        results.push({ ...r, center: [lat, lng], scale });
      }
    }
  }
  console.log(`compiled placements: ${results.length}; fails ${JSON.stringify(failCounts)}`);
  results.sort((a, b) => b.parts.length - a.parts.length || b.scale - a.scale);
  const diverse: any[] = [];
  for (const r of results) {
    if (diverse.some((d) => d.scale === r.scale && meters(d.center, r.center) < 2500)) continue;
    diverse.push(r);
    if (diverse.length >= 10) break;
  }
  for (let c = 0; c < diverse.length; c++) {
    const r = diverse[c];
    const png = path.join(OUT, `sweep-${c}.png`);
    await renderMap(r.chain as any, [], png, 1200, 1000);
    const { likes, colds } = await judge(png);
    console.log(`sweep-${c}: [${r.parts}] rot=${r.rot.toFixed(1)} scale=${r.scale} km=${r.km.toFixed(1)} likeness=${likes.join("/")} cold=${colds.join(" | ")}`);
    (r as any).judged = likes;
    if (Math.min(...likes) >= 8) {
      const pts = r.chain.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
      await fs.writeFile(path.join(OUT, `keeper-${c}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
      console.log(`KEEPER at the 8+ likeness bar: sweep-${c}`);
      break;
    }
  }
  const judged = diverse.filter((d: any) => d.judged);
  if (judged.length) {
    judged.sort((a: any, b: any) => Math.min(...b.judged) - Math.min(...a.judged));
    const best: any = judged[0];
    const pts = best.chain.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(path.join(OUT, "best.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
    console.log(`best saved: likeness ${best.judged.join("/")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
