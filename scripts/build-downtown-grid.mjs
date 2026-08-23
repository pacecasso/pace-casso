// Build a labeled intersection grid for the fine LES/Chinatown/Village
// downtown streets, from the cached OSM walk network. Columns = N-S streets
// (west->east), rows = E-W streets (north->south). Each cell is the real
// lat/lng where those two streets cross (closest node-pair). This gives the
// wordmark generator a fine, freely-spaced grid — unlike midtown's rigid
// 272 m avenues that made letters sprawl and read as one letter.
import fs from "node:fs";

const d = JSON.parse(fs.readFileSync("tmp-gas-spike/osm-walk-network.json", "utf8"));
const nodes = new Map();
for (const e of d.elements) if (e.type === "node") nodes.set(e.id, [e.lat, e.lon]);
const byName = new Map();
for (const e of d.elements) {
  if (e.type === "way" && e.tags?.name) {
    const pts = e.nodes.map((n) => nodes.get(n)).filter(Boolean);
    if (!byName.has(e.tags.name)) byName.set(e.tags.name, []);
    byName.get(e.tags.name).push(...pts);
  }
}

// N-S streets, west -> east. E-W streets, north -> south.
const COLS = ["Bowery", "Chrystie Street", "Forsyth Street", "Eldridge Street",
  "Allen Street", "Orchard Street", "Ludlow Street", "Essex Street",
  "Norfolk Street", "Suffolk Street", "Clinton Street", "Attorney Street",
  "Ridge Street", "Pitt Street"];
const ROWS = ["East Houston Street", "Stanton Street", "Rivington Street",
  "Delancey Street", "Broome Street", "Grand Street", "Hester Street", "Canal Street"];

const meters = ([la1, lo1], [la2, lo2]) => {
  const dLat = (la2 - la1) * 111320;
  const dLon = (lo2 - lo1) * 111320 * Math.cos((la1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};
function intersect(aName, bName) {
  const A = byName.get(aName), B = byName.get(bName);
  if (!A || !B) return null;
  let best = null, bd = Infinity;
  for (const p of A) for (const q of B) {
    const m = meters(p, q);
    if (m < bd) { bd = m; best = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; }
  }
  return bd < 60 ? best : null; // only real crossings
}

const grid = {};
for (const c of COLS) for (const r of ROWS) {
  const x = intersect(c, r);
  if (x) grid[`${c}|${r}`] = [Number(x[0].toFixed(6)), Number(x[1].toFixed(6))];
}
fs.writeFileSync("tmp-wordmark/downtown-grid.json", JSON.stringify({ COLS, ROWS, grid }, null, 0));

// report coverage + spacing
let filled = 0;
for (const c of COLS) for (const r of ROWS) if (grid[`${c}|${r}`]) filled++;
console.log(`cells: ${filled}/${COLS.length * ROWS.length}`);
// column spacing along Grand St
const gr = "Grand Street";
let prev = null;
for (const c of COLS) {
  const p = grid[`${c}|${gr}`];
  if (p && prev) console.log(`  ${c.padEnd(18)} <- ${Math.round(meters(prev, p))} m`);
  if (p) prev = p;
}
