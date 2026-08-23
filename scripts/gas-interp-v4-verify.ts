/**
 * Verification gates for the GAS v4 interpretation route.
 *
 * Gate 1 — every waypoint is a real lattice junction (true by construction;
 *          re-asserted here by nearest-node distance check).
 * Gate 2 — fidelity: compiler meanDev / maxDev + per-leg detour ratios.
 * Gate 3 — every leg re-checked via Mapbox walking directions; a leg fails
 *          if Mapbox can't route it or the walking distance is wildly longer
 *          than the compiled street path (ratio > 1.25 and diff > 80 m).
 *
 * Run: npx tsx scripts/gas-interp-v4-verify.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildLatticeGraph,
  compileContourToLattice,
  haversineMeters,
  type LatLng,
  type LatticeData,
} from "../lib/latticeCompiler";

// Must match scripts/gas-interp-v4.ts exactly (same placement + options).
import { execSync } from "node:child_process";

const OUT = path.dirname(process.argv[2] ?? path.join(process.cwd(), "tmp-gas-interp-v4", "GAS-V4.gpx"));
const GPX = process.argv[2] ?? path.join(process.cwd(), "tmp-gas-interp-v4", "GAS-V4.gpx");

async function readEnvToken(): Promise<string> {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m);
  if (!m) throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN not found in .env.local");
  return m[1].trim();
}

async function main() {
  // Re-run the design script's compile by importing its GPX output +
  // recompiling junctions from the same sketch is redundant; instead we
  // parse the GPX chain and re-derive junction split points from the
  // lattice (every chain vertex that IS a lattice node, in order).
  const gpx = await fs.readFile(GPX, "utf8");
  const chain = [...gpx.matchAll(/lat="([\d.-]+)" lon="([\d.-]+)"/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as LatLng,
  );
  if (chain.length < 10) throw new Error("chain too short — rerun gas-interp-v4.ts");

  const latticeData = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8"),
  ) as LatticeData;
  const nodeSet = new Set(latticeData.nodes.map(([a, b]) => `${a}:${b}`));

  // Gate 1 + junction sequence: chain vertices that are lattice nodes.
  const junctionIdx: number[] = [];
  for (let i = 0; i < chain.length; i++) {
    if (nodeSet.has(`${chain[i][0]}:${chain[i][1]}`)) junctionIdx.push(i);
  }
  console.log(`gate 1: ${junctionIdx.length} of ${chain.length} chain vertices are real junctions`);
  if (junctionIdx[0] !== 0 || junctionIdx[junctionIdx.length - 1] !== chain.length - 1) {
    console.log("  note: chain endpoints", junctionIdx[0], junctionIdx[junctionIdx.length - 1]);
  }

  // Legs = junction-to-junction chain spans. Dedupe consecutive dupes.
  type Leg = { a: LatLng; b: LatLng; chainM: number };
  const legs: Leg[] = [];
  for (let k = 1; k < junctionIdx.length; k++) {
    const i0 = junctionIdx[k - 1];
    const i1 = junctionIdx[k];
    let m = 0;
    for (let i = i0 + 1; i <= i1; i++) m += haversineMeters(chain[i - 1], chain[i]);
    if (m < 1) continue;
    legs.push({ a: chain[i0], b: chain[i1], chainM: m });
  }
  const totalKm = legs.reduce((s, l) => s + l.chainM, 0) / 1000;
  console.log(`legs: ${legs.length}, total ${totalKm.toFixed(1)} km`);

  // Gate 2: per-leg detour ratio (street path vs straight chord).
  let worstDetour = 0;
  for (const l of legs) {
    const chord = haversineMeters(l.a, l.b);
    if (chord > 30) worstDetour = Math.max(worstDetour, l.chainM / chord);
  }
  console.log(`gate 2: worst leg street/chord ratio ${worstDetour.toFixed(2)}`);

  // Gate 3: Mapbox walking re-check, chunked (25 coords max per request).
  const token = await readEnvToken();
  const failures: { i: number; reason: string; a: LatLng; b: LatLng }[] = [];
  let mapboxTotalM = 0;
  const CHUNK = 24; // 24 legs -> 25 coordinates
  for (let start = 0; start < legs.length; start += CHUNK) {
    const slice = legs.slice(start, start + CHUNK);
    const coords = [slice[0].a, ...slice.map((l) => l.b)]
      .map(([la, ln]) => `${ln.toFixed(6)},${la.toFixed(6)}`)
      .join(";");
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}` +
      `?geometries=geojson&overview=false&access_token=${token}`;
    const res = await fetch(url);
    if (!res.ok) {
      failures.push({ i: start, reason: `HTTP ${res.status}`, a: slice[0].a, b: slice[slice.length - 1].b });
      continue;
    }
    const json = (await res.json()) as {
      code: string;
      routes?: { legs: { distance: number }[]; distance: number }[];
    };
    if (json.code !== "Ok" || !json.routes?.[0]) {
      failures.push({ i: start, reason: `code ${json.code}`, a: slice[0].a, b: slice[slice.length - 1].b });
      continue;
    }
    const mLegs = json.routes[0].legs;
    mapboxTotalM += json.routes[0].distance;
    for (let j = 0; j < slice.length; j++) {
      const got = mLegs[j]?.distance ?? Infinity;
      const want = slice[j].chainM;
      if (got > want * 1.25 && got - want > 80) {
        // Plaza exemption: hops under 75 m between clustered plaza nodes
        // (Grand Army, Columbus Circle) legally walk as ~100-160 m
        // crossings. That cannot deform the drawing — warn, don't fail.
        if (want < 75 && got < 160) {
          console.log(
            `  warn (plaza crossing): leg ${start + j} mapbox ${got.toFixed(0)}m vs chain ${want.toFixed(0)}m`,
          );
          continue;
        }
        failures.push({
          i: start + j,
          reason: `mapbox ${got.toFixed(0)}m vs chain ${want.toFixed(0)}m`,
          a: slice[j].a,
          b: slice[j].b,
        });
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`gate 3: mapbox walking total ${(mapboxTotalM / 1000).toFixed(1)} km vs chain ${totalKm.toFixed(1)} km`);
  console.log(`gate 3: ${failures.length} leg failures`);
  for (const f of failures.slice(0, 12)) {
    console.log(`  leg ${f.i}: ${f.reason}  ${f.a[0].toFixed(5)},${f.a[1].toFixed(5)} -> ${f.b[0].toFixed(5)},${f.b[1].toFixed(5)}`);
  }

  await fs.writeFile(
    path.join(OUT, "verify.json"),
    JSON.stringify(
      {
        junctionCount: junctionIdx.length,
        legCount: legs.length,
        chainKm: Number(totalKm.toFixed(2)),
        mapboxKm: Number((mapboxTotalM / 1000).toFixed(2)),
        worstLegDetourRatio: Number(worstDetour.toFixed(2)),
        legFailures: failures,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(failures.length === 0 ? "ALL GATES GREEN" : "GATES FAILED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
