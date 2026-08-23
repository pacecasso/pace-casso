// Element-level tongue rebuild (subject: stones.webp) — serpentine MASS fill.
// Authored parametric pieces; the SKETCH must clear the gates before any
// street tracing (WOW law). Sketch-only mode: npx tsx scripts/gas-authored.ts sketch
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const OUT = "tmp-studio/stones-authored";
let KEY = "";

type P = [number, number]; // x, y (0-1, y down)

// ---- the drawing --------------------------------------------------------
// TONGUE logo: lips bow (ring), teeth band (ring), tongue lobe (ring) with
// a serpentine MASS fill inside (the reference grammar for solid regions).
const lipsRing: P[] = [
  [0.08, 0.44],
  [0.10, 0.30], [0.17, 0.19], [0.27, 0.155], [0.36, 0.205],  // left lobe
  [0.455, 0.285],                                             // cupid dip
  [0.55, 0.205], [0.64, 0.155], [0.74, 0.19], [0.82, 0.30],  // right lobe
  [0.88, 0.42], [0.905, 0.46],                                // right corner
  [0.80, 0.415], [0.63, 0.375], [0.46, 0.41], [0.30, 0.375], [0.145, 0.415], // mouth opening (inner edge)
  [0.08, 0.44],
];
const teethBand: P[] = [
  [0.165, 0.435], [0.795, 0.415],
  [0.80, 0.525],
  [0.70, 0.55], [0.61, 0.515], [0.52, 0.555], [0.43, 0.52], [0.34, 0.555], [0.25, 0.52], // scalloped bottom
  [0.17, 0.545],
  [0.165, 0.435],
];
// tongue ATTACHED at the mouth, long sweeping lick down-right (the logo's
// defining feature per the judges), with a central groove + shading pass
const tongueRing: P[] = [
  [0.30, 0.545], [0.62, 0.535],          // attached across the mouth bottom
  [0.74, 0.60], [0.80, 0.73],            // sweep right
  [0.77, 0.87], [0.655, 0.955],          // long tapered tip
  [0.52, 0.935], [0.415, 0.845], [0.335, 0.70],
  [0.30, 0.545],
];
// single full-length central crease (a hook read as "spiral" — removed)
const fillStroke: P[] = [
  [0.545, 0.575], [0.585, 0.68], [0.615, 0.78], [0.625, 0.875],
];

const PIECES: { name: string; pts: P[] }[] = [
  { name: "lips", pts: lipsRing },
  { name: "teeth", pts: teethBand },
  { name: "tongue", pts: tongueRing },
  { name: "fill", pts: fillStroke },
];

// ---- render + judge -----------------------------------------------------
async function renderSketch(file: string) {
  const polys = PIECES.map(({ pts }) => `<polyline points="${pts.map(([x, y]) => `${(60 + x * 880).toFixed(1)},${(60 + y * 880).toFixed(1)}`).join(" ")}" fill="none" stroke="black" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`).join("");
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="100%" height="100%" fill="white"/>${polys}</svg>`)).png().toFile(file);
}

async function api(content: any[], mt = 1024): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-fable-5", max_tokens: mt, messages: [{ role: "user", content }] }),
  });
  const json: any = await res.json();
  return (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
}

// ---- streets ------------------------------------------------------------
async function streets() {
  const { traceContour, place, toUnit } = await import("../lib/streetGraphTrace");
  const { renderMap } = await import("./trace-contour");
  type LatLng = [number, number];
  const meters = (a: LatLng, b: LatLng) => {
    const R = 6371000, dLat = ((b[0] - a[0]) * Math.PI) / 180, dLng = ((b[1] - a[1]) * Math.PI) / 180;
    const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2));
  };
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
  const CELL = 0.003;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i][0] / CELL)}:${Math.round(coord[i][1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  const g: any = { coord, adj, grid };
  const nearestNodeId = (p: LatLng): number => {
    let best = -1, bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${Math.round(p[0] / CELL) + dy}:${Math.round(p[1] / CELL) + dx}`;
      for (const i of (grid.get(k) ?? [])) {
        const d = meters(coord[i], p);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
  const shortestPath = (a: number, b: number): LatLng[] | null => {
    if (a < 0 || b < 0) return null;
    const dist = new Map<number, number>([[a, 0]]);
    const came = new Map<number, number>();
    const open = new Map<number, number>([[a, meters(coord[a], coord[b])]]);
    const done = new Set<number>();
    let guard = 0;
    while (open.size && guard++ < 200000) {
      let cur = -1, cf = Infinity;
      for (const [nn, f] of open) if (f < cf) { cf = f; cur = nn; }
      if (cur === b) {
        const out = [b];
        let w = b;
        while (came.has(w)) { w = came.get(w)!; out.push(w); }
        return out.reverse().map((i) => coord[i]);
      }
      open.delete(cur);
      done.add(cur);
      for (const { to, w } of adj[cur] ?? []) {
        if (done.has(to)) continue;
        const t = dist.get(cur)! + w;
        if (t < (dist.get(to) ?? Infinity)) {
          dist.set(to, t);
          came.set(to, cur);
          open.set(to, t + meters(coord[to], coord[b]));
        }
      }
    }
    return null;
  };

  const all = PIECES.flatMap((p) => p.pts.map(([x, y]) => ({ x, y })));
  const unit = toUnit(all as any);
  const unitPieces: any[] = [];
  let off = 0;
  for (const p of PIECES) {
    unitPieces.push(unit.slice(off, off + p.pts.length));
    off += p.pts.length;
  }
  const OPTIONAL = new Set(["teeth", "fill"]);
  const fails: Record<string, number> = {};
  const cands: any[] = [];
  const SCALES = process.env.MID === "1" ? [1900, 2300] : process.env.BIG === "1" ? [2300, 2800] : [1500, 1900, 2300, 2800];
  // Local grid bearing: a composition is only clean when its rotation
  // matches the neighborhood's grid (v11 was aligned in Gravesend; the same
  // art at rot 0 in Bushwick's 30° grid saw-tooths into "jellyfish").
  const localBearing = (center: LatLng): number => {
    const bins = new Array(45).fill(0); // 2° bins over 0-90
    const CELL2 = 0.003;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const k = `${Math.round(center[0] / CELL2) + dy}:${Math.round(center[1] / CELL2) + dx}`;
      for (const i of (grid.get(k) ?? [])) {
        for (const { to, w } of adj[i]) {
          if (to < i || w < 40) continue;
          const dN = (coord[to][0] - coord[i][0]) * 111320;
          const dE = (coord[to][1] - coord[i][1]) * 111320 * Math.cos((coord[i][0] * Math.PI) / 180);
          let deg = (Math.atan2(dE, dN) * 180) / Math.PI; // bearing from north
          deg = ((deg % 90) + 90) % 90;
          bins[Math.min(44, Math.floor(deg / 2))] += w;
        }
      }
    }
    let best = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
    const d = best * 2 + 1;
    return d <= 45 ? d : d - 90;
  };
  for (const scale of SCALES) {
    for (let lat = 40.63; lat <= 40.735; lat += 0.008) {
      for (let lng = -74.0; lng <= -73.89; lng += 0.008) {
        const rot = localBearing([lat, lng]);
        {
          const center: LatLng = [lat, lng];
          const idx = Object.fromEntries(PIECES.map((p, i) => [p.name, i]));
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
          // 1) FIGURE first (hardest piece), with its own local nudge
          let figChain: LatLng[] | null = null, figDN = 0, figDE = 0;
          figOuter: for (const dN of [0, 130, -130, 260, -260]) {
            for (const dE of [0, 130, -130]) {
              const t = nudge(place(unitPieces[idx.lips], center, scale, rot) as any, dN, dE);
              const c = tryTrace(t);
              if (c) { figChain = c; figDN = dN; figDE = dE; break figOuter; }
            }
          }
          if (!figChain) { fails.lips = (fails.lips ?? 0) + 1; continue; }
          // 2) TONGUE hangs from the mouth — nudge WITH the lips plus a
          //    small independent slide (stay attached)
          let pumpChain: LatLng[] | null = null, winChain: LatLng[] | null = null;
          let pumpDN = 0, pumpDE = 0;
          outer: for (const dN of [0, 130, -130]) {
            for (const dE of [0, 130, -130]) {
              const t = nudge(place(unitPieces[idx.tongue], center, scale, rot) as any, figDN + dN, figDE + dE);
              const c = tryTrace(t);
              if (c) { pumpChain = c; pumpDN = figDN + dN; pumpDE = figDE + dE; break outer; }
            }
          }
          if (!pumpChain) { fails.tongue = (fails.tongue ?? 0) + 1; continue; }
          // TEETH ride inside the mouth — nudge relative to the LIPS
          winOuter: for (const wdN of [0, 130, -130]) {
            for (const wdE of [0, 130, -130]) {
              winChain = tryTrace(nudge(place(unitPieces[idx.teeth], center, scale, rot) as any, figDN + wdN, figDE + wdE));
              if (winChain) break winOuter;
            }
          }
          // 3) FILL rides rigidly inside the tongue
          const fillChain = tryTrace(nudge(place(unitPieces[idx.fill], center, scale, rot) as any, pumpDN, pumpDE), 120);
          const chains: { name: string; chain: LatLng[] }[] = [
            { name: "lips", chain: figChain },
            ...(winChain ? [{ name: "teeth", chain: winChain }] : []),
            { name: "tongue", chain: pumpChain },
            ...(fillChain ? [{ name: "fill", chain: fillChain }] : []),
          ];
          // rotate each closed ring chain to start nearest the previous end
          const rotChain = (chain: LatLng[], near: LatLng): LatLng[] => {
            if (meters(chain[0], chain[chain.length - 1]) > 60) return chain; // open
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
          // Joint rotation for pump→window→hose: a ring inserted between two
          // fixed points enters and exits at ONE point (start=end), so pick
          // the window point minimizing hop-in + hop-out together, then
          // rotate the pump to meet it. Rotate-to-previous alone exited the
          // window on the far side from the holster (33 → 1 survivors).
          if (chains[1]?.name === "teeth") {
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
          let connOk = true, extras = 0;
          for (let i = 1; i < chains.length; i++) {
            chains[i].chain = rotChain(chains[i].chain, full[full.length - 1]);
            const conn = shortestPath(nearestNodeId(full[full.length - 1]), nearestNodeId(chains[i].chain[0]));
            if (!conn) { connOk = false; break; }
            const connM = conn.slice(1).reduce((a, p, j) => a + meters(conn[j], p), 0);
            const hopCap = OPTIONAL.has(chains[i].name) || (i > 0 && OPTIONAL.has(chains[i - 1].name)) ? 1100 : 500;
            if (connM > hopCap) { fails[`conn:${chains[i].name}`] = (fails[`conn:${chains[i].name}`] ?? 0) + 1; connOk = false; break; }
            full.push(...conn.slice(1), ...chains[i].chain.slice(1));
          }
          if (!connOk) { fails.conn = (fails.conn ?? 0) + 1; continue; }
          const km = full.slice(1).reduce((a, p, i) => a + meters(full[i], p), 0) / 1000;
          if (km < 10 || km > 62) { fails.km = (fails.km ?? 0) + 1; continue; }
          cands.push({ center, scale, rot, chain: full, km, parts: chains.map((c) => c.name).join("+") });
        }
      }
    }
  }
  console.log(`surviving placements: ${cands.length}; fails ${JSON.stringify(fails)}`);
  if (!cands.length) return;
  // prefer complete compositions, then big scale, then upright
  cands.sort((a, b) => b.parts.length - a.parts.length || b.scale - a.scale || Math.abs(a.rot) - Math.abs(b.rot));
  const diverse: any[] = [];
  for (const cand of cands) {
    if (diverse.some((d) => d.scale === cand.scale && Math.abs(d.rot - cand.rot) < 5 && meters(d.center, cand.center) < 2500)) continue;
    diverse.push(cand);
    if (diverse.length >= 10) break;
  }
  const upload = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("stones.webp").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  for (let c = 0; c < diverse.length; c++) {
    const cand = diverse[c];
    const png = path.join(OUT, `street-${c}.png`);
    await renderMap(cand.chain as any, [], png, 1200, 1000);
    const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(png).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
    const likes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await api([upload, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as a thin orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color; judge the mouth, teeth and tongue shapes. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }], 512);
      likes.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
    }
    const colds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await api([img, { type: "text", text: 'The orange line is a GPS route someone recorded while running - they were trying to "draw" a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words>\nCONFIDENCE: <0-10>' }]);
      colds.push(`"${(t.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? "").trim()}" ${t.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? 0}`);
    }
    console.log(`street-${c}: [${cand.parts}] rot=${cand.rot} scale=${cand.scale} km=${cand.km.toFixed(1)} likeness=${likes.join("/")} cold=${colds.join(" | ")}`);
    (diverse[c] as any).judged = likes;
    if (Math.min(...likes) >= 8) {
      const pts = cand.chain.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
      await fs.writeFile(path.join(OUT, `keeper-street-${c}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
      console.log(`KEEPER at the 8+ likeness bar: street-${c}`);
      break;
    }
  }
  // archive the best judged candidate regardless of gate
  const judged = diverse.filter((d: any) => d.judged);
  if (judged.length) {
    judged.sort((a: any, b: any) => Math.min(...b.judged) - Math.min(...a.judged) || b.judged.reduce((x: number, y: number) => x + y, 0) - a.judged.reduce((x: number, y: number) => x + y, 0));
    const best: any = judged[0];
    const pts = best.chain.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(path.join(OUT, "best-street.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
    console.log(`best judged saved: likeness ${best.judged.join("/")} → best-street.gpx`);
  }
}

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });
  if (process.argv[2] === "streets") {
    await streets();
    return;
  }
  const png = path.join(OUT, "sketch.png");
  await renderSketch(png);
  console.log("sketch:", png);
  const upload = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("stones.webp").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: (await fs.readFile(png)).toString("base64") } };
  for (let i = 0; i < 3; i++) {
    const t = await api([img, { type: "text", text: 'This is a one-line drawing. What does it depict? Reply exactly:\nGUESS: <1-4 words>\nCONFIDENCE: <0-10>' }]);
    console.log("cold:", t.replace(/\s+/g, " ").slice(0, 90));
  }
  for (let i = 0; i < 3; i++) {
    const t = await api([upload, img, { type: "text", text: "Image 1 is a customer's uploaded logo. Image 2 is a line-art interpretation of it. Score 0-10 how clearly Image 2 depicts the SAME subject (0 unrelated, 10 unmistakable). Reply SCORE: <n> then one sentence: the single most impactful improvement." }]);
    console.log("likeness:", t.replace(/\s+/g, " ").slice(0, 220));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
