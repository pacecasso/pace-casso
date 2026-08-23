// Last arrow: corridor-compile the compact headphone staple onto codex's
// v11 (the 7/7/7 best-ever), in its own Gravesend lattice, inserted at the
// figure's head as a retraced excursion. Judge; Mapbox-verify if ≥8.
// Usage: npx tsx scripts/gas-v11-staple.ts [scaleFactor]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { renderMap } from "./trace-contour";
import type { LatLng } from "../lib/streetGraphTrace";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const BASE = "tmp-logo-proof/gas-brooklyn-curated/gas-v11-centered-neck-s0-l145.gpx";
const OUT = "tmp-studio/gas-final";
let KEY = "";

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

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });
  const gpx = await fs.readFile(BASE, "utf8");
  const coords: LatLng[] = [...gpx.matchAll(/lat="([-0-9.]+)" lon="([-0-9.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const g = await loadBrooklyn();

  // find the figure's head: rightmost object's top band (from the earlier
  // surgery work: figure = lng > midline+25%, head = top 22%)
  const lngs = coords.map((p) => p[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLng = (minLng + maxLng) / 2;
  const figPts = coords.map((p, i) => ({ p, i })).filter(({ p }) => p[1] > midLng + (maxLng - midLng) * 0.25);
  const figLats = figPts.map(({ p }) => p[0]);
  const latCut = Math.max(...figLats) - (Math.max(...figLats) - Math.min(...figLats)) * 0.22;
  const headPts = figPts.filter(({ p }) => p[0] > latCut);
  const headW = Math.min(...headPts.map(({ p }) => p[1]));
  const headE = Math.max(...headPts.map(({ p }) => p[1]));
  const headTopEntry = headPts.reduce((a, b) => (a.p[0] > b.p[0] ? a : b));
  const headTopLat = headTopEntry.p[0];
  const mLng = 111320 * Math.cos((headTopLat * Math.PI) / 180);
  const headWm = (headE - headW) * mLng;
  console.log(`head: width ${headWm.toFixed(0)}m, top at ${headTopLat.toFixed(5)}`);

  // staple: two cup walls (verticals just outside the head sides) + band
  // (horizontal one block above the head top). Corridor-shaped: pure H/V.
  const sf = Number(process.argv[2] ?? 1);
  const cupDrop = 220 * sf;   // cup wall length
  const bandRise = 180 * sf;  // band height above head top
  const sideOut = 90 * sf;    // cup outward offset from head side
  const pLL = (latM: number, lngM: number): LatLng => [headTopLat + latM / 111320, headW + lngM / mLng];
  const wps: LatLng[] = [
    pLL(-cupDrop + bandRise, -sideOut),           // left cup bottom
    pLL(bandRise, -sideOut),                       // left cup top / band left
    pLL(bandRise, headWm + sideOut),               // band right
    pLL(-cupDrop + bandRise, headWm + sideOut),    // right cup bottom
  ];
  // route the staple as corridor legs
  let staple: LatLng[] = [];
  for (let i = 0; i < wps.length; i++) {
    const { id, d } = nearestNode(g, wps[i]);
    if (id < 0 || d > 140) { console.log(`staple corner ${i} off-network (${d.toFixed(0)}m)`); return; }
    if (i === 0) { staple = [g.coord[id]]; continue; }
    const pth = shortestPath(g, nearestNode(g, wps[i - 1]).id, id);
    if (!pth) { console.log("staple leg unroutable"); return; }
    staple = [...staple, ...pth.slice(1)];
  }
  const stapleM = staple.slice(1).reduce((a, p, i) => a + meters(staple[i], p), 0);
  console.log(`staple: ${staple.length} pts, ${stapleM.toFixed(0)}m out (x2 retraced)`);

  // insert as out-and-back at the route point nearest the staple start
  let anchorIdx = 0, ad = Infinity;
  for (const { p, i } of headPts) {
    const d = meters(p, staple[0]);
    if (d < ad) { ad = d; anchorIdx = i; }
  }
  const bridge = shortestPath(g, nearestNode(g, coords[anchorIdx]).id, nearestNode(g, staple[0]).id);
  if (!bridge) { console.log("bridge unroutable"); return; }
  const excursion: LatLng[] = [...bridge.slice(1), ...staple.slice(1), ...staple.slice(0, -1).reverse(), ...bridge.slice(0, -1).reverse()];
  const surg: LatLng[] = [...coords.slice(0, anchorIdx + 1), ...excursion, ...coords.slice(anchorIdx + 1)];
  const km = surg.slice(1).reduce((a, p, i) => a + meters(surg[i], p), 0) / 1000;

  const png = path.join(OUT, `v11-staple-${sf}.png`);
  await renderMap(surg as any, [], png, 1200, 1000);
  const upload = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("gas.png").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(png).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
  const likes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await api([upload, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as a thin orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color; the badge circle is background, judge the figures. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }], 512);
    likes.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  const colds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await api([img, { type: "text", text: 'The orange line is a GPS route someone recorded while running - they were trying to "draw" a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words>\nCONFIDENCE: <0-10>' }]);
    colds.push(`"${(t.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? "").trim()}" ${t.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? 0}`);
  }
  console.log(`v11+staple sf=${sf}: ${km.toFixed(1)} km | likeness ${likes.join("/")} | cold ${colds.join(" | ")} → ${png}`);
  const pts = surg.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  await fs.writeFile(path.join(OUT, `v11-staple-${sf}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
