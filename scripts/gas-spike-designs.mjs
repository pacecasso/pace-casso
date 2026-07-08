/**
 * Multi-design compiler: proves the lattice approach generalizes.
 * Designs are pure waypoint lists on named corridors — same compile,
 * render, and verification for all of them.
 *
 * Run: node scripts/gas-spike-designs.mjs [heart|cat|gas4|all]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadNetwork, haversine } from "./gas-spike-lattice.mjs";

const ROWS = {};
for (let i = 0; i <= 24; i++) {
  const n = 34 + i;
  const suf = n % 10 === 1 && n % 100 !== 11 ? "st"
    : n % 10 === 2 && n % 100 !== 12 ? "nd"
    : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  ROWS[`R${i}`] = `West ${n}${suf} Street`;
}
const COLS = {
  A11: "11th Avenue", A10: "10th Avenue", A9: "9th Avenue", A8: "8th Avenue",
  A7: "7th Avenue", A6: "6th Avenue", A5: "5th Avenue", AMad: "Madison Avenue",
  APark: "Park Avenue", ALex: "Lexington Avenue", A3: "3rd Avenue",
  A2: "2nd Avenue", A1: "1st Avenue",
};

const DESIGNS = {
  /** Symmetric pixel heart — one closed outline, zero retraces. */
  heart: [
    ["A8", "R0"],  // bottom tip, west corner
    ["A8", "R2"],  // lower-left flank step up
    ["A9", "R2"],
    ["A9", "R5"],
    ["A10", "R5"],
    ["A10", "R13"], // left lobe outer edge
    ["A9", "R13"],  // left lobe crest
    ["A9", "R11"],  // inner descent to the dip
    ["A8", "R11"],
    ["A8", "R10"],
    ["A7", "R10"],  // dip between the lobes
    ["A7", "R11"],
    ["A6", "R11"],
    ["A6", "R13"],  // inner ascent of right lobe
    ["A5", "R13"],  // right lobe crest
    ["A5", "R5"],   // right lobe outer edge
    ["A6", "R5"],   // lower-right flank step down
    ["A6", "R2"],
    ["A7", "R2"],
    ["A7", "R0"],
    ["A8", "R0"],   // close at the tip
  ],

  /** Sitting cat, side profile facing west — protruding head, ears, tail. */
  cat: [
    ["A2", "R3"],   // start at tail hook tip
    ["A1", "R3"],   // tail hook east
    ["A1", "R6"],   // tail rises to rump corner
    ["A2", "R6"],   // body bottom (west)
    ["A2", "R5"],   // hind paw tick (down)
    ["A2", "R6"],   // RT up
    ["A3", "R6"],   // body bottom (west)
    ["A3", "R5"],   // front-leg divider tick (down)
    ["A3", "R6"],   // RT up
    ["ALex", "R6"], // body bottom to chest corner
    ["ALex", "R13"],// chest / front edge (up)
    ["AMad", "R13"],// chin — head overhangs body to the west
    ["AMad", "R17"],// face front edge (up)
    ["AMad", "R19"],// left ear outer (up)
    ["APark", "R19"],// left ear top
    ["APark", "R17"],// left ear inner (down)
    ["ALex", "R17"],// head top, gap between ears
    ["ALex", "R19"],// right ear inner (up)
    ["A3", "R19"],  // right ear top
    ["A3", "R17"],  // right ear outer (down)
    ["A3", "R13"],  // head back edge (down)
    ["A1", "R13"],  // back line (east)
    ["A1", "R6"],   // rump (down) -> meets tail at corner
  ],

  /** GAS v4 — v3 plus a nozzle-hand tick at the ear. */
  gas4: [
    ["A9", "R9"],
    ["A9", "R1"],
    ["A11", "R1"],
    ["A11", "R21"],
    ["A10", "R21"],
    ["A11", "R21"],
    ["A11", "R19"],
    ["A10", "R19"],
    ["A10", "R15"],
    ["A11", "R15"],
    ["A11", "R21"],
    ["A10", "R21"],
    ["A9", "R21"],
    ["A9", "R9"],
    ["A7", "R9"],
    ["A7", "R3"],
    ["A8", "R3"],
    ["A8", "R14"],
    ["A6", "R14"],
    ["A6", "R13"],  // nozzle hand tick (down)
    ["A6", "R14"],  // RT up
    ["A5", "R14"],
    ["AMad", "R14"],
    ["AMad", "R13"],
    ["ALex", "R13"],
    ["ALex", "R17"],
    ["AMad", "R17"],
    ["AMad", "R14"],
    ["A5", "R14"],
    ["A5", "R16"],
    ["AMad", "R16"],
    ["A5", "R16"],
    ["A5", "R18"],
    ["A3", "R18"],
    ["A3", "R16"],
    ["ALex", "R16"],
    ["A3", "R16"],
    ["A3", "R14"],
    ["ALex", "R14"],
    ["ALex", "R13"],
    ["ALex", "R6"],
    ["ALex", "R1"],
    ["A3", "R1"],
    ["ALex", "R1"],
    ["ALex", "R6"],
    ["AMad", "R6"],
    ["AMad", "R1"],
    ["A5", "R1"],
    ["AMad", "R1"],
    ["AMad", "R6"],
    ["AMad", "R13"],
    ["ALex", "R13"],
    ["ALex", "R12"],
    ["A3", "R12"],
    ["A3", "R7"],
  ],
};

const net = await loadNetwork();
const { nodes, intersectionOf, corridorPath, walkPath } = net;

function resolve([colKey, rowKey]) {
  const id = intersectionOf(COLS[colKey], ROWS[rowKey]);
  if (!id) throw new Error(`no intersection: ${COLS[colKey]} & ${ROWS[rowKey]}`);
  return id;
}

function maxDeviation(pathIds, a, b) {
  const pa = nodes.get(a);
  const pb = nodes.get(b);
  const latM = 111320;
  const lonM = latM * Math.cos((pa[0] * Math.PI) / 180);
  const bx = (pb[1] - pa[1]) * lonM, by = (pb[0] - pa[0]) * latM;
  const len = Math.hypot(bx, by) || 1;
  let max = 0;
  for (const id of pathIds) {
    const p = nodes.get(id);
    const px = (p[1] - pa[1]) * lonM, py = (p[0] - pa[0]) * latM;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / (len * len)));
    max = Math.max(max, Math.hypot(px - t * bx, py - t * by));
  }
  return max;
}

async function buildDesign(name, waypoints) {
  const outDir = path.join(process.cwd(), "tmp-designs", name);
  await fs.mkdir(outDir, { recursive: true });

  const legReports = [];
  const coordIds = [];
  for (let i = 1; i < waypoints.length; i++) {
    const [c0, r0] = waypoints[i - 1];
    const [c1, r1] = waypoints[i];
    const from = resolve(waypoints[i - 1]);
    const to = resolve(waypoints[i]);
    const corridorName = c0 === c1 ? COLS[c0] : r0 === r1 ? ROWS[r0] : null;
    if (!corridorName) throw new Error(`diagonal leg: ${c0}/${r0} -> ${c1}/${r1}`);
    let p = corridorPath(corridorName, from, to);
    let via = "corridor";
    if (!p) { p = walkPath(from, to); via = "walk-graph"; }
    if (!p) throw new Error(`unroutable: ${corridorName} ${c0}/${r0} -> ${c1}/${r1}`);
    const dev = maxDeviation(p, from, to);
    let m = 0;
    for (let k = 1; k < p.length; k++) m += haversine(nodes.get(p[k - 1]), nodes.get(p[k]));
    const chord = haversine(nodes.get(from), nodes.get(to));
    legReports.push({
      leg: `${c0}/${r0} -> ${c1}/${r1}`, corridor: corridorName, via,
      meters: Math.round(m), chord: Math.round(chord),
      maxDeviationM: Math.round(dev),
      detourRatio: Number((m / Math.max(chord, 1)).toFixed(2)),
    });
    if (coordIds.length === 0) coordIds.push(...p);
    else coordIds.push(...p.slice(1));
  }

  const coords = coordIds.map((id) => nodes.get(id));
  let totalM = 0, maxHop = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    totalM += d;
    maxHop = Math.max(maxHop, d);
  }
  const bad = legReports.filter((l) => l.maxDeviationM > 45 || l.detourRatio > 1.25);
  console.log(`[${name}] legs ${legReports.length}, ${(totalM / 1000).toFixed(1)} km, maxHop ${Math.round(maxHop)} m, fallback ${legReports.filter((l) => l.via !== "corridor").length}, problem legs ${bad.length}`);
  for (const l of bad) console.log("   PROBLEM", JSON.stringify(l));

  await fs.writeFile(path.join(outDir, "route.json"), JSON.stringify({
    km: Number((totalM / 1000).toFixed(2)), maxHopM: Math.round(maxHop), coords, legs: legReports,
  }, null, 2));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name} — Midtown</name><trkseg>
${coords.map(([lat, lon]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(outDir, `${name}.gpx`), gpx);

  // upright silhouette (rotated so the avenue axis is vertical)
  {
    const latM = 111320;
    const c0 = coords[0];
    const lonM = latM * Math.cos((c0[0] * Math.PI) / 180);
    const th = (28.9 * Math.PI) / 180;
    const pts = coords.map(([lat, lon]) => {
      const x = (lon - c0[1]) * lonM, y = (lat - c0[0]) * latM;
      return [x * Math.cos(th) - y * Math.sin(th), -(x * Math.sin(th) + y * Math.cos(th))];
    });
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = 900, H = 820, pad = 60;
    const s = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(pad + (p[0] - minX) * s).toFixed(1)} ${(pad + (p[1] - minY) * s).toFixed(1)}`).join(" ");
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="white"/><path d="${d}" fill="none" stroke="black" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, "upright.png"));
  }

  // map render
  {
    const width = 1200, height = 1200, tileSize = 256;
    const lonToX = (lon, z) => ((lon + 180) / 360) * tileSize * 2 ** z;
    const latToY = (lat, z) => {
      const r = (lat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * tileSize * 2 ** z;
    };
    let zoom = 16;
    for (; zoom >= 11; zoom--) {
      const xs = coords.map(([, lon]) => lonToX(lon, zoom));
      const ys = coords.map(([lat]) => latToY(lat, zoom));
      if (Math.max(...xs) - Math.min(...xs) <= width * 0.86 &&
          Math.max(...ys) - Math.min(...ys) <= height * 0.86) break;
    }
    const xs = coords.map(([, lon]) => lonToX(lon, zoom));
    const ys = coords.map(([lat]) => latToY(lat, zoom));
    const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - width / 2;
    const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - height / 2;
    const screen = ([lat, lon]) => [lonToX(lon, zoom) - vx, latToY(lat, zoom) - vy];
    const pathD = coords.map((c, i) => {
      const [x, y] = screen(c);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    const tiles = [];
    for (let tx = Math.floor(vx / tileSize); tx <= Math.floor((vx + width) / tileSize); tx++) {
      for (let ty = Math.floor(vy / tileSize); ty <= Math.floor((vy + height) / tileSize); ty++) {
        try {
          const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
            headers: { "User-Agent": "pace-casso-gps-art-spike/1.0" },
          });
          if (!res.ok) continue;
          tiles.push({
            input: Buffer.from(await res.arrayBuffer()),
            left: Math.round(tx * tileSize - vx),
            top: Math.round(ty * tileSize - vy),
          });
        } catch { /* skip */ }
      }
    }
    const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <path d="${pathD}" fill="none" stroke="white" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
      <path d="${pathD}" fill="none" stroke="#e8342c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`);
    await sharp({ create: { width, height, channels: 4, background: "#eee" } })
      .composite([...tiles, { input: overlay, left: 0, top: 0 }])
      .png().toFile(path.join(outDir, "map.png"));
  }
  return { name, km: Number((totalM / 1000).toFixed(2)) };
}

const which = process.argv[2] ?? "all";
const names = which === "all" ? Object.keys(DESIGNS) : [which];
for (const n of names) {
  await buildDesign(n, DESIGNS[n]);
}
