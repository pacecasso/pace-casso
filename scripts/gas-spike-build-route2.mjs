/**
 * GAS spike step 3: compile the grid-native GAS logo design onto real
 * Midtown West streets and emit route + renders.
 *
 * Design grammar: every stroke is along a named street (row) or avenue (col).
 * The route is ONE continuous line; retraces (out-and-back on already-drawn
 * ink) are used instead of visible connectors.
 *
 * Run: node scripts/gas-spike-build-route2.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadNetwork, haversine } from "./gas-spike-lattice.mjs";

const outDir = path.join(process.cwd(), "tmp-gas-spike-v2");
await fs.mkdir(outDir, { recursive: true });

// ---------------------------------------------------------------- lattice ids
const ROWS = {}; // R0..R22 -> street name
for (let i = 0; i <= 22; i++) {
  const n = 34 + i;
  const suf = n % 10 === 1 && n % 100 !== 11 ? "st"
    : n % 10 === 2 && n % 100 !== 12 ? "nd"
    : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  ROWS[`R${i}`] = `West ${n}${suf} Street`;
}
const COLS = {
  A11: "11th Avenue",
  A10: "10th Avenue",
  A9: "9th Avenue",
  A8: "8th Avenue",
  A7: "7th Avenue",
  A6: "6th Avenue",
  A5: "5th Avenue",
  AMad: "Madison Avenue",
  APark: "Park Avenue",
  ALex: "Lexington Avenue",
  A3: "3rd Avenue",
};

/**
 * GAS logo v3 — high-detail. One continuous line; RT = retrace over own ink.
 *
 * Pump: A11-A9 x R1-R21, window A11-A10 x R15-R19 (2-row top margin).
 * Hose: out of port A9/R9 heading east, down A7, back west along R3, up A8
 *       CROSSING the out-line at A8/R9 (real loop), then nozzle east on R14.
 * Person: head AMad-ALex x R13-R17 (no internal lines, Park undrawn inside);
 *       ear cups A5-AMad and ALex-A3 x R14-R16; band R18 spanning A5-A3;
 *       shoulders = head bottom R13; torso AMad-ALex x R6-R13; legs to R1
 *       with feet ticks; hanging arm from ALex/R12 out to A3, down to R7.
 */
const WAYPOINTS = [
  // ---- pump ----
  ["A9", "R9"],   // start at hose port
  ["A9", "R1"],   // pump right edge, lower
  ["A11", "R1"],  // pump bottom
  ["A11", "R21"], // pump left edge (full height)
  ["A10", "R21"], // pump top, west half
  ["A11", "R21"], // RT west
  ["A11", "R19"], // RT down left edge to window top
  ["A10", "R19"], // window top
  ["A10", "R15"], // window right edge (down)
  ["A11", "R15"], // window bottom (closes against pump left edge)
  ["A11", "R21"], // RT up left edge
  ["A10", "R21"], // RT east along top
  ["A9", "R21"],  // pump top, east half
  ["A9", "R9"],   // pump right edge upper -> back at port
  // ---- hose with real crossing ----
  ["A7", "R9"],   // hose out (east, passes over 8th Ave)
  ["A7", "R3"],   // down (loop right side)
  ["A8", "R3"],   // loop bottom (west)
  ["A8", "R14"],  // up -- CROSSES the out-line at A8/R9
  ["A5", "R14"],  // nozzle line east (passes 7th, 6th)
  // ---- left ear cup bottom continues the nozzle line ----
  ["AMad", "R14"],// cup bottom east -> meets head left edge
  ["AMad", "R13"],// down to chin (head left edge, lower sliver)
  // ---- head (big, clean box; Park Ave inside is never drawn) ----
  ["ALex", "R13"],// head bottom = shoulders (east)
  ["ALex", "R17"],// head right edge (up)
  ["AMad", "R17"],// head top (west)
  ["AMad", "R14"],// head left edge (down) -> cup corner
  // ---- left ear cup ----
  ["A5", "R14"],  // RT west along cup bottom
  ["A5", "R16"],  // cup outer edge (up)
  ["AMad", "R16"],// cup top (east, closes against head side)
  ["A5", "R16"],  // RT west
  // ---- headphone band ----
  ["A5", "R18"],  // band riser (up)
  ["A3", "R18"],  // band (east, arcs over head)
  ["A3", "R16"],  // band riser (down)
  // ---- right ear cup ----
  ["ALex", "R16"],// cup top (west, closes against head side)
  ["A3", "R16"],  // RT east
  ["A3", "R14"],  // cup outer edge (down)
  ["ALex", "R14"],// cup bottom (west) -> meets head right edge
  // ---- torso, legs, feet ----
  ["ALex", "R13"],// RT down head edge to shoulder corner
  ["ALex", "R6"], // torso right side (down)
  ["ALex", "R1"], // right leg (down)
  ["A3", "R1"],   // right foot tick (east)
  ["ALex", "R1"], // RT west
  ["ALex", "R6"], // RT up to hip
  ["AMad", "R6"], // hip bar (west)
  ["AMad", "R1"], // left leg (down)
  ["A5", "R1"],   // left foot tick (west)
  ["AMad", "R1"], // RT east
  ["AMad", "R6"], // RT up left leg
  ["AMad", "R13"],// torso left side (up) -> chin
  // ---- hanging arm ----
  ["ALex", "R13"],// RT east along shoulders
  ["ALex", "R12"],// RT down torso edge to armpit
  ["A3", "R12"],  // arm out (east)
  ["A3", "R7"],   // forearm (down) -> end
];

// ---------------------------------------------------------------- compile
const net = await loadNetwork();
const { nodes, intersectionOf, corridorPath, walkPath } = net;

function resolve([colKey, rowKey]) {
  const id = intersectionOf(COLS[colKey], ROWS[rowKey]);
  if (!id) throw new Error(`no intersection: ${COLS[colKey]} & ${ROWS[rowKey]}`);
  return id;
}

/** Max perpendicular deviation (m) of path nodes from the chord a->b. */
function maxDeviation(pathIds, a, b) {
  const pa = nodes.get(a);
  const pb = nodes.get(b);
  const latM = 111320;
  const lonM = latM * Math.cos((pa[0] * Math.PI) / 180);
  const ax = 0, ay = 0;
  const bx = (pb[1] - pa[1]) * lonM, by = (pb[0] - pa[0]) * latM;
  const len = Math.hypot(bx, by) || 1;
  let max = 0;
  for (const id of pathIds) {
    const p = nodes.get(id);
    const px = (p[1] - pa[1]) * lonM, py = (p[0] - pa[0]) * latM;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / (len * len)));
    const d = Math.hypot(px - (ax + t * bx), py - (ay + t * by));
    max = Math.max(max, d);
  }
  return max;
}

const legReports = [];
const coordIds = [];
for (let i = 1; i < WAYPOINTS.length; i++) {
  const [c0, r0] = WAYPOINTS[i - 1];
  const [c1, r1] = WAYPOINTS[i];
  const from = resolve(WAYPOINTS[i - 1]);
  const to = resolve(WAYPOINTS[i]);
  const corridorName = c0 === c1 ? COLS[c0] : r0 === r1 ? ROWS[r0] : null;
  if (!corridorName) throw new Error(`diagonal leg: ${c0}/${r0} -> ${c1}/${r1}`);

  let p = corridorPath(corridorName, from, to);
  let via = "corridor";
  if (!p) {
    p = walkPath(from, to);
    via = "walk-graph";
  }
  if (!p) throw new Error(`unroutable leg ${corridorName}: ${c0}/${r0} -> ${c1}/${r1}`);
  const dev = maxDeviation(p, from, to);
  let m = 0;
  for (let k = 1; k < p.length; k++) m += haversine(nodes.get(p[k - 1]), nodes.get(p[k]));
  const chord = haversine(nodes.get(from), nodes.get(to));
  legReports.push({
    leg: `${c0}/${r0} -> ${c1}/${r1}`,
    corridor: corridorName,
    via,
    meters: Math.round(m),
    chord: Math.round(chord),
    maxDeviationM: Math.round(dev),
    detourRatio: Number((m / Math.max(chord, 1)).toFixed(2)),
  });
  if (coordIds.length === 0) coordIds.push(...p);
  else coordIds.push(...p.slice(1));
}

const coords = coordIds.map((id) => nodes.get(id));
let totalM = 0;
let maxHop = 0;
for (let i = 1; i < coords.length; i++) {
  const d = haversine(coords[i - 1], coords[i]);
  totalM += d;
  maxHop = Math.max(maxHop, d);
}

const bad = legReports.filter((l) => l.maxDeviationM > 45 || l.detourRatio > 1.25);
console.log(`legs: ${legReports.length}, route: ${(totalM / 1000).toFixed(1)} km, maxHop: ${Math.round(maxHop)} m`);
console.log(`legs via walk-graph fallback: ${legReports.filter((l) => l.via !== "corridor").length}`);
if (bad.length) {
  console.log("PROBLEM LEGS:");
  for (const l of bad) console.log("  ", JSON.stringify(l));
} else {
  console.log("all legs straight (deviation <= 45 m, detour <= 1.25x)");
}

await fs.writeFile(path.join(outDir, "route.json"), JSON.stringify({
  km: Number((totalM / 1000).toFixed(2)),
  maxHopM: Math.round(maxHop),
  coords,
  legs: legReports,
}, null, 2));

// ---------------------------------------------------------------- GPX
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>GAS logo v2 — Midtown</name><trkseg>
${coords.map(([lat, lon]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
await fs.writeFile(path.join(outDir, "GAS-SPIKE.gpx"), gpx);

// ---------------------------------------------------------------- renders
const width = 1200, height = 1400, tileSize = 256;

function lonToWorldX(lon, z) { return ((lon + 180) / 360) * tileSize * 2 ** z; }
function latToWorldY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * tileSize * 2 ** z;
}
let zoom = 16;
for (; zoom >= 11; zoom--) {
  const xs = coords.map(([, lon]) => lonToWorldX(lon, zoom));
  const ys = coords.map(([lat]) => latToWorldY(lat, zoom));
  if (Math.max(...xs) - Math.min(...xs) <= width * 0.86 &&
      Math.max(...ys) - Math.min(...ys) <= height * 0.86) break;
}
const xs = coords.map(([, lon]) => lonToWorldX(lon, zoom));
const ys = coords.map(([lat]) => latToWorldY(lat, zoom));
const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - width / 2;
const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - height / 2;
const screen = ([lat, lon]) => [lonToWorldX(lon, zoom) - vx, latToWorldY(lat, zoom) - vy];

const pathD = coords.map((c, i) => {
  const [x, y] = screen(c);
  return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
}).join(" ");

// map render with OSM tiles
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
    } catch { /* skip tile */ }
  }
}
const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <path d="${pathD}" fill="none" stroke="white" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
  <path d="${pathD}" fill="none" stroke="#e8342c" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);
await sharp({ create: { width, height, channels: 4, background: "#eee" } })
  .composite([...tiles, { input: overlay, left: 0, top: 0 }])
  .png().toFile(path.join(outDir, "GAS-SPIKE-map.png"));

// silhouette squint-test render (route only, black on white)
const sil = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="white"/>
  <path d="${pathD}" fill="none" stroke="black" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);
await sharp(sil).png().toFile(path.join(outDir, "GAS-SPIKE-silhouette.png"));

console.log(`zoom ${zoom}; wrote GAS-SPIKE-map.png, GAS-SPIKE-silhouette.png, GAS-SPIKE.gpx`);
