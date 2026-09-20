/**
 * What does the SHIPPED Brooklyn engine actually do, across every real subject?
 * Mirrors app/api/geo-draft exactly: same defaults, same ladder, same fill.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { LatLng } from "../lib/streetGraphTrace";
import { meters, type PainterGraph } from "../lib/strokePainter";
import { BROOKLYN_GEO_DEFAULTS, geoDraft } from "../lib/geoDraft";
import { fillEnclosed, loadMaskAuto } from "../lib/geoMask";
import { paleRender, sideBySide, writeGpx } from "./finisher-shared";

const LADDER = [
  { scale: 4000, sweepBudgetMs: 60_000, totalBudgetMs: 85_000 },
  { scale: 3200, sweepBudgetMs: 52_000, totalBudgetMs: 75_000 },
  { scale: 2500, sweepBudgetMs: 45_000, totalBudgetMs: 65_000 },
];

async function loadPackedGraph(file: string): Promise<PainterGraph> {
  const data = JSON.parse(await fs.readFile(file, "utf8")) as {
    scale: number; lat: number[]; lng: number[]; edges: number[];
  };
  const n = data.lat.length;
  const coord: LatLng[] = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = [data.lat[i]! / data.scale, data.lng[i]! / data.scale];
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < data.edges.length; e += 2) {
    const a = data.edges[e]!;
    const b = data.edges[e + 1]!;
    const w = meters(coord[a]!, coord[b]!);
    adj[a]!.push({ to: b, w });
    adj[b]!.push({ to: a, w });
  }
  const grid = new Map<string, number[]>();
  const CELL = 0.003;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid } as unknown as PainterGraph;
}

async function main(): Promise<void> {
  const img = process.argv[2]!;
  const out = process.argv[3]!;
  await fs.mkdir(out, { recursive: true });
  const g = await loadPackedGraph(path.join("lib", "data", "nyc-core-walk-graph.json"));
  const m = await loadMaskAuto(img);
  const mask = fillEnclosed(m.mask, m.w, m.h);
  let best: Awaited<ReturnType<typeof geoDraft>> | null = null;
  for (const rung of LADDER) {
    const res = await geoDraft(g, mask, m.w, m.h, {
      ...BROOKLYN_GEO_DEFAULTS,
      scales: [rung.scale],
      sweepBudgetMs: rung.sweepBudgetMs,
      totalBudgetMs: rung.totalBudgetMs,
    });
    if (!res.ok) {
      console.log(`${img} RUNG ${rung.scale} ${res.reason}`);
      continue;
    }
    console.log(`${img} RUNG ${rung.scale} ok score=${res.score?.toFixed(1)} km=${res.km?.toFixed(1)}`);
    if (!best || (res.score ?? 0) > (best.score ?? 0)) best = res;
  }
  if (!best || !best.chain) {
    console.log(`${img} NO ROUTE AT ANY SIZE`);
    return;
  }
  console.log(`${img} BEST ${JSON.stringify({
    km: best.km, score: best.score, crossings: best.crossings, scale: best.scale,
  })}`);
  await paleRender(best.chain, path.join(out, "best.png"));
  await sideBySide(img, path.join(out, "best.png"), path.join(out, "compare.png"));
  await fs.writeFile(path.join(out, "best.gpx"), writeGpx(best.chain, "brooklyn", "PaceCasso"));
}
main().catch((e) => { console.error(e); process.exit(1); });
