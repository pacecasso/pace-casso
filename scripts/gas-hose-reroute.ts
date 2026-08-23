// Surgery v2, guided by the judges' unanimous instruction: replace the flat
// torso-level hose with a looping hose that RISES TO THE HEAD (the logo's
// gag). Pump and figure stay exactly as codex tuned them; the figure ring
// is rotated to begin at the head so the whole route stays one line.
// Usage: npx tsx scripts/gas-hose-reroute.ts [loopE=600] [loopS=350]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { renderMap } from "./trace-contour";
import type { LatLng } from "../lib/streetGraphTrace";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const BASE = "tmp-logo-proof/gas-brooklyn-curated/gas-v11-centered-neck-s0-l145.gpx";
const OUT = "tmp-studio/gas-surgery";
let KEY = "";

function meters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180, dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2));
}
const M_LAT = 111320;
const mPerLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

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
  return { coord, adj };
}
function nearestNode(g: any, p: LatLng): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.coord.length; i++) {
    const d = meters(g.coord[i], p);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function shortestPath(g: any, a: number, b: number): LatLng[] | null {
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

async function judge(png: string) {
  const upload = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("gas.png").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(png).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
  const api = async (content: any[], mt = 512) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: mt, messages: [{ role: "user", content }] }),
    });
    const json: any = await res.json();
    return (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
  };
  const likes: number[] = [];
  const colds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await api([upload, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as a thin orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color; the badge circle is background, judge the figures. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }]);
    likes.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  for (let i = 0; i < 3; i++) {
    const t = await api([img, { type: "text", text: 'The orange line is a GPS route someone recorded while running - they were trying to "draw" a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words>\nCONFIDENCE: <0-10>' }], 1024);
    colds.push(`"${(t.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? "").trim()}" ${t.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? 0}`);
  }
  return { likes, colds };
}

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });
  const gpx = await fs.readFile(BASE, "utf8");
  const coords: LatLng[] = [...gpx.matchAll(/lat="([-0-9.]+)" lon="([-0-9.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);

  const HOSE_START = 695, FIG_START = 719;
  const pump = coords.slice(0, HOSE_START);
  const fig = coords.slice(FIG_START);
  // figure ring closure check
  const figClosed = meters(fig[0], fig[fig.length - 1]) < 60;
  console.log(`pump ${pump.length} pts, fig ${fig.length} pts, figClosed=${figClosed} (gap ${meters(fig[0], fig[fig.length - 1]).toFixed(0)}m)`);

  // head anchor: westmost point of the figure's top 22% band
  const figLats = fig.map((p) => p[0]);
  const latCut = Math.max(...figLats) - (Math.max(...figLats) - Math.min(...figLats)) * 0.22;
  let anchorIdx = -1;
  for (let i = 0; i < fig.length; i++) {
    if (fig[i][0] > latCut && (anchorIdx < 0 || fig[i][1] < fig[anchorIdx][1])) anchorIdx = i;
  }
  const head = fig[anchorIdx];
  const pumpExit = pump[pump.length - 1];
  console.log(`pump exit ${pumpExit}, head ${head}`);

  const g = await loadBrooklyn();
  const loopE = Number(process.argv[2] ?? 600), loopS = Number(process.argv[3] ?? 350);
  const off = (p: LatLng, dEm: number, dNm: number): LatLng => [p[0] + dNm / M_LAT, p[1] + dEm / mPerLng(p[0])];
  // hose waypoints: drop, loop (self-crossing on re-entry), rise to head
  const wps: LatLng[] = [
    pumpExit,
    off(pumpExit, 120, -loopS),           // drop below pump exit, slightly east
    off(pumpExit, 120 + loopE, -loopS),   // east along the bottom of the loop
    off(pumpExit, 120 + loopE, -loopS + 300), // up the loop's east side
    off(pumpExit, 120 + loopE - 380, -loopS + 300), // back west (crosses the drop line = the loop)
    off(pumpExit, 120 + loopE - 380, -loopS + 120), // small step down to exit the loop cleanly
    head,                                  // rise to the head
  ];
  let hose: LatLng[] = [];
  for (let i = 1; i < wps.length; i++) {
    const p = shortestPath(g, nearestNode(g, hose.length ? hose[hose.length - 1] : wps[0]), nearestNode(g, wps[i]));
    if (!p) throw new Error(`hose leg ${i} unroutable`);
    hose = hose.length ? [...hose, ...p.slice(1)] : p;
  }
  const hoseM = hose.slice(1).reduce((a, p, i) => a + meters(hose[i], p), 0);
  console.log(`new hose: ${hose.length} pts, ${(hoseM / 1000).toFixed(1)} km`);

  // rotate figure ring to start at the head anchor
  let figRot: LatLng[];
  if (figClosed) {
    const core = fig.slice(0, -1);
    figRot = [...core.slice(anchorIdx), ...core.slice(0, anchorIdx)];
    figRot.push(figRot[0]);
  } else {
    // open figure: connect from head anchor — walk ring as-is from anchor to
    // end, then jump-free continuation isn't possible; fall back to original
    // order with a street connector from hose end to fig[0].
    figRot = fig;
  }
  const bridge = figClosed ? [] : (shortestPath(g, nearestNode(g, hose[hose.length - 1]), nearestNode(g, fig[0])) ?? []).slice(1);
  const route: LatLng[] = [...pump, ...hose.slice(1), ...bridge, ...figRot];
  const km = route.slice(1).reduce((a, p, i) => a + meters(route[i], p), 0) / 1000;

  const tag = `loopE${loopE}-loopS${loopS}`;
  const png = path.join(OUT, `hose-${tag}.png`);
  await renderMap(route as any, [], png, 1200, 1000);
  const { likes, colds } = await judge(png);
  console.log(`hose-${tag}: ${km.toFixed(1)} km | likeness ${likes.join("/")} | cold ${colds.join(" | ")} → ${png}`);
  const pts = route.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  await fs.writeFile(path.join(OUT, `hose-${tag}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
