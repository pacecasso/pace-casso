// COMPOSITION→CORRIDOR compiler, slice 1 (proof on the pump piece):
// instead of tracing a freeform polyline (loses 2-4 likeness points to
// wobble), snap each vertex to the local street-line lattice — u/v
// coordinates quantized to actual street lines — so edges BECOME streets
// and corners BECOME intersections. Compare against the tracer.
// Usage: npx tsx scripts/corridor-compile.ts
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { traceContour, place, toUnit, type LatLng, type NormalizedPoint } from "../lib/streetGraphTrace";
import { renderMap } from "./trace-contour";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const OUT = "tmp-studio/corridor";

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

// the gas pump piece (same as gas-authored)
const pumpRing: [number, number][] = [
  [0.07, 0.40], [0.33, 0.40],
  [0.33, 0.62],
  [0.28, 0.62], [0.28, 0.70], [0.33, 0.70],
  [0.33, 0.88],
  [0.37, 0.88], [0.37, 0.93], [0.03, 0.93], [0.03, 0.88], [0.07, 0.88],
  [0.07, 0.40],
];

function turnCount(chain: LatLng[]): number {
  let turns = 0;
  for (let i = 2; i < chain.length; i++) {
    const a = chain[i - 2], b = chain[i - 1], c = chain[i];
    const v1 = [(b[0] - a[0]) * 111320, (b[1] - a[1]) * 85000];
    const v2 = [(c[0] - b[0]) * 111320, (c[1] - b[1]) * 85000];
    const d1 = Math.hypot(v1[0], v1[1]) || 1, d2 = Math.hypot(v2[0], v2[1]) || 1;
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (d1 * d2);
    if (cos < 0.7) turns++;
  }
  return turns;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const g = await loadBrooklyn();
  // Gravesend-ish center, near-0° grid
  const center: LatLng = [40.605, -73.965];
  const scale = 2300;
  // measure the ACTUAL local grid bearing — a 5° frame error smears the
  // lattice and drops snapped corners mid-block
  const bins = new Array(90).fill(0);
  for (let i = 0; i < g.coord.length; i += 3) {
    if (meters(g.coord[i], center) > scale * 1.4) continue;
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
  console.log(`local grid bearing: ${rot.toFixed(1)}°`);
  const unit = toUnit(pumpRing.map(([x, y]) => ({ x, y })) as NormalizedPoint[]);
  const target = place(unit as any, center, scale, rot) as any as LatLng[];

  // ---- corridor compile: build the local street-line lattice in u/v ----
  const bearingRad = (rot * Math.PI) / 180;
  const mLat = 111320, mLng = 111320 * Math.cos((center[0] * Math.PI) / 180);
  const toUV = (p: LatLng): [number, number] => {
    const dN = (p[0] - center[0]) * mLat, dE = (p[1] - center[1]) * mLng;
    return [dE * Math.cos(bearingRad) - dN * Math.sin(bearingRad), dE * Math.sin(bearingRad) + dN * Math.cos(bearingRad)];
  };
  // collect nearby nodes and histogram their u and v to find street lines
  const RADIUS = scale * 1.4;
  const us: number[] = [], vs: number[] = [];
  const nearIds: number[] = [];
  for (let i = 0; i < g.coord.length; i++) {
    if (meters(g.coord[i], center) > RADIUS) continue;
    nearIds.push(i);
    const [u, v] = toUV(g.coord[i]);
    us.push(u);
    vs.push(v);
  }
  const lines = (vals: number[], other: number[]): number[] => {
    // A true street LINE has nodes spread along most of the window in the
    // other axis — not just a dense clump. 20 m bins, span-weighted.
    const min = Math.min(...vals);
    const bins = new Map<number, { c: number; lo: number; hi: number }>();
    for (let i = 0; i < vals.length; i++) {
      const b = Math.round((vals[i] - min) / 20);
      const e = bins.get(b) ?? { c: 0, lo: Infinity, hi: -Infinity };
      e.c++;
      e.lo = Math.min(e.lo, other[i]);
      e.hi = Math.max(e.hi, other[i]);
      bins.set(b, e);
    }
    const cand: { pos: number; score: number }[] = [];
    for (const [b, e] of bins) {
      const span = e.hi - e.lo;
      if (e.c < 25 || span < RADIUS * 0.8) continue;
      cand.push({ pos: min + b * 20, score: e.c });
    }
    cand.sort((a, b2) => a.pos - b2.pos);
    // merge candidates within 100 m, keep the strongest
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
  console.log(`street lattice: ${uLines.length} u-lines, ${vLines.length} v-lines within ${RADIUS.toFixed(0)}m`);

  // snap each target vertex's u and v to the nearest street line
  const snapTo = (val: number, ls: number[]) => ls.reduce((a, b) => (Math.abs(b - val) < Math.abs(a - val) ? b : a));
  const fromUV = (u: number, v: number): LatLng => {
    const dE = u * Math.cos(bearingRad) + v * Math.sin(bearingRad);
    const dN = -u * Math.sin(bearingRad) + v * Math.cos(bearingRad);
    return [center[0] + dN / mLat, center[1] + dE / mLng];
  };
  const nearestNodeId = (p: LatLng): number => {
    let best = -1, bd = Infinity;
    for (const i of nearIds) {
      const d = meters(g.coord[i], p);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const snapped: LatLng[] = target.map((p) => {
    const [u, v] = toUV(p);
    return fromUV(snapTo(u, uLines), snapTo(v, vLines));
  });
  // corner-to-corner A* — corners share street lines so paths follow them
  let chain: LatLng[] = [];
  let okAll = true;
  for (let i = 0; i < snapped.length - 1; i++) {
    const pth = shortestPath(g, nearestNodeId(snapped[i]), nearestNodeId(snapped[i + 1]));
    if (!pth) { okAll = false; break; }
    chain = chain.length ? [...chain, ...pth.slice(1)] : pth;
  }
  if (!okAll) { console.log("corridor compile: unroutable at this center"); return; }
  const kmC = chain.slice(1).reduce((a, p, i) => a + meters(chain[i], p), 0) / 1000;

  // ---- baseline: the tracer on the same target ----
  const r = traceContour(g, target as any, { anchorM: 110, lambda: 12, corridorM: 90, closeLoop: true });
  const kmT = r.chain.length ? r.chain.slice(1).reduce((a, p, i) => a + meters(r.chain[i] as any, p as any), 0) / 1000 : 0;

  console.log(`CORRIDOR: ${kmC.toFixed(1)} km, ${turnCount(chain)} turns`);
  console.log(`TRACER:   ${kmT.toFixed(1)} km, ${r.chain.length ? turnCount(r.chain as any) : "n/a"} turns (cov ${r.coverage.toFixed(3)})`);
  await renderMap(chain as any, [], path.join(OUT, "pump-corridor.png"), 1000, 900);
  if (r.chain.length) await renderMap(r.chain as any, [], path.join(OUT, "pump-tracer.png"), 1000, 900);
}

main().catch((e) => { console.error(e); process.exit(1); });
