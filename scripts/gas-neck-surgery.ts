// Surgical upgrade of codex's best gas route: the upload's identity gesture
// — nozzle held TO THE HEAD — has never been drawn in any era. Insert a
// chunky out-and-back stroke (retraced = legal running move) from the
// figure's head aimed toward the hose. Everything that already scores 7/7/7
// stays untouched.
// Usage: npx tsx scripts/gas-neck-surgery.ts [reachM]
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

async function judge(png: string): Promise<{ likes: number[]; colds: string[] }> {
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
  console.log(`base: ${coords.length} pts`);

  // Segment: figure = points east of the composition's midline gap.
  const lngs = coords.map((p) => p[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLng = (minLng + maxLng) / 2;
  const figPts = coords.map((p, i) => ({ p, i })).filter(({ p }) => p[1] > midLng + (maxLng - midLng) * 0.25);
  // Head = topmost cluster of the figure (highest lat band, ~top 20%)
  const figLats = figPts.map(({ p }) => p[0]);
  const latCut = Math.max(...figLats) - (Math.max(...figLats) - Math.min(...figLats)) * 0.22;
  const headPts = figPts.filter(({ p }) => p[0] > latCut);
  // insertion point: the WESTmost head point (side facing the hose/pump)
  const anchor = headPts.reduce((a, b) => (a.p[1] < b.p[1] ? a : b));
  console.log(`figure pts ${figPts.length}, head pts ${headPts.length}, anchor idx ${anchor.i} @ ${anchor.p}`);

  const g = await loadBrooklyn();

  // ARC mode: draw the HEADPHONE BAND — an arch of streets over the head,
  // retraced. The judges' explicit missing feature; nothing in the
  // "two people" misreading carries a band over a head.
  if (process.env.ARC === "1") {
    const headTop = headPts.reduce((a, b) => (a.p[0] > b.p[0] ? a : b));
    const headLngs = headPts.map(({ p }) => p[1]);
    const headW = Math.min(...headLngs), headE = Math.max(...headLngs);
    const mLng = 111320 * Math.cos((headTop.p[0] * Math.PI) / 180);
    const rise = Number(process.argv[2] ?? 220);
    const wp1: LatLng = [headTop.p[0] + rise / 111320, headW - 60 / mLng];
    const wp2: LatLng = [headTop.p[0] + rise / 111320, headE + 60 / mLng];
    const n0 = nearestNode(g, headTop.p);
    const p1 = shortestPath(g, n0, nearestNode(g, wp1));
    const p2 = p1 ? shortestPath(g, nearestNode(g, wp1), nearestNode(g, wp2)) : null;
    if (!p1 || !p2) throw new Error("arc unroutable");
    const arcOut: LatLng[] = [...p1.slice(1), ...p2.slice(1)];
    const arc: LatLng[] = [...arcOut, ...arcOut.slice(0, -1).reverse()];
    const arcM = arcOut.slice(1).reduce((a, p, i) => a + meters(arcOut[i], p), 0);
    console.log(`headphone arc: ${arcOut.length} pts out, ${arcM.toFixed(0)} m (x2 retraced)`);
    const surg: LatLng[] = [...coords.slice(0, headTop.i + 1), ...arc, ...coords.slice(headTop.i + 1)];
    const png = path.join(OUT, `arc-r${rise}.png`);
    await renderMap(surg as any, [], png, 1200, 1000);
    const km2 = surg.slice(1).reduce((a, p, i) => a + meters(surg[i], p), 0) / 1000;
    const j = await judge(png);
    console.log(`arc r${rise}: ${km2.toFixed(1)} km | likeness ${j.likes.join("/")} | cold ${j.colds.join(" | ")} → ${png}`);
    const pts2 = surg.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(path.join(OUT, `arc-r${rise}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts2}\n</trkseg></trk>\n</gpx>\n`);
    return;
  }

  const startNode = nearestNode(g, anchor.p);
  // aim the nozzle WEST toward the hose side, reach given by CLI (default 420 m)
  const reach = Number(process.argv[2] ?? 420);
  let bestNode = -1, bestErr = Infinity;
  for (let i = 0; i < g.coord.length; i++) {
    const d = meters(g.coord[i], anchor.p);
    if (Math.abs(d - reach) < bestErr && g.coord[i][1] < anchor.p[1] && Math.abs(g.coord[i][0] - anchor.p[0]) < 0.0022) {
      bestErr = Math.abs(d - reach);
      bestNode = i;
    }
  }
  const out = shortestPath(g, startNode, bestNode);
  if (!out) throw new Error("no nozzle path");
  const outM = out.slice(1).reduce((a, p, i) => a + meters(out[i], p), 0);
  console.log(`nozzle stroke: ${out.length} pts, ${outM.toFixed(0)} m out (x2 retraced)`);
  // insert out-and-back at the anchor index
  const nozzle: LatLng[] = [...out.slice(1), ...out.slice(0, -1).reverse()];
  const surg: LatLng[] = [...coords.slice(0, anchor.i + 1), ...nozzle, ...coords.slice(anchor.i)];
  // wait: slice(anchor.i) duplicates anchor point; fix by slicing from anchor.i+1 after returning to anchor
  const surgFixed: LatLng[] = [...coords.slice(0, anchor.i + 1), ...nozzle, ...coords.slice(anchor.i + 1)];

  const png = path.join(OUT, `surgery-r${reach}.png`);
  await renderMap(surgFixed as any, [], png, 1200, 1000);
  const km = surgFixed.slice(1).reduce((a, p, i) => a + meters(surgFixed[i], p), 0) / 1000;
  const { likes, colds } = await judge(png);
  console.log(`surgery r${reach}: ${km.toFixed(1)} km | likeness ${likes.join("/")} | cold ${colds.join(" | ")} → ${png}`);
  const pts = surgFixed.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  await fs.writeFile(path.join(OUT, `surgery-r${reach}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
