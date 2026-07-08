/**
 * Fine-grid designs on the Lower East Side / East Village lattice.
 * LES N-S streets are ~70-98 m apart (4x finer than Midtown avenues) —
 * stairstep curves actually read as curves here.
 *
 * Run: node scripts/les-designs.mjs [heart|gas|all]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadNetwork, haversine } from "./gas-spike-lattice.mjs";

// Column names west->east. Chrystie/Allen/Essex/Clinton/Pitt continue north
// of Houston as 2nd Ave/1st Ave/Ave A/Ave B/Ave C (compiler's walk-graph
// fallback carries legs across the seam).
const C = {
  c0: "Bowery", c1: "Chrystie Street", c2: "Forsyth Street", c3: "Eldridge Street",
  c4: "Allen Street", c5: "Orchard Street", c6: "Ludlow Street", c7: "Essex Street",
  c8: "Norfolk Street", c9: "Suffolk Street", c10: "Clinton Street",
  c11: "Attorney Street", c12: "Ridge Street", c13: "Pitt Street",
  a2: "2nd Avenue", a1: "1st Avenue", aA: "Avenue A", aB: "Avenue B",
  aC: "Avenue C", aD: "Avenue D",
};
const R = {
  r0: "Canal Street", r1: "Hester Street", r2: "Grand Street", r3: "Broome Street",
  r4: "Delancey Street", r5: "Rivington Street", r6: "Stanton Street",
  r7: "East Houston Street",
  e1: "East 2nd Street", e2: "East 3rd Street", e3: "East 4th Street",
  e4: "East 5th Street", e5: "East 6th Street", e6: "East 7th Street",
  e7: "East 8th Street", e8: "East 9th Street", e9: "East 10th Street",
  e10: "East 11th Street", e11: "East 12th Street", e12: "East 13th Street",
};

const DESIGNS = {
  /**
   * Heart — closed outline, zero retraces, 14 columns of curve steps.
   * Widest Bowery->Pitt (~990 m), tip at Ludlow/Essex & Canal, crests at Houston.
   */
  heart: [
    ["c6", "r0"], // tip, west corner
    ["c5", "r0"],
    ["c5", "r1"],
    ["c4", "r1"],
    ["c4", "r2"],
    ["c2", "r2"],
    ["c2", "r3"],
    ["c0", "r3"],
    ["c0", "r6"], // left lobe outer edge
    ["c1", "r6"],
    ["c1", "r7"],
    ["c5", "r7"], // left lobe crest (4 cells wide)
    ["c5", "r6"],
    ["c6", "r6"],
    ["c6", "r5"],
    ["c7", "r5"], // dip between lobes (narrow V)
    ["c7", "r6"],
    ["c8", "r6"],
    ["c8", "r7"],
    ["c12", "r7"], // right lobe crest (4 cells wide)
    ["c12", "r6"],
    ["c13", "r6"],
    ["c13", "r3"], // right lobe outer edge (matches left, 3 rows)
    ["c10", "r3"],
    ["c10", "r2"],
    ["c8", "r2"],
    ["c7", "r2"],
    ["c7", "r0"],
    ["c6", "r0"], // close at tip
  ],

  /**
   * GAS logo — pump in LES (rounded shoulders, fully inset window),
   * hose loop with self-crossing, person in the East Village fine rows.
   */
  gas: [
    // ---- pump (start at hose port, Orchard & Delancey) ----
    ["c5", "r4"],
    ["c5", "r6"],  // right edge upper
    ["c4", "r6"],  // rounded shoulder (right)
    ["c4", "r7"],
    ["c1", "r7"],  // pump top
    ["c1", "r6"],  // rounded shoulder (left)
    ["c0", "r6"],
    ["c0", "r5"],  // left edge, upper part
    ["c1", "r5"],  // spur to window
    ["c1", "r6"],  // window left edge (up)
    ["c3", "r6"],  // window top... wait, drawn as loop below
    ["c3", "r5"],  // window right edge (down)
    ["c1", "r5"],  // window bottom (close)
    ["c0", "r5"],  // RT spur back to pump edge
    ["c0", "r2"],  // left edge, lower
    ["c5", "r2"],  // pump bottom
    ["c5", "r4"],  // right edge lower -> back at port
    // ---- hose: out, down, back, up through its own line ----
    ["c8", "r4"],  // out east along Delancey
    ["c8", "r2"],  // drop on Norfolk
    ["c6", "r2"],  // back west along Grand
    ["c6", "r5"],  // rise on Ludlow — CROSSES the out-line at Delancey
    ["c7", "r5"],  // east one fine block on Rivington
    ["c7", "r7"],  // rise on Essex to Houston
    ["aA", "r7"],  // seam: same corner, Avenue A naming
    ["aA", "e8"],  // continue up Avenue A (nozzle arm) to E 9th
    ["aB", "e8"],  // nozzle east -> ear at head bottom-left
    // ---- head (Ave B - Ave C x E9th - E12th) ----
    ["aC", "e8"],  // head bottom
    ["aC", "e11"], // head right edge
    ["aB", "e11"], // head top
    ["aB", "e8"],  // head left edge (down) -> closed
    // ---- left ear cup (A-B x E10-E11), sits on head left edge ----
    ["aB", "e9"],  // RT up head edge
    ["aA", "e9"],  // cup bottom (west)
    ["aA", "e10"], // cup outer edge
    ["aB", "e10"], // cup top (closes on head edge)
    ["aA", "e10"], // RT west along cup top
    // ---- headphone band (E13, floats above head top E12) ----
    ["aA", "e12"], // band riser (up A)
    ["aD", "e12"], // band across (E 13th)
    ["aD", "e10"], // band riser (down D)
    ["aC", "e10"], // right cup top (closes on head edge)
    ["aD", "e10"], // RT east
    ["aD", "e9"],  // cup outer edge (down)
    ["aC", "e9"],  // cup bottom (west, closes on head edge)
    // ---- torso + legs (B & C verticals) ----
    ["aC", "e8"],  // RT down head edge to bottom-right corner
    ["aC", "r7"],  // right torso + right leg (down C to Houston)
    ["aD", "r7"],  // right foot (east)
    ["aC", "r7"],  // RT west
    ["aC", "e3"],  // RT up to hip (E 4th)
    ["aB", "e3"],  // hip bar (west)
    ["aB", "r7"],  // left leg (down B to Houston)
    ["aA", "r7"],  // left foot (west)
    ["aB", "r7"],  // RT east
    ["aB", "e8"],  // left leg RT + left torso edge -> back at head corner
    // ---- hanging arm off the right shoulder ----
    ["aC", "e8"],  // RT east along head bottom (shoulder line)
    ["aD", "e8"],  // arm out (east)
    ["aD", "e5"],  // forearm down Avenue D -> end
  ],
};

// window drawn inline above needs its own tweak: replace placeholder comment
// (waypoints above already encode the loop: spur at r5, up c1, across to c3
// via r6, down c3, back along r5 — see design notes)

const net = await loadNetwork();
const { nodes, intersectionOf, corridorPath, walkPath } = net;

function resolve([colKey, rowKey]) {
  const id = intersectionOf(C[colKey], R[rowKey]);
  if (!id) throw new Error(`no intersection: ${C[colKey]} & ${R[rowKey]}`);
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
  const outDir = path.join(process.cwd(), "tmp-designs", name + "-les");
  await fs.mkdir(outDir, { recursive: true });

  const legReports = [];
  const coordIds = [];
  for (let i = 1; i < waypoints.length; i++) {
    const [c0k, r0k] = waypoints[i - 1];
    const [c1k, r1k] = waypoints[i];
    const from = resolve(waypoints[i - 1]);
    const to = resolve(waypoints[i]);
    if (from === to) continue;
    const corridorName = c0k === c1k ? C[c0k] : r0k === r1k ? R[r0k] : null;
    if (!corridorName) throw new Error(`diagonal leg: ${c0k}/${r0k} -> ${c1k}/${r1k}`);
    const pathLen = (ids) => {
      let m = 0;
      for (let k = 1; k < ids.length; k++) m += haversine(nodes.get(ids[k - 1]), nodes.get(ids[k]));
      return m;
    };
    let p = corridorPath(corridorName, from, to);
    let via = "corridor";
    const chordM = haversine(nodes.get(from), nodes.get(to));
    // dual-carriageway corridors (Allen, Houston, Delancey) sometimes BFS a
    // huge loop — take the walk-graph path whenever it is materially shorter
    if (!p || pathLen(p) > chordM * 1.25) {
      const w = walkPath(from, to);
      if (w && (!p || pathLen(w) < pathLen(p))) { p = w; via = "walk-graph"; }
    }
    if (!p) throw new Error(`unroutable: ${corridorName} ${c0k}/${r0k} -> ${c1k}/${r1k}`);
    const dev = maxDeviation(p, from, to);
    let m = 0;
    for (let k = 1; k < p.length; k++) m += haversine(nodes.get(p[k - 1]), nodes.get(p[k]));
    const chord = haversine(nodes.get(from), nodes.get(to));
    legReports.push({
      leg: `${c0k}/${r0k} -> ${c1k}/${r1k}`, corridor: corridorName, via,
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
  const bad = legReports.filter((l) => l.maxDeviationM > 40 || l.detourRatio > 1.3);
  console.log(`[${name}] legs ${legReports.length}, ${(totalM / 1000).toFixed(1)} km, maxHop ${Math.round(maxHop)} m, fallback ${legReports.filter((l) => l.via !== "corridor").length}, problem legs ${bad.length}`);
  for (const l of bad) console.log("   PROBLEM", JSON.stringify(l));

  await fs.writeFile(path.join(outDir, "route.json"), JSON.stringify({
    km: Number((totalM / 1000).toFixed(2)), maxHopM: Math.round(maxHop), coords, legs: legReports,
  }, null, 2));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name} — LES/East Village</name><trkseg>
${coords.map(([lat, lon]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(outDir, `${name}.gpx`), gpx);

  // upright silhouette — LES grid bearing ~ -61 deg from north for streets;
  // avenue axis ~ 29 deg like the rest of Manhattan south grid? LES rotates:
  // use principal-axis fit: rotate so most segments are axis-aligned.
  {
    const latM = 111320;
    const c0 = coords[0];
    const lonM = latM * Math.cos((c0[0] * Math.PI) / 180);
    const raw = coords.map(([lat, lon]) => [(lon - c0[1]) * lonM, (lat - c0[0]) * latM]);
    // grid bearing from the longest same-column leg (avenue axis -> vertical)
    let bestSpan = 0, bearing = 29 * Math.PI / 180;
    for (const wp of [waypoints]) {
      for (let i = 1; i < wp.length; i++) {
        if (wp[i][0] !== wp[i - 1][0]) continue;
        const a = nodes.get(resolve(wp[i - 1]));
        const b = nodes.get(resolve(wp[i]));
        const dN = (b[0] - a[0]) * latM;
        const dE = (b[1] - a[1]) * lonM;
        const span = Math.hypot(dN, dE);
        if (span > bestSpan) {
          bestSpan = span;
          let br = Math.atan2(dE, dN);
          if (Math.cos(br) < 0) br += Math.PI; // normalize to northish
          bearing = br;
        }
      }
    }
    const th = bearing;
    const pts = raw.map(([x, y]) => [
      x * Math.cos(th) - y * Math.sin(th),
      -(x * Math.sin(th) + y * Math.cos(th)),
    ]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = 900, H = 900, pad = 60;
    const s = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(pad + (p[0] - minX) * s).toFixed(1)} ${(pad + (p[1] - minY) * s).toFixed(1)}`).join(" ");
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="white"/><path d="${d}" fill="none" stroke="black" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
    let zoom = 17;
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
      <path d="${pathD}" fill="none" stroke="white" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
      <path d="${pathD}" fill="none" stroke="#fc4c02" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
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
