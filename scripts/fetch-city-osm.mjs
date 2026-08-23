import fs from "node:fs/promises";
import path from "node:path";

const PRESETS = {
  manhattan: { south: 40.698, west: -74.02, north: 40.882, east: -73.958 },
  brooklyn: { south: 40.57, west: -74.03, north: 40.74, east: -73.855 },
  queens: { south: 40.70, west: -73.90, north: 40.78, east: -73.77 },
  chicago: { south: 41.79, west: -87.74, north: 41.99, east: -87.58 },
  sf: { south: 37.73, west: -122.52, north: 37.81, east: -122.385 },
  dc: { south: 38.82, west: -77.12, north: 38.99, east: -76.91 },
};

const city = process.argv[2];
if (!city || !PRESETS[city]) {
  console.error(`Usage: node scripts/fetch-city-osm.mjs <${Object.keys(PRESETS).join("|")}>`);
  process.exit(1);
}
const b = PRESETS[city];
const outDir = path.join(process.cwd(), "tmp-city-osm", city);
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, "osm-walk-network.json");

const query = `
[out:json][timeout:240];
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

const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];

let data = null;
for (const url of endpoints) {
  try {
    console.log(`Fetching ${city} from ${url} ...`);
    const res = await fetch(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "pace-casso-gps-art-city-search/1.0",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.log(`  HTTP ${res.status}`);
      continue;
    }
    data = await res.json();
    break;
  } catch (error) {
    console.log(`  failed: ${error.message}`);
  }
}

if (!data) {
  console.error(`All Overpass endpoints failed for ${city}`);
  process.exit(1);
}
const ways = data.elements.filter((e) => e.type === "way").length;
const nodes = data.elements.filter((e) => e.type === "node").length;
await fs.writeFile(outPath, JSON.stringify(data));
const stat = await fs.stat(outPath);
console.log(JSON.stringify({ city, ways, nodes, outPath, mb: +(stat.size / 1e6).toFixed(1) }, null, 2));
