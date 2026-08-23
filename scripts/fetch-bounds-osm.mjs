import fs from "node:fs/promises";
import path from "node:path";
const [name, south, west, north, east] = process.argv.slice(2);
if (!name || !south || !west || !north || !east) {
  console.error("Usage: node scripts/fetch-bounds-osm.mjs <name> <south> <west> <north> <east>");
  process.exit(1);
}
const b = { south: +south, west: +west, north: +north, east: +east };
const outDir = path.join(process.cwd(), "tmp-city-osm", name);
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "bounds.json"), JSON.stringify(b, null, 2));
const outPath = path.join(outDir, "osm-walk-network.json");
const query = `
[out:json][timeout:180];
(
  way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|footway|path|cycleway|service)$"]
     ["foot"!~"no"]
     ["access"!~"private"]
     ["area"!~"yes"]
     (${b.south},${b.west},${b.north},${b.east});
);
out body;
>;
out skel qt;
`;
const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.osm.jp/api/interpreter"];
let data = null;
for (const url of endpoints) {
  try {
    console.log(`Fetching ${name} from ${url} ...`);
    const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "pace-casso-gps-art-bounds-search/1.0", Accept: "application/json" } });
    if (!res.ok) { console.log(`  HTTP ${res.status}`); continue; }
    data = await res.json();
    break;
  } catch (error) { console.log(`  failed: ${error.message}`); }
}
if (!data) { console.error(`All Overpass endpoints failed for ${name}`); process.exit(1); }
await fs.writeFile(outPath, JSON.stringify(data));
const ways = data.elements.filter((e) => e.type === "way").length;
const nodes = data.elements.filter((e) => e.type === "node").length;
const stat = await fs.stat(outPath);
console.log(JSON.stringify({ name, ways, nodes, mb: +(stat.size / 1e6).toFixed(1), outPath }, null, 2));
