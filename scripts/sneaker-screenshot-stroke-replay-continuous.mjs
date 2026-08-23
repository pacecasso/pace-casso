import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { prepareTracedBinaryComponents, centerlinePolylineFromPreparedBinary } = jiti("../lib/centerlineFromMask.ts");
const { buildGraph, nearestNode, corridorPath, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-sneaker-screenshot-strokes", stamp);
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };
const FITS = [
  { id: "fit-01", left: 0, right: 390, top: 218, bottom: 444, north: 40.729, south: 40.703, west: -74.016, east: -73.981 },
  { id: "fit-02", left: 0, right: 390, top: 212, bottom: 460, north: 40.729, south: 40.703, west: -74.016, east: -73.981 },
  { id: "fit-03", left: 0, right: 390, top: 218, bottom: 444, north: 40.733, south: 40.703, west: -74.016, east: -73.976 },
];

const idx = (x, y, w) => y * w + x;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function routePixel(r, g, b) {
  return r >= 138 && g >= 78 && g <= 190 && b >= 55 && b <= 178 && r - g >= 18 && g - b >= 4 && r - b >= 36;
}
function llToLocal([lat, lng]) {
  return [(lng - PROJ.lng0) * PROJ.mPerLng, (lat - PROJ.lat0) * M_PER_LAT];
}
function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function simplifyByDistance(points, minDist) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || dist(last, p) >= minDist) { out.push(p); last = p; }
  }
  const tail = points[points.length - 1];
  if (tail && out.length && dist(out[out.length - 1], tail) > 0.01) out.push(tail);
  return out;
}
function simplifyLatLng(points, minMeters) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || meters(last, p) >= minMeters) { out.push(p); last = p; }
  }
  const tail = points[points.length - 1];
  if (tail && out.length && meters(out[out.length - 1], tail) > 1) out.push(tail);
  return out;
}
function neighbors8(x, y, w, h) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push([nx, ny]);
  }
  return out;
}
function components(mask, w, h) {
  const seen = new Uint8Array(w * h), out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const start = idx(x, y, w);
    if (!mask[start] || seen[start]) continue;
    const stack = [[x, y]], pixels = [];
    seen[start] = 1;
    let minX = x, minY = y, maxX = x, maxY = y;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      pixels.push([cx, cy]);
      minX = Math.min(minX, cx); minY = Math.min(minY, cy); maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
      for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
        const ni = idx(nx, ny, w);
        if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push([nx, ny]); }
      }
    }
    out.push({ pixels, count: pixels.length, bbox: { minX, minY, maxX, maxY } });
  }
  return out.sort((a, b) => b.count - a.count);
}
async function extractStrokes() {
  const { data, info } = await sharp(path.join(root, "sneaker.jpg")).raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (routePixel(data[i], data[i + 1], data[i + 2])) mask[idx(x, y, info.width)] = 1;
  }
  const kept = components(mask, info.width, info.height).filter((c) => ((c.bbox.minY + c.bbox.maxY) / 2) > info.height * 0.42 && c.count >= 45);
  const all = kept.flatMap((c) => c.pixels), b = bounds(all), pad = 8;
  const crop = { minX: Math.max(0, b.minX - pad), minY: Math.max(0, b.minY - pad), maxX: Math.min(info.width - 1, b.maxX + pad), maxY: Math.min(info.height - 1, b.maxY + pad) };
  const cw = crop.maxX - crop.minX + 1, ch = crop.maxY - crop.minY + 1;
  const lineMask = new Uint8Array(cw * ch);
  for (const c of kept) for (const [x, y] of c.pixels) lineMask[idx(x - crop.minX, y - crop.minY, cw)] = 255;
  return prepareTracedBinaryComponents(lineMask, cw, ch, 6, 20)
    .map((comp) => centerlinePolylineFromPreparedBinary(comp, cw, ch))
    .filter((s) => s.length >= 3)
    .sort((a, b2) => b2.length - a.length)
    .slice(0, 8)
    .map((s) => simplifyByDistance(s.map(([x, y]) => [x + crop.minX, y + crop.minY]), 2.2));
}
function pixelToLl([x, y], fit) {
  const u = (x - fit.left) / (fit.right - fit.left);
  const v = (y - fit.top) / (fit.bottom - fit.top);
  return [fit.north + (fit.south - fit.north) * v, fit.west + (fit.east - fit.west) * u];
}
function routeStroke(osm, target, opts) {
  const anchors = simplifyLatLng(target, opts.anchorM);
  const chain = [];
  let failed = 0, detours = 0, syntheticTransitions = 0;
  for (let i = 1; i < anchors.length; i++) {
    const a = nearestNode(osm, anchors[i - 1]), b = nearestNode(osm, anchors[i]);
    if (a < 0 || b < 0 || a === b) continue;
    const direct = meters(anchors[i - 1], anchors[i]);
    const ids = corridorPath(osm, a, b, target, opts.lambda, opts.corridorM) ||
      corridorPath(osm, a, b, target, opts.lambda * 0.5, opts.corridorM * 1.8) ||
      corridorPath(osm, a, b, target, 0, 1e7);
    if (!ids) { failed++; continue; }
    let len = 0;
    for (let k = 1; k < ids.length; k++) len += meters(osm.coord.get(ids[k - 1]), osm.coord.get(ids[k]));
    if (len > direct * 3.5 + 420) detours++;
    for (let usedIndex = 1; usedIndex < ids.length; usedIndex++) {
      const edge = (osm.adj.get(ids[usedIndex - 1]) ?? []).find((e) => e.to === ids[usedIndex]);
      if (edge?.synthetic) syntheticTransitions++;
    }
    for (const id of ids) {
      const p = osm.coord.get(id);
      if (p && (!chain.length || meters(chain[chain.length - 1], p) > 1)) chain.push(p);
    }
  }
  return { chain, anchors: anchors.length, failed, detours, syntheticTransitions };
}
function totalKm(chains) {
  let m = 0;
  for (const chain of chains) for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1], chain[i]);
  return m / 1000;
}
function routeD(points, project) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}
function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
async function render(osm, chains, file, label) {
  const local = chains.flat().map(llToLocal);
  const b = bounds(local), pad = 260, w = 1200, h = 820;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [], seen = new Set();
  for (const [from, entries] of osm.adj.entries()) for (const edge of entries) {
    const key = edgeKey(from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    const a = llToLocal(osm.coord.get(from)), bb = llToLocal(osm.coord.get(edge.to));
    if (!inView(a) && !inView(bb)) continue;
    streets.push(`<path d="${routeD([a, bb], project)}" fill="none" stroke="#d7d7d7" stroke-width="1.2"/>`);
  }
  const paths = chains.map((chain) => {
    const d = routeD(chain.map(llToLocal), project);
    return `<path d="${d}" fill="none" stroke="#111" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#ef1744" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}${paths}<text x="34" y="50" font-family="Arial" font-size="22" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function makeSheet(items, file) {
  const tw = 560, th = 350, comps = [];
  for (let i = 0; i < items.length; i++) {
    const left = (i % 2) * tw, top = Math.floor(i / 2) * th;
    const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><rect width="100%" height="100%" fill="#f7f4ee"/><text x="18" y="30" font-family="Arial" font-size="18" font-weight="700">${items[i].label}</text></svg>`);
    const im = await sharp(items[i].file).resize({ width: tw - 24, height: th - 50, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    comps.push({ input: bg, left, top });
    comps.push({ input: im.data, left: left + Math.round((tw - im.info.width) / 2), top: top + 42 + Math.round((th - 56 - im.info.height) / 2) });
  }
  await sharp({ create: { width: tw * 2, height: th * Math.ceil(items.length / 2), channels: 4, background: "#ece7dd" } }).composite(comps).png().toFile(file);
}
function gpxMulti(name, tracks) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso screenshot stroke replay" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name>\n${tracks.map((t) => `<trkseg>\n${t.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg>`).join("\n")}\n</trk></gpx>\n`;
}
function repairNearMisses(g, maxM = 3) {
  let added = 0;
  const hasEdge = (a, b) => (g.adj.get(a) ?? []).some((e) => e.to === b);
  const ids = [...g.adj.keys()];
  for (const id of ids) {
    const p = g.coord.get(id);
    if (!p) continue;
    const [clat, clng] = [Math.round(p[0] / 0.003), Math.round(p[1] / 0.003)];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      for (const other of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
        if (other <= id || hasEdge(id, other)) continue;
        const q = g.coord.get(other);
        if (!q) continue;
        const d = meters(p, q);
        if (d > maxM) continue;
        g.adj.get(id).push({ to: other, w: d, synthetic: true });
        g.adj.get(other).push({ to: id, w: d, synthetic: true });
        added++;
      }
    }
  }
  return added;
}
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(path.join(root, "sneaker.jpg"), path.join(outDir, "0-reference-sneaker.jpg"));
  const strokes = await extractStrokes();
  const osm = await buildGraph();
  const repairedNearMisses = repairNearMisses(osm);
  const optsList = [
    { anchorM: 85, lambda: 12, corridorM: 120 },
    { anchorM: 115, lambda: 10, corridorM: 150 },
    { anchorM: 145, lambda: 8, corridorM: 190 },
  ];
  const summary = [], sheet = [];
  let n = 0;
  for (const fit of FITS.filter((f) => f.id === "fit-02")) for (const opts of optsList.filter((o) => o.anchorM >= 115)) {
    const chains = [];
    let failed = 0, detours = 0, anchors = 0, syntheticTransitions = 0;
    for (const pxStroke of strokes) {
      const target = pxStroke.map((p) => pixelToLl(p, fit));
      const routed = routeStroke(osm, target, opts);
      if (routed.chain.length > 1) chains.push(routed.chain);
      failed += routed.failed; detours += routed.detours; anchors += routed.anchors; syntheticTransitions += routed.syntheticTransitions;
    }
    const id = `strokes-${String(++n).padStart(2, "0")}`;
    const dir = path.join(outDir, id);
    await fs.mkdir(dir, { recursive: true });
    const km = totalKm(chains);
    await render(osm, chains, path.join(dir, "map.png"), `${id} ${km.toFixed(1)}km f${failed} d${detours} s${syntheticTransitions}`);
    await fs.writeFile(path.join(dir, "art-strokes.gpx"), gpxMulti(id, chains));
    const row = { id, fit: fit.id, opts, km: +km.toFixed(2), miles: +(km * 0.621371).toFixed(2), failed, detours, anchors, strokes: chains.length, repairedNearMisses, syntheticTransitions, map: path.relative(root, path.join(dir, "map.png")).replace(/\\/g, "/"), gpx: path.relative(root, path.join(dir, "art-strokes.gpx")).replace(/\\/g, "/") };
    summary.push(row);
    sheet.push({ label: `${id} ${fit.id} ${row.km}km f${failed} d${detours}`, file: path.join(dir, "map.png") });
  }
  await makeSheet(sheet, path.join(outDir, "stroke-replay-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
