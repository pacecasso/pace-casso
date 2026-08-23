import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);

const { buildLatticeGraph, compileContourToLattice, haversineMeters } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-sneaker-map-first-multicity", stamp);

const M_PER_LAT = 111320;
let projection = null;
function setProjection(lattice) {
  const lat0 = (lattice.bounds.south + lattice.bounds.north) / 2;
  const lng0 = (lattice.bounds.west + lattice.bounds.east) / 2;
  projection = { lat0, lng0, mPerLng: M_PER_LAT * Math.cos((lat0 * Math.PI) / 180) };
}

function idx(x, y, w) { return y * w + x; }
function isRouteRed(r, g, b) { return r > 105 && r - g > 24 && r - b > 18; }
function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
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
function neighbors8(x, y, w, h) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push([nx, ny]);
  }
  return out;
}
function redComponents(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const start = idx(x, y, w);
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let count = 0, minX = x, maxX = x, minY = y, maxY = y;
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % w, cy = Math.floor(cur / w);
      count++;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
        const ni = idx(nx, ny, w);
        if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    comps.push({ count, minX, maxX, minY, maxY });
  }
  return comps.sort((a, b) => b.count - a.count);
}
function traceCropBounds(components) {
  const shoeComps = components.filter((c) => c.maxY > 220 && c.count >= 35 && c.maxX - c.minX >= 4 && c.maxY - c.minY >= 4);
  if (!shoeComps.length) throw new Error("No sneaker route components found.");
  return {
    minX: Math.max(0, Math.min(...shoeComps.map((c) => c.minX)) - 8),
    maxX: Math.max(...shoeComps.map((c) => c.maxX)) + 8,
    minY: Math.max(0, Math.min(...shoeComps.map((c) => c.minY)) - 8),
    maxY: Math.max(...shoeComps.map((c) => c.maxY)) + 8,
    components: shoeComps.length,
  };
}
function normalizeWithBounds(points, b) {
  const w = b.maxX - b.minX || 1;
  return points.map(([x, y]) => ({ x: (x - b.minX) / w, y: (y - b.minY) / w }));
}
function normalizeDesign(routePoints, featureStrokes) {
  const b = bounds(routePoints.concat(...featureStrokes));
  return {
    route: normalizeWithBounds(routePoints, b),
    features: featureStrokes.map((s) => normalizeWithBounds(s, b)),
  };
}
async function extractSneakerDesign() {
  const source = path.join(root, "sneaker.jpg");
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const fullMask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (isRouteRed(data[i], data[i + 1], data[i + 2])) fullMask[idx(x, y, info.width)] = 1;
  }
  const crop = traceCropBounds(redComponents(fullMask, info.width, info.height));
  const cw = crop.maxX - crop.minX + 1;
  const ch = crop.maxY - crop.minY + 1;
  const ink = [];
  for (let y = crop.minY; y <= crop.maxY; y++) for (let x = crop.minX; x <= crop.maxX; x++) {
    if (fullMask[idx(x, y, info.width)]) ink.push([x - crop.minX, y - crop.minY]);
  }

  const cols = [];
  const bin = 7;
  for (let x0 = 0; x0 < cw; x0 += bin) {
    const ys = ink.filter(([x]) => x >= x0 && x < x0 + bin).map(([, y]) => y).sort((a, b) => a - b);
    if (ys.length < 2) continue;
    cols.push({ x: x0 + bin / 2, top: ys[Math.floor(ys.length * 0.08)], bottom: ys[Math.floor(ys.length * 0.94)] });
  }
  function smooth(values, key) {
    return values.map((v, i) => {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(values.length - 1, i + 2); j++) { sum += values[j][key]; count++; }
      return { ...v, [key]: sum / count };
    });
  }
  const topCols = smooth(cols, "top");
  const bottomCols = smooth(cols, "bottom");
  const norm = ([x, y]) => [Math.max(0, Math.min(1.04, x / cw)), Math.max(0, Math.min(1, y / ch))];
  const px = ([x, y]) => [x * cw, y * ch];
  const interp = (arr, key, xNorm) => {
    const x = xNorm * cw;
    let best = arr[0];
    for (const c of arr) if (Math.abs(c.x - x) < Math.abs(best.x - x)) best = c;
    return best[key] / ch;
  };

  const outsole = bottomCols.map((c) => norm([c.x, c.bottom]));
  const upper = [...topCols].reverse().map((c) => norm([c.x, c.top]));
  const silhouette = simplifyByDistance([...outsole, [1.03, 0.63], [0.98, 0.38], ...upper, [-0.01, 0.50], outsole[0]].map(px), 5);
  const soleLine = [[0.08, interp(bottomCols, "bottom", 0.08) - 0.12], [0.34, interp(bottomCols, "bottom", 0.34) - 0.11], [0.68, interp(bottomCols, "bottom", 0.68) - 0.10], [0.91, interp(bottomCols, "bottom", 0.91) - 0.12]].map(px);
  const sidePanel = [[0.18, 0.54], [0.33, 0.36], [0.52, 0.30], [0.76, 0.40], [0.91, 0.56]].map(px);
  const laces = [[0.44, 0.31], [0.50, 0.54], [0.56, 0.32], [0.62, 0.53], [0.69, 0.35]].map(px);
  const heel = [[0.07, 0.50], [0.10, 0.74], [0.22, 0.82]].map(px);
  const routePoints = simplifyByDistance([...silhouette, ...soleLine, ...sidePanel, ...laces, ...heel], 3.5);
  return { crop, routePoints, featureStrokes: [silhouette, soleLine, sidePanel, laces, heel], normalized: normalizeDesign(routePoints, [silhouette, soleLine, sidePanel, laces, heel]) };
}
function transformDesign(design, rotateDeg, mirrorX) {
  const all = design.route.concat(...design.features);
  const original = bounds(all.map((p) => [p.x, p.y]));
  const cx = (original.minX + original.maxX) / 2;
  const cy = (original.minY + original.maxY) / 2;
  const a = rotateDeg * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const mapPoint = (p) => {
    let x = (mirrorX ? original.maxX - (p.x - original.minX) : p.x) - cx;
    let y = p.y - cy;
    return [x * ca - y * sa, x * sa + y * ca];
  };
  const rawRoute = design.route.map(mapPoint);
  const rawFeatures = design.features.map((s) => s.map(mapPoint));
  const b = bounds(rawRoute.concat(...rawFeatures));
  const w = b.maxX - b.minX || 1;
  const h = b.maxY - b.minY || 1;
  const norm = ([x, y]) => [(x - b.minX) / w, (y - b.minY) / h];
  return { route: rawRoute.map(norm), features: rawFeatures.map((s) => s.map(norm)), heightRatio: h / w };
}
function localToLatLng([x, y]) {
  if (!projection) throw new Error("projection not set");
  return [projection.lat0 + y / M_PER_LAT, projection.lng0 + x / projection.mPerLng];
}
function latLngToLocal([lat, lng]) {
  if (!projection) throw new Error("projection not set");
  return [(lng - projection.lng0) * projection.mPerLng, (lat - projection.lat0) * M_PER_LAT];
}
function place(points, center, widthM, heightRatio) {
  const heightM = widthM * heightRatio;
  return points.map(([u, v]) => [center[0] + (u - 0.5) * widthM, center[1] + (v - 0.5) * heightM]);
}
function placeLatLng(points, center, widthM, heightRatio) {
  return place(points, center, widthM, heightRatio).map(localToLatLng);
}
function buildStreetSegments(graph) {
  const seen = new Set();
  const segs = [];
  for (const [from, entries] of graph.adj.entries()) for (const edge of entries) {
    const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (dist(a, b) < 1) continue;
      segs.push({ a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
    }
  }
  return segs;
}
function segmentGrid(segs, cell = 220) {
  const grid = new Map();
  const add = (key, value) => { const arr = grid.get(key); if (arr) arr.push(value); else grid.set(key, [value]); };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const minX = Math.floor(s.minX / cell), maxX = Math.floor(s.maxX / cell);
    const minY = Math.floor(s.minY / cell), maxY = Math.floor(s.maxY / cell);
    for (let gx = minX; gx <= maxX; gx++) for (let gy = minY; gy <= maxY; gy++) add(`${gx}:${gy}`, i);
  }
  return { grid, cell };
}
function pointToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return { d: dist(p, a), dot: 0 };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const q = [a[0] + vx * t, a[1] + vy * t];
  return { d: dist(p, q), vx, vy };
}
function nearestStreet(p, tangent, segs, index, radius = 210) {
  const gx = Math.floor(p[0] / index.cell), gy = Math.floor(p[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  let best = { d: Infinity, align: 0 };
  const seen = new Set();
  for (let dx = -cr; dx <= cr; dx++) for (let dy = -cr; dy <= cr; dy++) {
    for (const si of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
      if (seen.has(si)) continue;
      seen.add(si);
      const s = segs[si];
      if (p[0] < s.minX - radius || p[0] > s.maxX + radius || p[1] < s.minY - radius || p[1] > s.maxY + radius) continue;
      const hit = pointToSegment(p, s.a, s.b);
      if (hit.d < best.d) {
        const sl = Math.hypot(hit.vx, hit.vy) || 1;
        const tl = Math.hypot(tangent[0], tangent[1]) || 1;
        const align = Math.abs((hit.vx / sl) * (tangent[0] / tl) + (hit.vy / sl) * (tangent[1] / tl));
        best = { d: hit.d, align };
      }
    }
  }
  return best;
}
function sampleStroke(stroke, maxUnitStep = 0.035) {
  const samples = [];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1], b = stroke[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(d / maxUnitStep));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      samples.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], tangent: [b[0] - a[0], b[1] - a[1]] });
    }
  }
  return samples;
}
function fabricScore(transformed, center, widthM, segs, index) {
  const heightRatio = transformed.heightRatio;
  const samples = transformed.features.flatMap((stroke) => sampleStroke(stroke));
  let sum = 0, missed = 0, close = 0;
  for (const s of samples) {
    const p = place([s.p], center, widthM, heightRatio)[0];
    const tangent = [s.tangent[0] * widthM, s.tangent[1] * widthM * heightRatio];
    const hit = nearestStreet(p, tangent, segs, index, 230);
    if (!Number.isFinite(hit.d) || hit.d > 180) { missed++; sum += 240; continue; }
    if (hit.d < 70) close++;
    sum += hit.d + (1 - hit.align) * 55;
  }
  const coverage = close / Math.max(1, samples.length);
  return { score: sum / Math.max(1, samples.length) + missed * 9 - coverage * 18, missed, coverage, sampleCount: samples.length };
}
function candidateCenters(graph) {
  const cells = new Map();
  for (const n of graph.nodes) {
    const p = latLngToLocal(n);
    const key = `${Math.round(p[0] / 900)}:${Math.round(p[1] / 900)}`;
    const cur = cells.get(key) ?? { sx: 0, sy: 0, count: 0 };
    cur.sx += p[0]; cur.sy += p[1]; cur.count++;
    cells.set(key, cur);
  }
  return [...cells.values()].filter((c) => c.count >= 3).map((c) => [c.sx / c.count, c.sy / c.count]);
}
function routeD(chain, project) {
  return chain.map((p, i) => { const [x, y] = project(p); return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
}
async function renderPath(points, file, color = "#111") {
  const b = bounds(points), w = 1100, h = 820, pad = 48;
  const scale = Math.min((w - pad * 2) / (b.maxX - b.minX || 1), (h - pad * 2) / (b.maxY - b.minY || 1));
  const usedW = (b.maxX - b.minX) * scale, usedH = (b.maxY - b.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - b.minX) * scale, oy + (y - b.minY) * scale];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${routeD(points, project)}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function renderStreet(chain, graph, file, label = "") {
  const route = chain.map(latLngToLocal), rb = bounds(route), pad = 260;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const w = 1100, h = 820;
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set(), streets = [];
  for (const [from, entries] of graph.adj.entries()) for (const edge of entries) {
    const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
    if (!pts.some(inView)) continue;
    streets.push(`<path d="${routeD(pts, project)}" fill="none" stroke="#dadada" stroke-width="2"/>`);
  }
  const text = label ? `<text x="32" y="46" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>` : "";
  const rd = routeD(route, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#771225" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso sneaker map-first search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}
function runabilityStats(chain) {
  let maxHopMeters = 0, totalMeters = 0;
  for (let i = 1; i < chain.length; i++) {
    const d = haversineMeters(chain[i - 1], chain[i]);
    totalMeters += d;
    maxHopMeters = Math.max(maxHopMeters, d);
  }
  return { points: chain.length, totalKm: totalMeters / 1000, maxHopMeters };
}
async function runCity(latticePath) {
  const lattice = JSON.parse(await fs.readFile(latticePath, "utf8"));
  setProjection(lattice);
  const city = lattice.city;
  const cityDir = path.join(outDir, city);
  await fs.mkdir(cityDir, { recursive: true });
  const graph = buildLatticeGraph(lattice);
  const design = await extractSneakerDesign();
  await renderPath(design.routePoints, path.join(cityDir, "1-reference-derived-design.png"));
  const segs = buildStreetSegments(graph);
  const segIndex = segmentGrid(segs);
  const centers = candidateCenters(graph);
  const rotations = [-35, -20, -10, 0, 10, 20, 35];
  const widths = [1600, 2200, 3000, 4000, 5200];
  const fabric = [];
  let scanCount = 0;
  for (const rotateDeg of rotations) for (const mirrorX of [false, true]) {
    const transformed = transformDesign(design.normalized, rotateDeg, mirrorX);
    for (const center of centers) for (const widthM of widths) {
      scanCount++;
      const f = fabricScore(transformed, center, widthM, segs, segIndex);
      fabric.push({ ...f, rotateDeg, mirrorX, center, widthM, heightRatio: transformed.heightRatio, transformed });
    }
  }
  fabric.sort((a, b) => a.score - b.score);
  const compilePool = fabric.slice(0, 90);
  const compiled = [];
  let id = 0;
  for (const c of compilePool) {
    const placed = placeLatLng(c.transformed.route, c.center, c.widthM, c.heightRatio);
    const result = compileContourToLattice(placed, graph, { sampleMeters: 26, pinRadiusMeters: 145, minPinSpacingMeters: 52, maxLegDetourRatio: 2.5, maxLegDetourSlackMeters: 220 });
    if (!result) continue;
    const rb = bounds(result.chain.map(latLngToLocal));
    const aspect = (rb.maxX - rb.minX) / Math.max(1, rb.maxY - rb.minY);
    const stats = runabilityStats(result.chain);
    const score = c.score + result.meanDeviationMeters * 0.65 + result.skippedPins * 180 + Math.abs(aspect - 2.25) * 8 + Math.max(0, stats.maxHopMeters - 220) * 0.35;
    compiled.push({ id: `${city}-mapfit-${String(++id).padStart(4, "0")}`, city, score, fabricScore: c.score, rotateDeg: c.rotateDeg, mirrorX: c.mirrorX, center: c.center, widthM: c.widthM, heightRatio: c.heightRatio, coverage: c.coverage, fabricMissed: c.missed, km: result.km, meanDeviationMeters: result.meanDeviationMeters, maxDeviationMeters: result.maxDeviationMeters, skippedPins: result.skippedPins, legCount: result.legCount, aspect, runability: stats, chain: result.chain });
  }
  compiled.sort((a, b) => a.score - b.score);
  const top = compiled.slice(0, 8);
  const summary = [];
  for (const c of top) {
    const dir = path.join(cityDir, c.id);
    await fs.mkdir(dir, { recursive: true });
    await renderStreet(c.chain, graph, path.join(dir, "route-blind.png"));
    await renderStreet(c.chain, graph, path.join(dir, "route-labeled.png"), `${c.id} ${c.km.toFixed(1)} km`);
    await fs.writeFile(path.join(dir, `${c.id}.gpx`), gpx(c.id, c.chain), "utf8");
    const clean = { ...c };
    delete clean.chain;
    summary.push({ ...clean, blindImage: path.relative(root, path.join(dir, "route-blind.png")).replace(/\\\\/g, "/"), gpx: path.relative(root, path.join(dir, `${c.id}.gpx`)).replace(/\\\\/g, "/") });
  }
  return { city, scanCount, centers: centers.length, segmentCount: segs.length, latticePath: path.relative(root, latticePath).replace(/\\\\/g, "/"), design: { crop: design.crop, routePoints: design.routePoints.length, featureStrokes: design.featureStrokes.map((x) => x.length) }, top: summary };
}
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(path.join(root, "sneaker.jpg"), path.join(outDir, "0-reference-sneaker.jpg"));
  const latticePaths = process.argv.slice(2);
  if (!latticePaths.length) {
    latticePaths.push(path.join(root, "tmp-city-lattice", "manhattan-lattice.json"));
    latticePaths.push(path.join(root, "tmp-city-lattice", "brooklyn-lattice.json"));
  }
  const runs = [];
  for (const lp of latticePaths) runs.push(await runCity(path.resolve(lp)));
  const allTop = runs.flatMap((r) => r.top);
  allTop.sort((a, b) => a.score - b.score);
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ runs, allTop: allTop.slice(0, 20) }, null, 2));
  console.log(path.relative(root, outDir));
}
main().catch((error) => { console.error(error); process.exit(1); });


