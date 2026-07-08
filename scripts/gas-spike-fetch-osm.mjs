/**
 * GAS spike step 1: fetch the real walkable street network for Manhattan
 * (south of ~61st) from OSM Overpass and cache it locally.
 *
 * Run: node scripts/gas-spike-fetch-osm.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const outDir = path.join(process.cwd(), "tmp-gas-spike");
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, "osm-walk-network.json");

const query = `
[out:json][timeout:180];
(
  way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|footway|path|cycleway)$"]
     ["foot"!~"no"]
     ["area"!~"yes"]
     (40.700,-74.020,40.790,-73.950);
);
out body;
>;
out skel qt;
`;

const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

let data = null;
for (const url of endpoints) {
  try {
    console.log(`Fetching from ${url} ...`);
    const res = await fetch(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "pace-casso-gps-art-spike/1.0 (contact: ralph.sutton@gmail.com)",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.log(`  HTTP ${res.status}`);
      continue;
    }
    data = await res.json();
    break;
  } catch (e) {
    console.log(`  failed: ${e.message}`);
  }
}

if (!data) {
  console.error("All Overpass endpoints failed");
  process.exit(1);
}

const ways = data.elements.filter((e) => e.type === "way");
const nodes = data.elements.filter((e) => e.type === "node");
console.log(`ways: ${ways.length}, nodes: ${nodes.length}`);

await fs.writeFile(outPath, JSON.stringify(data));
console.log(`wrote ${outPath} (${((await fs.stat(outPath)).size / 1e6).toFixed(1)} MB)`);
