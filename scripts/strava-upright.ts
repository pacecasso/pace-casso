// Upright two-tone Strava: combine what each era got right.
//  - codex's construction: trace the two chevrons as separate strokes with a
//    minimal connector, render two-tone like the real mark
//  - this session's law: orientation IS identity — sweep near-upright only
// Gate: likeness-to-upload ≥8 on all 3 samples (Ralph's bar; his "awful"
// verdict mapped to 7, his "better" to 8).
//
// Usage: npx tsx scripts/strava-upright.ts
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { getStreetGraph, traceContour, place, toUnit, type NormalizedPoint, type LatLng } from "../lib/streetGraphTrace";
import { extractNormalizedContourFromLineMask } from "../lib/extractNormalizedContourFromLineMask";
import { buildArtSpec } from "../lib/artSpec";

const require2 = createRequire(path.join(process.cwd(), "package.json"));
const sharp = require2("sharp");
const OUT = "tmp-studio/strava-upright";
let KEY = "";

// ---------------------------------------------------------------- extract
async function chevronStrokes(): Promise<NormalizedPoint[][]> {
  const BOX = 300;
  const { data, info } = await sharp("strava.png")
    .flatten({ background: "#ffffff" })
    .resize(BOX, BOX, { fit: "contain", background: "#ffffff" })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // The chevrons interlock (one connected component), but the mark itself
  // separates them by TONE: dark chevron lum ≈ 108, light ≈ 190. Build one
  // mask per luminance band and extract each ring separately.
  const rings: NormalizedPoint[][] = [];
  for (const [lo, hi] of [[0, 150], [150, 215]] as const) {
    const one = new Uint8Array(BOX * BOX);
    for (let i = 0; i < BOX * BOX; i++) {
      const r = data[i * info.channels], g = data[i * info.channels + 1], b = data[i * info.channels + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum >= lo && lum < hi) one[i] = 255;
    }
    const ring = extractNormalizedContourFromLineMask(one, 0.22, BOX, BOX, { source: "silhouette-outline" });
    if (!ring || ring.length < 6) throw new Error(`band ${lo}-${hi} extraction failed`);
    rings.push(ring);
  }
  // top chevron first (smaller mean y)
  rings.sort((a, b) => a.reduce((s, p) => s + p.y, 0) / a.length - b.reduce((s, p) => s + p.y, 0) / b.length);
  return rings;
}

// ------------------------------------------------------------ graph bits
function meters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestNodeId(g: any, p: LatLng): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.coord.length; i++) {
    const d = meters(g.coord[i], p);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// plain shortest path between two nodes (for the connector)
function shortestPath(g: any, a: number, b: number): LatLng[] | null {
  const dist = new Map<number, number>([[a, 0]]);
  const came = new Map<number, number>();
  const open = new Map<number, number>([[a, meters(g.coord[a], g.coord[b])]]);
  const done = new Set<number>();
  let guard = 0;
  while (open.size && guard++ < 300000) {
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

// ---------------------------------------------------------------- render
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
async function renderTwoTone(chains: { pts: LatLng[]; color: string; width: number }[], file: string, w = 1200, h = 1000) {
  const all = chains.flatMap((c) => c.pts);
  let zoom = 14;
  for (let z = 16; z >= 11; z--) {
    const xs = all.map((p) => lonToX(p[1], z)), ys = all.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.82 && Math.max(...ys) - Math.min(...ys) <= h * 0.82) { zoom = z; break; }
  }
  const xs = all.map((p) => lonToX(p[1], zoom)), ys = all.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: any[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const res = await fetch(`https://a.basemaps.cartocdn.com/light_all/${zoom}/${tx}/${ty}@2x.png`, { headers: { "User-Agent": "pace-casso route preview (dev)" } });
      if (!res.ok) continue;
      tiles.push({ input: await sharp(Buffer.from(await res.arrayBuffer())).resize(TILE, TILE).toBuffer(), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
    }
  }
  const pth = (pts: LatLng[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const paths = chains.map((c) => `<path d="${pth(c.pts)}" fill="none" stroke="${c.color}" stroke-width="${c.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
  const overlay = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } }).composite([...tiles, { input: overlay, left: 0, top: 0 }]).png().toFile(file);
}

// ---------------------------------------------------------------- judging
async function likeness(renderFile: string): Promise<number[]> {
  const a = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("strava.png").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const b = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(renderFile).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
  const prompt = `Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn on a city street map (two orange tones = two recorded activities). Score how clearly Image 2 depicts the SAME mark as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>`;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 512, messages: [{ role: "user", content: [a, b, { type: "text", text: prompt }] }] }),
    });
    const json: any = await res.json();
    const text = (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
    out.push(Number(text.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  return out;
}

// ------------------------------------------------------------------ main
async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });
  const [top, bottom] = await chevronStrokes();
  let g: any;
  if (process.env.BROOKLYN === "1") {
    const data = JSON.parse(await fs.readFile("tmp-wow/brooklyn-walk-graph.json", "utf8"));
    const nn = data.lat.length;
    const coord: LatLng[] = new Array(nn);
    for (let i = 0; i < nn; i++) coord[i] = [data.lat[i] / data.scale, data.lng[i] / data.scale];
    const adj: { to: number; w: number }[][] = Array.from({ length: nn }, () => []);
    for (let e = 0; e < data.edges.length; e += 2) {
      const a = data.edges[e], b = data.edges[e + 1];
      const w = meters(coord[a], coord[b]);
      adj[a].push({ to: b, w });
      adj[b].push({ to: a, w });
    }
    const grid = new Map<string, number[]>();
    for (let i = 0; i < nn; i++) {
      const k = `${Math.round(coord[i][0] / 0.003)}:${Math.round(coord[i][1] / 0.003)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(i);
    }
    g = { coord, adj, grid };
  } else {
    g = await getStreetGraph();
  }
  const BOUNDS = process.env.BROOKLYN === "1"
    ? { latMin: 40.6, latMax: 40.72, lngMin: -74.02, lngMax: -73.89 }
    : { latMin: 40.715, latMax: 40.78, lngMin: -74.005, lngMax: -73.95 };
  const bb = (r: NormalizedPoint[]) => ({
    x: [Math.min(...r.map((p) => p.x)), Math.max(...r.map((p) => p.x))].map((v) => +v.toFixed(2)),
    y: [Math.min(...r.map((p) => p.y)), Math.max(...r.map((p) => p.y))].map((v) => +v.toFixed(2)),
  });
  console.log(`chevrons: top ${top.length} pts ${JSON.stringify(bb(top))}, bottom ${bottom.length} pts ${JSON.stringify(bb(bottom))}`);
  // Relative placement sanity: the top chevron must sit ABOVE the bottom
  // one with overlapping x — if both rings normalized to their own bbox
  // (0..1 each) this check fails and the run must stop.
  const tb = bb(top), ob = bb(bottom);
  if (!(tb.y[0] < ob.y[0] && tb.y[1] < ob.y[1])) throw new Error("rings lost relative placement — extractor normalized per-component");

  // Shared normalization so relative position/scale of the two chevrons is
  // preserved exactly as in the mark.
  const both = [...top, ...bottom];
  const unitBoth = toUnit(both);
  const unitTop = unitBoth.slice(0, top.length);
  const unitBottom = unitBoth.slice(top.length);

  const results: any[] = [];
  const stats = { swept: 0, topFail: 0, botFail: 0, connFail: 0, tilted: 0 };
  const STRICT = process.env.RELAX !== "1";
  const covOk = (r: { coverage: number; maxGapM: number }) =>
    STRICT ? r.coverage >= 0.999999 && r.maxGapM === 0 : r.coverage >= 0.97 && r.maxGapM <= 60;
  // local grid bearing (mod 90) so edges ride streets — but orientation IS
  // identity for the mark, so only near-upright neighborhoods qualify.
  const localBearing = (center: LatLng): number => {
    const bins = new Array(45).fill(0);
    for (let i = 0; i < g.coord.length; i += 7) {
      if (meters(g.coord[i], center) > 900) continue;
      for (const { to, w } of g.adj[i] ?? []) {
        if (to < i || w < 40) continue;
        const dN = (g.coord[to][0] - g.coord[i][0]) * 111320;
        const dE = (g.coord[to][1] - g.coord[i][1]) * 111320 * Math.cos((g.coord[i][0] * Math.PI) / 180);
        let deg = ((Math.atan2(dE, dN) * 180) / Math.PI % 90 + 90) % 90;
        bins[Math.min(44, Math.floor(deg / 2))] += w;
      }
    }
    let best = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
    const d = best * 2 + 1;
    return d <= 45 ? d : d - 90;
  };
  for (const scale of [1400, 1800, 2300, 2900]) {
    {
      for (let lat = BOUNDS.latMin; lat <= BOUNDS.latMax; lat += 0.008) {
        for (let lng = BOUNDS.lngMin; lng <= BOUNDS.lngMax; lng += 0.008) {
          const rot = localBearing([lat, lng]);
          if (Math.abs(rot) > 20) { stats.tilted++; continue; }
          stats.swept++;
          const center: LatLng = [lat, lng];
          const targetTop = place(unitTop as any, center, scale, rot);
          const targetBottom = place(unitBottom as any, center, scale, rot);
          const rTop = traceContour(g, targetTop, { anchorM: 100, lambda: 12, corridorM: 90, closeLoop: true });
          if (!rTop.chain.length || !covOk(rTop)) { stats.topFail++; continue; }
          const rBot = traceContour(g, targetBottom, { anchorM: 100, lambda: 12, corridorM: 90, closeLoop: true });
          if (!rBot.chain.length || !covOk(rBot)) { stats.botFail++; continue; }
          // Minimal connector: the rings are closed loops, so each can start
          // anywhere — rotate both so the hop runs between their closest
          // points instead of end-to-start.
          let bi = 0, bj = 0, bd = Infinity;
          for (let i = 0; i < rTop.chain.length; i += 3) {
            for (let j = 0; j < rBot.chain.length; j += 3) {
              const d = meters(rTop.chain[i], rBot.chain[j]);
              if (d < bd) { bd = d; bi = i; bj = j; }
            }
          }
          const rotate = (chain: LatLng[], k: number) => {
            const closed = meters(chain[0], chain[chain.length - 1]) < 30;
            const core = closed ? chain.slice(0, -1) : chain;
            const rotated = [...core.slice(k), ...core.slice(0, k)];
            if (closed) rotated.push(rotated[0]);
            return rotated;
          };
          rTop.chain = rotate(rTop.chain, Math.min(bi, rTop.chain.length - 2));
          rBot.chain = rotate(rBot.chain, Math.min(bj, rBot.chain.length - 2));
          const endA = nearestNodeId(g, rTop.chain[rTop.chain.length - 1]);
          const startB = nearestNodeId(g, rBot.chain[0]);
          const conn = shortestPath(g, endA, startB);
          const connM = conn ? conn.slice(1).reduce((a, p, i) => a + meters(conn[i], p), 0) : Infinity;
          if (!conn || connM > 700) { stats.connFail++; continue; }
          const kmTop = rTop.chain.slice(1).reduce((a, p, i) => a + meters(rTop.chain[i], p), 0) / 1000;
          const kmBot = rBot.chain.slice(1).reduce((a, p, i) => a + meters(rBot.chain[i], p), 0) / 1000;
          results.push({ center, scale, rot, chainTop: rTop.chain, chainBot: rBot.chain, conn, connM, km: kmTop + kmBot + connM / 1000 });
        }
      }
    }
  }
  console.log(`stats: ${JSON.stringify(stats)} → surviving: ${results.length} (strict=${STRICT})`);
  if (!results.length) return;

  // Prefer upright, short connector, mid scale.
  results.sort((a, b) => (Math.abs(a.rot) - Math.abs(b.rot)) || (a.connM - b.connM));

  // POLISH mode: retrace the top placements at several anchor cadences —
  // sparser anchors trade contour-hugging for long deliberate runs (the
  // wobble Ralph reads as "not great"); judge every variant, keep the best.
  if (process.env.POLISH === "1") {
    const judgedP: any[] = [];
    for (const r of results.slice(0, 3)) {
      for (const anchorM of [100, 200, 320]) {
        const tTop = place(unitTop as any, r.center, r.scale, r.rot);
        const tBot = place(unitBottom as any, r.center, r.scale, r.rot);
        const pTop = traceContour(g, tTop, { anchorM, lambda: 12, corridorM: 90, closeLoop: true });
        const pBot = traceContour(g, tBot, { anchorM, lambda: 12, corridorM: 90, closeLoop: true });
        if (pTop.coverage < 0.999999 || pTop.maxGapM > 0 || pBot.coverage < 0.999999 || pBot.maxGapM > 0) {
          console.log(`polish a${anchorM} @${r.center}: gate fail`);
          continue;
        }
        let bi = 0, bj = 0, bd = Infinity;
        for (let i = 0; i < pTop.chain.length; i += 3) for (let j = 0; j < pBot.chain.length; j += 3) {
          const d = meters(pTop.chain[i], pBot.chain[j]);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
        const rot2 = (chain: LatLng[], k: number) => {
          const closed = meters(chain[0], chain[chain.length - 1]) < 30;
          const core = closed ? chain.slice(0, -1) : chain;
          const out = [...core.slice(k), ...core.slice(0, k)];
          if (closed) out.push(out[0]);
          return out;
        };
        const cTop = rot2(pTop.chain, Math.min(bi, pTop.chain.length - 2));
        const cBot = rot2(pBot.chain, Math.min(bj, pBot.chain.length - 2));
        const conn = shortestPath(g, nearestNodeId(g, cTop[cTop.length - 1]), nearestNodeId(g, cBot[0]));
        if (!conn) continue;
        const connM = conn.slice(1).reduce((a, p, i) => a + meters(conn[i], p), 0);
        if (connM > 700) continue;
        const file = path.join(OUT, `polish-${judgedP.length}-a${anchorM}.png`);
        await renderTwoTone([
          { pts: conn, color: "#9a9ea6", width: 2 },
          { pts: cTop, color: "#fc5200", width: 3 },
          { pts: cBot, color: "#fcb18a", width: 3 },
        ], file);
        const scores = await likeness(file);
        const km = (cTop.slice(1).reduce((a, p, i) => a + meters(cTop[i], p), 0) + cBot.slice(1).reduce((a, p, i) => a + meters(cBot[i], p), 0) + connM) / 1000;
        console.log(`polish a${anchorM} rot=${r.rot} scale=${r.scale} km=${km.toFixed(1)} conn=${connM.toFixed(0)}m likeness=${scores.join("/")} → ${file}`);
        judgedP.push({ anchorM, center: r.center, scale: r.scale, rot: r.rot, km, connM, scores, file, cTop, cBot, conn });
      }
    }
    judgedP.sort((a, b) => Math.min(...b.scores) - Math.min(...a.scores) || b.scores.reduce((x: number, y: number) => x + y, 0) - a.scores.reduce((x: number, y: number) => x + y, 0));
    const best = judgedP[0];
    if (best && Math.min(...best.scores) >= 8) {
      const pts = [...best.cTop, ...best.conn.slice(1), ...best.cBot.slice(1)];
      const gpx = pts.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
      await fs.writeFile(path.join(OUT, "keeper-polished.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>Strava mark</name><trkseg>\n${gpx}\n</trkseg></trk>\n</gpx>\n`);
      console.log(`POLISHED BEST: a${best.anchorM} likeness=${best.scores.join("/")} → ${best.file}`);
    }
    await fs.writeFile(path.join(OUT, "polish-summary.json"), JSON.stringify(judgedP.map(({ cTop, cBot, conn, ...rest }) => rest), null, 2));
    return;
  }
  const judged: any[] = [];
  for (const r of results.slice(0, 8)) {
    const file = path.join(OUT, `cand-${judged.length}.png`);
    await renderTwoTone([
      { pts: r.conn, color: "#9a9ea6", width: 2 },
      { pts: r.chainTop, color: "#fc5200", width: 3 },
      { pts: r.chainBot, color: "#fcb18a", width: 3 },
    ], file);
    const scores = await likeness(file);
    console.log(`cand-${judged.length}: rot=${r.rot} scale=${r.scale} km=${r.km.toFixed(1)} conn=${r.connM.toFixed(0)}m likeness=${scores.join("/")} → ${file}`);
    judged.push({ ...r, file, scores });
    if (Math.min(...scores) >= 8) {
      const pts = [...r.chainTop, ...r.conn.slice(1), ...r.chainBot.slice(1)];
      const gpx = pts.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
      await fs.writeFile(path.join(OUT, "keeper.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>Strava mark</name><trkseg>\n${gpx}\n</trkseg></trk>\n</gpx>\n`);
      console.log("KEEPER at the 8+ bar:", file);
      break;
    }
  }
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(judged.map(({ chainTop, chainBot, conn, ...rest }) => rest), null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
