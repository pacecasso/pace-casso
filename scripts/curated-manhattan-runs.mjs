/**
 * Curated Manhattan run designs — shapes the street geography wants.
 * Each design is fully data-driven: its own corridor maps + waypoints.
 * Builds route + upright render + map render + GPX per design, and a
 * combined coords JSON ready to bake into lib/curatedManhattanRuns.ts.
 *
 * Run: node scripts/curated-manhattan-runs.mjs [name|all]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadNetwork, haversine } from "./gas-spike-lattice.mjs";

const st = (n) => {
  const suf = n % 10 === 1 && n % 100 !== 11 ? "st"
    : n % 10 === 2 && n % 100 !== 12 ? "nd"
    : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `West ${n}${suf} Street`;
};
const est = (n) => st(n).replace("West", "East");

/** Midtown/Chelsea west rows 14th..34th. */
const MW_ROWS = {};
for (let i = 0; i <= 34; i++) MW_ROWS[`R${i}`] = st(14 + i);
const MW_COLS = {
  A11: "11th Avenue", A10: "10th Avenue", A9: "9th Avenue", A8: "8th Avenue",
  A7: "7th Avenue", A6: "6th Avenue", A5: "5th Avenue",
};

/** East Village: cols west->east, rows Houston..E14th. */
const EV_COLS = { B2: "2nd Avenue", B1: "1st Avenue", BA: "Avenue A", BB: "Avenue B", BC: "Avenue C" };
const EV_ROWS = { e0: "East Houston Street" };
for (let i = 2; i <= 14; i++) EV_ROWS[`e${i}`] = est(i);

/** LES: fine north-south streets, rows Canal..Houston. */
const LES_COLS = {
  c0: "Bowery", c1: "Chrystie Street", c2: "Forsyth Street", c3: "Eldridge Street",
  c4: "Allen Street", c5: "Orchard Street", c6: "Ludlow Street", c7: "Essex Street",
  c8: "Norfolk Street", c9: "Suffolk Street", c10: "Clinton Street",
  c11: "Attorney Street", c12: "Ridge Street", c13: "Pitt Street",
};
const LES_ROWS = {
  r0: "Canal Street", r1: "Hester Street", r2: "Grand Street", r3: "Broome Street",
  r4: "Delancey Street", r5: "Rivington Street", r6: "Stanton Street",
  r7: "East Houston Street",
};

const DESIGNS = {
  /**
   * Top-down turtle in Chelsea (18th-28th, 11th-5th Ave), head east.
   * One closed loop: shell, 4 legs (N/S pairs), head box east, tail west.
   */
  turtle: {
    cols: MW_COLS, rows: MW_ROWS,
    waypoints: [
      ["A10", "R12"], // shell NW corner (26th)
      ["A10", "R14"], // front-left leg up (28th)
      ["A9", "R14"],
      ["A9", "R12"],  // leg down
      ["A8", "R12"],  // shell top between legs
      ["A7", "R12"],
      ["A7", "R14"],  // front-right leg up
      ["A6", "R14"],
      ["A6", "R12"],  // leg down -> shell NE corner
      ["A6", "R10"],  // east wall upper
      ["A5", "R10"],  // head top (24th)
      ["A5", "R8"],   // head east wall
      ["A6", "R8"],   // head bottom
      ["A6", "R6"],   // east wall lower -> SE corner (20th)
      ["A7", "R6"],   // bottom edge
      ["A7", "R4"],   // rear-right leg down (18th)
      ["A6", "R4"],
      ["A6", "R6"],   // wait — leg must protrude S; fixed: box below
      ["A7", "R6"],   // (recloses leg)
      ["A8", "R6"],   // bottom edge between legs
      ["A9", "R6"],
      ["A9", "R4"],   // rear-left leg down
      ["A10", "R4"],
      ["A10", "R6"],  // leg up -> shell SW corner
      ["A10", "R9"],  // west wall lower
      ["A11", "R9"],  // tail top (23rd — clear of 11th Ave gaps)
      ["A11", "R10"], // tail west edge
      ["A10", "R10"], // tail bottom
      ["A10", "R12"], // west wall upper -> close
    ],
  },

  /**
   * Robot head in Chelsea south (15th-27th, 10th-6th).
   * Box head, antenna nubs, visor + mouth counters bridged down the center.
   */
  robot: {
    cols: MW_COLS, rows: MW_ROWS,
    waypoints: [
      ["A10", "R11"], // head top-left (25th)
      ["A10", "R14"], // left antenna up (28th; 27th dead-ends at 9th)
      ["A9", "R14"],
      ["A9", "R11"],  // antenna down
      ["A8", "R11"],  // top edge center
      ["A7", "R11"],
      ["A7", "R14"],  // right antenna up
      ["A6", "R14"],
      ["A6", "R11"],  // antenna down -> head top-right
      ["A6", "R1"],   // right wall down (15th)
      ["A10", "R1"],  // chin
      ["A10", "R11"], // left wall up -> close
      ["A9", "R11"],  // RT east along top edge
      ["A8", "R11"],  // RT to center
      ["A8", "R9"],   // bridge down (new) -> visor top
      ["A9", "R9"],   // visor: top-west
      ["A9", "R7"],   // visor west wall
      ["A7", "R7"],   // visor bottom
      ["A7", "R9"],   // visor east wall
      ["A8", "R9"],   // visor top-east -> close
      ["A9", "R9"],   // RT west along visor top
      ["A9", "R7"],   // RT down visor west wall
      ["A8", "R7"],   // RT east along visor bottom
      ["A8", "R5"],   // bridge down (new) -> mouth top
      ["A9", "R5"],   // mouth: top-west
      ["A9", "R3"],   // mouth west wall
      ["A7", "R3"],   // mouth bottom
      ["A7", "R5"],   // mouth east wall
      ["A8", "R5"],   // mouth top-east -> close, END
    ],
  },

  /**
   * Sailboat in Midtown west (34th-46th, 10th-6th).
   * Trapezoid hull, thin mast up 8th Ave, stair-step mainsail + jib.
   */
  sailboat: {
    cols: MW_COLS, rows: MW_ROWS,
    waypoints: [
      ["A10", "R23"], // hull deck west (37th)
      ["A5", "R23"],  // deck east (wider than the sails)
      ["A5", "R21"],  // stern step down
      ["A6", "R21"],
      ["A6", "R20"],  // keel step (34th)
      ["A9", "R20"],  // keel west
      ["A9", "R21"],  // bow step up
      ["A10", "R21"],
      ["A10", "R23"], // -> hull closed
      ["A8", "R23"],  // RT east along deck to mast base
      ["A8", "R32"],  // mast up (46th) — thin line, deliberate
      ["A7", "R32"],  // mainsail: stair-step leech from mast top
      ["A7", "R29"],
      ["A6", "R29"],
      ["A6", "R26"],
      ["A5", "R26"],
      ["A5", "R24"],  // sail clew (38th)
      ["A8", "R24"],  // boom west back to mast
      ["A8", "R30"],  // RT up mast to jib head
      ["A9", "R30"],  // jib: luff west
      ["A9", "R24"],  // jib leading edge down
      ["A8", "R24"],  // jib foot east -> meets boom at mast, END
    ],
  },

  /**
   * Tulip in the East Village (Houston-E13th, 2nd Ave-Ave C).
   * Two-peak cup with center dip, stem line down Ave A, leaf ticks.
   */
  tulip: {
    cols: EV_COLS, rows: EV_ROWS,
    waypoints: [
      ["B1", "e6"],   // cup bottom-left (E 6th)
      ["B1", "e13"],  // left wall up (E 13th)
      ["BA", "e13"],  // left petal plateau
      ["BA", "e10"],  // center dip down (E 10th)
      ["BB", "e10"],  // dip across
      ["BB", "e13"],  // right petal up
      ["BC", "e13"],  // right petal plateau
      ["BC", "e6"],   // right wall down
      ["B1", "e6"],   // cup bottom -> closed
      ["BA", "e6"],   // RT east along bottom to stem
      ["BA", "e3"],   // stem down (E 3rd)
      ["B2", "e3"],   // left leaf tick (west, 2 gaps)
      ["BA", "e3"],   // RT back
      ["BA", "e2"],   // stem down (E 2nd)
      ["BC", "e2"],   // right leaf tick (east, 2 gaps)
      ["BA", "e2"],   // RT back
      ["BA", "e0"],   // stem to Houston, END
    ],
  },

  /**
   * Duck in the LES (Grand-Stanton, Bowery-Attorney), facing west.
   * Body, head, beak tick, tail box — one loop plus the beak tick.
   */
  duck: {
    cols: LES_COLS, rows: LES_ROWS,
    waypoints: [
      ["c1", "r7"],   // head top-west (Houston)
      ["c4", "r7"],   // head top east
      ["c4", "r5"],   // back of head down to body top (Rivington)
      ["c10", "r5"],  // body top east
      ["c10", "r6"],  // tail box up (Stanton)
      ["c11", "r6"],
      ["c11", "r5"],  // tail box down
      ["c10", "r5"],  // tail closes
      ["c10", "r2"],  // body back wall down (Grand)
      ["c2", "r2"],   // body bottom west
      ["c2", "r5"],   // breast up (Rivington)
      ["c1", "r5"],   // head underside (overhangs the breast)
      ["c1", "r6"],   // face up to beak level (Stanton)
      ["c0", "r6"],   // beak tick west (Bowery)
      ["c1", "r6"],   // RT back
      ["c1", "r7"],   // face up -> close, END
    ],
  },
};

// ---------------------------------------------------------------- builder
const net = await loadNetwork();
const { nodes, intersectionOf, corridorPath, walkPath } = net;

function resolveIn(design, [colKey, rowKey]) {
  const col = design.cols[colKey];
  const row = design.rows[rowKey];
  if (!col || !row) throw new Error(`bad key ${colKey}/${rowKey}`);
  const id = intersectionOf(col, row);
  if (!id) throw new Error(`no intersection: ${col} & ${row}`);
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

export async function buildDesign(name, design) {
  const outDir = path.join(process.cwd(), "tmp-curated", name);
  await fs.mkdir(outDir, { recursive: true });
  const waypoints = design.waypoints;

  const legReports = [];
  const coordIds = [];
  for (let i = 1; i < waypoints.length; i++) {
    const [c0k, r0k] = waypoints[i - 1];
    const [c1k, r1k] = waypoints[i];
    const from = resolveIn(design, waypoints[i - 1]);
    const to = resolveIn(design, waypoints[i]);
    if (from === to) continue;
    const corridorName = c0k === c1k ? design.cols[c0k] : r0k === r1k ? design.rows[r0k] : null;
    if (!corridorName) throw new Error(`diagonal leg: ${c0k}/${r0k} -> ${c1k}/${r1k}`);
    const pathLen = (ids) => {
      let m = 0;
      for (let k = 1; k < ids.length; k++) m += haversine(nodes.get(ids[k - 1]), nodes.get(ids[k]));
      return m;
    };
    let p = corridorPath(corridorName, from, to);
    let via = "corridor";
    const chordM = haversine(nodes.get(from), nodes.get(to));
    if (!p || pathLen(p) > chordM * 1.25) {
      const w = walkPath(from, to);
      if (w && (!p || pathLen(w) < pathLen(p))) { p = w; via = "walk-graph"; }
    }
    if (!p) throw new Error(`unroutable: ${corridorName} ${c0k}/${r0k} -> ${c1k}/${r1k}`);
    const dev = maxDeviation(p, from, to);
    let m = 0;
    for (let k = 1; k < p.length; k++) m += haversine(nodes.get(p[k - 1]), nodes.get(p[k]));
    legReports.push({
      leg: `${c0k}/${r0k} -> ${c1k}/${r1k}`, corridor: corridorName, via,
      meters: Math.round(m), chord: Math.round(chordM),
      maxDeviationM: Math.round(dev),
      detourRatio: Number((m / Math.max(chordM, 1)).toFixed(2)),
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
  const bad = legReports.filter((l) => l.maxDeviationM > 45 || l.detourRatio > 1.3);
  console.log(`[${name}] legs ${legReports.length}, ${(totalM / 1000).toFixed(1)} km, maxHop ${Math.round(maxHop)} m, fallback ${legReports.filter((l) => l.via !== "corridor").length}, problem legs ${bad.length}`);
  for (const l of bad) console.log("   PROBLEM", JSON.stringify(l));

  await fs.writeFile(path.join(outDir, "route.json"), JSON.stringify({
    km: Number((totalM / 1000).toFixed(2)), maxHopM: Math.round(maxHop), coords, legs: legReports,
  }, null, 2));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name} — Manhattan</name><trkseg>
${coords.map(([lat, lon]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(outDir, `${name}.gpx`), gpx);

  // upright render (rotate grid-vertical using longest same-col leg)
  {
    const latM = 111320;
    const c0 = coords[0];
    const lonM = latM * Math.cos((c0[0] * Math.PI) / 180);
    let bestSpan = 0, bearing = (28.9 * Math.PI) / 180;
    for (let i = 1; i < waypoints.length; i++) {
      if (waypoints[i][0] !== waypoints[i - 1][0]) continue;
      let a, b;
      try { a = nodes.get(resolveIn(design, waypoints[i - 1])); b = nodes.get(resolveIn(design, waypoints[i])); } catch { continue; }
      const dN = (b[0] - a[0]) * latM, dE = (b[1] - a[1]) * lonM;
      const span = Math.hypot(dN, dE);
      if (span > bestSpan) {
        bestSpan = span;
        let br = Math.atan2(dE, dN);
        if (Math.cos(br) < 0) br += Math.PI;
        bearing = br;
      }
    }
    const th = bearing;
    const pts = coords.map(([lat, lon]) => {
      const x = (lon - c0[1]) * lonM, y = (lat - c0[0]) * latM;
      return [x * Math.cos(th) - y * Math.sin(th), -(x * Math.sin(th) + y * Math.cos(th))];
    });
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = 900, H = 900, pad = 60;
    const sc = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(pad + (p[0] - minX) * sc).toFixed(1)} ${(pad + (p[1] - minY) * sc).toFixed(1)}`).join(" ");
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="white"/><path d="${d}" fill="none" stroke="black" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, "upright.png"));
  }

  // map render
  {
    const width = 1100, height = 1100, tileSize = 256;
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
            headers: { "User-Agent": "pace-casso-curated-runs/1.0" },
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
  return { name, km: Number((totalM / 1000).toFixed(2)), coords };
}

const which = process.argv[2] ?? "all";
const names = which === "all" ? Object.keys(DESIGNS) : [which];
for (const n of names) {
  await buildDesign(n, DESIGNS[n]);
}
