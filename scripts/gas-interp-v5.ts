/**
 * GAS logo interpretation v5 — reworked after Ralph rejected v4.
 *
 * What v4 got wrong (fresh-eyes + Ralph's "it wasn't good"):
 *   1. The head floated: band + jaw arcs met in a raggedy jumble at the
 *      neck, and nothing connected head to shoulders.
 *   2. No headphones. The band-only trick was too subtle — the logo's
 *      whole joke (listening to the nozzle) needs a visible EAR CUP with
 *      the hose flowing into it.
 *   3. No common ground line — pump and figure hovered at different
 *      heights instead of standing together like the badge.
 *
 * v5 composition (grid meters; x=0 at 10th Ave, y=0 at 17th St):
 *   - Both objects stand on 14th Street.
 *   - Pump: 10th Ave -> 6th Ave, 14th -> 44th, window upper-left
 *     (9th-7th x 35th-39th; PA owns 8th Ave 40-42 so the window stays
 *     below 39th, chamfered top clears it at 44th).
 *   - Hose: v4's proven coil verbatim (centered on 5th, r=300, bottom
 *     pinned to Madison Sq Park's north sidewalk) — the one part of v4
 *     that compiled beautifully. Exit swings east and dips, then rises
 *     up Lex INTO the ear cup: nozzle-at-ear pose, drawn not implied.
 *   - Ear cup: C-shape opening toward the head (Park-Lex x 35th-38th;
 *     GCT only blocks those crossings at 42-46).
 *   - Head: one continuous egg (Lex -> 1st) sitting directly on the
 *     shoulder line, crown slightly west of center for an organic tilt.
 *     Right side crosses 1st Ave at 35-38.5, clear of Tudor City 40-43.
 *   - Figure: shoulders 32nd, pants legs one block wide (Lex/3rd and
 *     2nd/1st) with a real two-column notch, feet on 14th.
 *
 * Run: npx tsx scripts/gas-interp-v5.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  buildLatticeGraph,
  compileContourToLattice,
  type LatLng,
  type LatticeData,
} from "../lib/latticeCompiler";

const ORIGIN_10TH_17TH: [number, number] = [40.744061, -74.006811];
const OUT = path.join(process.cwd(), "tmp-gas-interp-v5");

const STREET_BEARING = 119;
const AVENUE_BEARING = 29;
const M_PER_LAT = 111320;

function unit(deg: number): { e: number; n: number } {
  const r = (deg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}
const X_AXIS = unit(STREET_BEARING);
const Y_AXIS = unit(AVENUE_BEARING);

const origin: LatLng = ORIGIN_10TH_17TH;

function toLatLng([x, y]: [number, number]): LatLng {
  const e = x * X_AXIS.e + y * Y_AXIS.e;
  const n = x * X_AXIS.n + y * Y_AXIS.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}

function toLocal([lat, lng]: LatLng): [number, number] {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  const x = (e * Y_AXIS.n - Y_AXIS.e * n) / det;
  const y = (X_AXIS.e * n - e * X_AXIS.n) / det;
  return [x, y];
}

// Columns (measured along 36th St): 11th=-272 10th=0 9th=272 8th=548
// 7th=821 6th=1097 5th=1406 Mad=1560 Park=1707 Lex=1870 3rd=2026
// 2nd=2242 1st=2471
type Pt = [number, number];

function arc(
  cx: number, cy: number, rx: number, ry: number,
  startDeg: number, endDeg: number, steps = 24,
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

function bezier(p0: Pt, p1: Pt, p2: Pt, steps = 20): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return out;
}

const row = (street: number) => (street - 17) * 80;

// Column x positions used below
const AVE_10 = 0, AVE_9 = 272, AVE_8 = 548, AVE_7 = 821, AVE_6 = 1097;
const AVE_5 = 1406, MAD = 1560, PARK = 1707, LEX = 1870, AVE_3 = 2026;
const AVE_2 = 2242, AVE_1 = 2471;

function buildSketch(): Pt[] {
  const pts: Pt[] = [];
  const add = (...p: Pt[]) => pts.push(...p);
  const addArc = (...a: Parameters<typeof arc>) => pts.push(...arc(...a));
  const addBez = (...b: Parameters<typeof bezier>) => pts.push(...bezier(...b));

  // --- PUMP: start at the hose boss (6th & 33rd) and draw down-and-around
  //     so the outline closes with zero visible connector (v4 lesson). ---
  add([AVE_6, row(33)]);          // hose boss
  add([AVE_6, row(14)]);          // pump right side down to the ground
  add([AVE_10, row(14)]);         // ground line west along 14th
  add([AVE_10, row(42)]);         // up 10th Ave
  add([AVE_9, row(44)]);          // chamfered top-left (9th & 44th)
  add([AVE_7, row(44)]);          // top edge along 44th (8th & 44th clear of PA)
  add([AVE_6, row(42)]);          // chamfered top-right (6th & 42nd, Bryant W edge ok)
  add([AVE_6, row(39)]);          // down 6th to the window spur row
  // Window upper-left: spur west on 39th, loop, retrace the spur only.
  add([AVE_7, row(39)]);          // spur (will be retraced — straight, hidden)
  add([AVE_9, row(39)]);          // window top edge (8th & 39th clear: PA is 40-42)
  add([AVE_9, row(35)]);          // window left side down 9th
  add([AVE_7, row(35)]);          // window bottom (clear of Penn South 23-29)
  add([AVE_7, row(39)]);          // window right side closes the loop
  add([AVE_6, row(39)]);          // retrace spur back to the pump side
  add([AVE_6, row(33)]);          // down 6th to the boss — pump complete

  // --- HOSE: v4's proven coil, verbatim. Boss 33rd, loop top 33.5, bottom
  //     pinned to Madison Sq Park's north sidewalk (26th), centered on 5th
  //     so W/E extremes land on 6th and Park. Exit rides LOW (crosses Park
  //     ~32.5, clear of both the shoulder line at 30 and the cup at 35),
  //     then rises up Lex into the ear cup: nozzle-to-ear, drawn. ---
  addBez([AVE_6, row(33)], [1250, 1300], [1354, 1295], 10);
  addArc(AVE_5, 1000, 300, 300, 100, -260, 40);
  addBez([1458, 1295], [1650, 1380], [LEX, row(33)], 16);
  add([LEX, row(35)]);            // rise up Lex to the cup's bottom-inner corner

  // --- EAR CUP: closed spur loop like the pump window (proven pattern —
  //     enters and exits at the same corner, zero visible connector).
  //     Park & Lex are clean at 35-38; GCT blockage starts at 40. ---
  add([PARK, row(35)]);           // cup bottom edge west along 35th
  add([PARK, row(38)]);           // cup outer side up Park Ave
  add([LEX, row(38)]);            // cup top edge east along 38th
  add([LEX, row(35)]);            // cup inner side closes the loop
  add([LEX, row(38)]);            // retrace inner side (hidden) up to the band corner

  // --- HEAD: a round skull from two half-ellipses sharing the Lex/1st
  //     equator at 35.5 — crown (band) peaks at 39.5, jaw dips to 32.
  //     Both halves arrive VERTICALLY at the Lex end, so the band start,
  //     cup inner side, jaw end, and neck all merge into one clean line
  //     down Lex (a flat ear-side, like headphones clamping). Crown stays
  //     below 40th (Tudor City corners 40-43 are only crossed at 35.5 on
  //     1st); GCT never reaches east of Lex. ---
  addArc(2170, row(35.5), 301, 320, 180, 0, 26);   // band: Lex -> crown 39.5 -> 1st
  addArc(2170, row(35.5), 301, 280, 0, -180, 26);  // jaw: 1st -> under 32 -> back to Lex
  add([LEX, row(30)]);            // jaw flows into the neck, down Lex to the shoulders

  // --- BODY: torso Lex -> 1st (same width as the head, logo proportions),
  //     shoulders on 30th, and a hip step out to Park Ave S at 23rd so the
  //     legs clear Gramercy Park (Lex/Irving is dead 20-21). The hip step
  //     also keeps a full block of air between the coil (east extreme on
  //     Park at ~29.5) and the body. Legs one block wide with a real
  //     two-column notch: Park/3rd and 2nd/1st, feet on the 14th St ground
  //     line with the pump; Park Ave S runs clean along Union Square. ---
  add([LEX, row(23)]);            // torso left side down Lex (neck line continues)
  add([PARK, row(23)]);           // hip step west along 23rd
  add([PARK, row(14)]);           // outer left leg down Park Ave S
  add([AVE_3, row(14)]);          // under the left foot
  add([AVE_3, row(23)]);          // inner left leg up 3rd Ave
  add([AVE_2, row(23)]);          // crotch bar across 23rd
  add([AVE_2, row(14)]);          // inner right leg down 2nd Ave
  add([AVE_1, row(14)]);          // under the right foot
  add([AVE_1, row(30)]);          // outer right leg + torso up 1st Ave
  add([LEX, row(30)]);            // shoulder line closes at the neck base

  return pts;
}

// ---------------------------------------------------------------------------
// Render helpers (same as v4)
// ---------------------------------------------------------------------------
function localSvg(paths: { pts: Pt[]; color: string; width: number }[], w = 900): {
  svg: string; width: number; height: number;
} {
  const all = paths.flatMap((p) => p.pts);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs) - 150;
  const maxX = Math.max(...xs) + 150;
  const minY = Math.min(...ys) - 150;
  const maxY = Math.max(...ys) + 150;
  const scale = w / (maxX - minX);
  const h = Math.round((maxY - minY) * scale);
  const px = ([x, y]: Pt) =>
    `${((x - minX) * scale).toFixed(1)} ${((maxY - y) * scale).toFixed(1)}`;
  const body = paths
    .map(
      (p) =>
        `<path d="${p.pts.map((q, i) => `${i === 0 ? "M" : "L"} ${px(q)}`).join(" ")}" ` +
        `fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("\n");
  return {
    svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`,
    width: w,
    height: h,
  };
}

const TILE = 256;
function lonToX(lon: number, z: number) { return ((lon + 180) / 360) * TILE * 2 ** z; }
function latToY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
}

async function renderMap(chain: LatLng[], file: string, w = 1400, h = 1100) {
  let zoom = 13;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z));
    const ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.8 && Math.max(...ys) - Math.min(...ys) <= h * 0.8) {
      zoom = z;
      break;
    }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom));
  const ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
        headers: { "User-Agent": "pace-casso route preview (dev)" },
      });
      if (!res.ok) continue;
      tiles.push({
        input: Buffer.from(await res.arrayBuffer()),
        left: Math.round(tx * TILE - vx),
        top: Math.round(ty * TILE - vy),
      });
    }
  }
  const d = chain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`)
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#7f1024" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
      `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const sketch = buildSketch();
  let sketchKm = 0;
  for (let i = 1; i < sketch.length; i++) {
    sketchKm += Math.hypot(sketch[i][0] - sketch[i - 1][0], sketch[i][1] - sketch[i - 1][1]) / 1000;
  }

  const sk = localSvg([{ pts: sketch, color: "#111", width: 7 }]);
  await sharp(Buffer.from(sk.svg)).png().toFile(path.join(OUT, "1-sketch.png"));

  const latticeData = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8"),
  ) as LatticeData;
  const graph = buildLatticeGraph(latticeData);
  const placed = sketch.map(toLatLng);
  const result = compileContourToLattice(placed, graph, {
    sampleMeters: 38,
    pinRadiusMeters: 150,
  });
  if (!result) throw new Error("compile returned null");
  console.log({
    sketchKm: sketchKm.toFixed(1),
    km: result.km.toFixed(1),
    meanDev: result.meanDeviationMeters.toFixed(1),
    maxDev: result.maxDeviationMeters.toFixed(1),
    legs: result.legCount,
    skippedPins: result.skippedPins,
  });

  const compiledLocal = result.chain.map(toLocal);
  const cs = localSvg([
    { pts: sketch, color: "#f2b8c0", width: 4 },
    { pts: compiledLocal, color: "#111", width: 6 },
  ]);
  await sharp(Buffer.from(cs.svg)).png().toFile(path.join(OUT, "2-compiled.png"));

  await renderMap(result.chain, path.join(OUT, "3-map.png"));

  async function fit(file: string, w: number, h: number): Promise<Buffer> {
    return sharp(file).resize(w, h, { fit: "contain", background: "#fff" }).png().toBuffer();
  }
  const cell = 620;
  const sheet = sharp({
    create: { width: cell * 4 + 50, height: cell + 70, channels: 4, background: "#fff" },
  });
  const label = (t: string) =>
    Buffer.from(
      `<svg width="${cell}" height="40"><text x="10" y="28" font-family="Arial" font-size="24" font-weight="700" fill="#111">${t}</text></svg>`,
    );
  await sheet
    .composite([
      { input: await fit(path.join(process.cwd(), "gas.png"), cell, cell), left: 10, top: 60 },
      { input: await fit(path.join(OUT, "1-sketch.png"), cell, cell), left: cell + 20, top: 60 },
      { input: await fit(path.join(OUT, "2-compiled.png"), cell, cell), left: cell * 2 + 30, top: 60 },
      { input: await fit(path.join(OUT, "3-map.png"), cell, cell), left: cell * 3 + 40, top: 60 },
      { input: label("1. logo"), left: 10, top: 10 },
      { input: label("2. interpretive sketch"), left: cell + 20, top: 10 },
      { input: label("3. compiled to streets"), left: cell * 2 + 30, top: 10 },
      { input: label("4. on the map"), left: cell * 3 + 40, top: 10 },
    ])
    .png()
    .toFile(path.join(OUT, "SHEET.png"));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>GAS interpretation v5</name><trkseg>
${result.chain.map(([la, ln]) => `    <trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(OUT, "GAS-V5.gpx"), gpx, "utf8");
  await fs.writeFile(
    path.join(OUT, "meta.json"),
    JSON.stringify(
      {
        sketchKm: Number(sketchKm.toFixed(2)),
        routeKm: Number(result.km.toFixed(2)),
        meanDeviationMeters: Number(result.meanDeviationMeters.toFixed(1)),
        maxDeviationMeters: Number(result.maxDeviationMeters.toFixed(1)),
        legCount: result.legCount,
        skippedPins: result.skippedPins,
        origin,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("wrote", path.join(OUT, "SHEET.png"));
}

main().catch((e) => { console.error(e); process.exit(1); });
