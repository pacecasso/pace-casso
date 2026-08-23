import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const {
  prepareTracedBinaryComponents,
  centerlinePolylineFromPreparedBinary,
} = jiti("../lib/centerlineFromMask.ts");
const { buildGraph, nearestNode, corridorPath, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-sneaker-screenshot-georef", stamp);
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };

const idx = (x, y, w) => y * w + x;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function routePixel(r, g, b) {
  return r >= 138 && g >= 78 && g <= 190 && b >= 55 && b <= 178 &&
    r - g >= 18 && g - b >= 4 && r - b >= 36;
}

function llToLocal([lat, lng]) {
  return [(lng - PROJ.lng0) * PROJ.mPerLng, (lat - PROJ.lat0) * M_PER_LAT];
}

function localToLl([x, y]) {
  return [PROJ.lat0 + y / M_PER_LAT, PROJ.lng0 + x / PROJ.mPerLng];
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function simplifyByDistance(points, minDist) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || dist(last, p) >= minDist) {
      out.push(p);
      last = p;
    }
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

function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const start = idx(x, y, w);
    if (!mask[start] || seen[start]) continue;
    const stack = [[x, y]], pixels = [];
    seen[start] = 1;
    let minX = x, minY = y, maxX = x, maxY = y;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      pixels.push([cx, cy]);
      minX = Math.min(minX, cx); minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
      for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
        const ni = idx(nx, ny, w);
        if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push([nx, ny]); }
      }
    }
    out.push({ pixels, count: pixels.length, bbox: { minX, minY, maxX, maxY } });
  }
  return out.sort((a, b) => b.count - a.count);
}

function stitch(strokes) {
  const remaining = strokes.map((s) => s.slice());
  const route = remaining.shift() ?? [];
  while (remaining.length && route.length) {
    const last = route[route.length - 1];
    let bi = 0, rev = false, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i], a = s[0], b = s[s.length - 1];
      const da = dist(last, a), db = dist(last, b);
      if (da < bd) { bd = da; bi = i; rev = false; }
      if (db < bd) { bd = db; bi = i; rev = true; }
    }
    const next = remaining.splice(bi, 1)[0];
    if (rev) next.reverse();
    route.push(...next);
  }
  return route;
}

async function extractCenterline() {
  const source = path.join(root, "sneaker.jpg");
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (routePixel(data[i], data[i + 1], data[i + 2])) mask[idx(x, y, info.width)] = 1;
  }
  const kept = components(mask, info.width, info.height).filter((c) => {
    const yMid = (c.bbox.minY + c.bbox.maxY) / 2;
    return yMid > info.height * 0.42 && c.count >= 80;
  }).slice(0, 4);
  const all = kept.flatMap((c) => c.pixels);
  const b = bounds(all);
  const pad = 8;
  const crop = { minX: Math.max(0, b.minX - pad), minY: Math.max(0, b.minY - pad), maxX: Math.min(info.width - 1, b.maxX + pad), maxY: Math.min(info.height - 1, b.maxY + pad) };
  const cw = crop.maxX - crop.minX + 1, ch = crop.maxY - crop.minY + 1;
  const lineMask = new Uint8Array(cw * ch);
  for (const c of kept) for (const [x, y] of c.pixels) lineMask[idx(x - crop.minX, y - crop.minY, cw)] = 255;
  const strokes = prepareTracedBinaryComponents(lineMask, cw, ch, 6, 20)
    .map((comp) => centerlinePolylineFromPreparedBinary(comp, cw, ch))
    .filter((s) => s.length >= 3)
    .sort((a, b2) => b2.length - a.length)
    .slice(0, 4)
    .map((s) => simplifyByDistance(s.map(([x, y]) => [x + crop.minX, y + crop.minY]), 2.2));
  return { points: simplifyByDistance(stitch(strokes), 3.2), sourceSize: [info.width, info.height] };
}

function pixelToLl([x, y], fit) {
  const u = (x - fit.left) / (fit.right - fit.left);
  const v = (y - fit.top) / (fit.bottom - fit.top);
  return [
    fit.north + (fit.south - fit.north) * v,
    fit.west + (fit.east - fit.west) * u,
  ];
}

function buildSegments(osm) {
  const seen = new Set(), segs = [];
  for (const [from, entries] of osm.adj.entries()) for (const edge of entries) {
    const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = llToLocal(osm.coord.get(from)), b = llToLocal(osm.coord.get(edge.to));
    segs.push({ a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
  }
  return segs;
}

function segmentGrid(segs, cell = 180) {
  const grid = new Map();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let gx = Math.floor(s.minX / cell); gx <= Math.floor(s.maxX / cell); gx++) for (let gy = Math.floor(s.minY / cell); gy <= Math.floor(s.maxY / cell); gy++) {
      const k = `${gx}:${gy}`;
      const arr = grid.get(k);
      if (arr) arr.push(i); else grid.set(k, [i]);
    }
  }
  return { grid, cell };
}

function pointToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy;
  if (len2 <= 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  return dist(p, [a[0] + vx * t, a[1] + vy * t]);
}

function nearestStreetDistance(p, segs, index, radius = 210) {
  const gx = Math.floor(p[0] / index.cell), gy = Math.floor(p[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  let best = Infinity;
  const seen = new Set();
  for (let dx = -cr; dx <= cr; dx++) for (let dy = -cr; dy <= cr; dy++) {
    for (const si of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
      if (seen.has(si)) continue;
      seen.add(si);
      const s = segs[si];
      if (p[0] < s.minX - radius || p[0] > s.maxX + radius || p[1] < s.minY - radius || p[1] > s.maxY + radius) continue;
      best = Math.min(best, pointToSegment(p, s.a, s.b));
    }
  }
  return best;
}

function scoreFit(points, fit, segs, index) {
  const sample = simplifyByDistance(points, 8);
  let sum = 0, missed = 0, close = 0;
  for (const px of sample) {
    const d = nearestStreetDistance(llToLocal(pixelToLl(px, fit)), segs, index);
    if (!Number.isFinite(d) || d > 180) { sum += 260; missed++; }
    else { sum += d; if (d < 38) close++; }
  }
  return sum / sample.length + missed * 12 - (close / sample.length) * 20;
}

function simplifyLatLng(points, minMeters) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || meters(last, p) >= minMeters) { out.push(p); last = p; }
  }
  return out;
}

function routeThroughOsm(osm, target, anchorM = 70) {
  const anchors = simplifyLatLng(target, anchorM);
  const chain = [];
  let failed = 0, detours = 0;
  for (let i = 1; i < anchors.length; i++) {
    const a = nearestNode(osm, anchors[i - 1]), b = nearestNode(osm, anchors[i]);
    if (a < 0 || b < 0 || a === b) continue;
    const direct = meters(anchors[i - 1], anchors[i]);
    const ids =
      corridorPath(osm, a, b, target, 8, 150) ||
      corridorPath(osm, a, b, target, 10, 260) ||
      corridorPath(osm, a, b, target, 0, 1e7);
    if (!ids) { failed++; continue; }
    let len = 0;
    for (let k = 1; k < ids.length; k++) len += meters(osm.coord.get(ids[k - 1]), osm.coord.get(ids[k]));
    if (len > direct * 3.2 + 360) { detours++; continue; }
    for (const id of ids) {
      const p = osm.coord.get(id);
      if (!chain.length || meters(chain[chain.length - 1], p) > 1) chain.push(p);
    }
  }
  return { chain, anchors: anchors.length, failed, detours };
}

function routeD(points, project) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

async function renderStreet(chain, osm, file, label = "") {
  const route = chain.map(llToLocal);
  const rb = bounds(route), pad = 260;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const w = 1100, h = 820;
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [];
  const seen = new Set();
  for (const [from, entries] of osm.adj.entries()) for (const edge of entries) {
    const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = llToLocal(osm.coord.get(from)), b = llToLocal(osm.coord.get(edge.to));
    if (!inView(a) && !inView(b)) continue;
    streets.push(`<path d="${routeD([a, b], project)}" fill="none" stroke="#d7d7d7" stroke-width="1.7"/>`);
  }
  const rd = routeD(route, project);
  const text = label ? `<text x="32" y="46" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#771225" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function makeSheet(items, file) {
  const tileW = 560, tileH = 430, comps = [];
  for (let i = 0; i < items.length; i++) {
    const left = (i % 2) * tileW, top = Math.floor(i / 2) * tileH;
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}"><rect width="100%" height="100%" fill="#f7f4ee"/><text x="18" y="32" font-family="Arial" font-size="20" font-weight="700">${items[i].label}</text></svg>`);
    const img = await sharp(items[i].file).resize({ width: tileW - 28, height: tileH - 52, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    comps.push({ input: label, left, top });
    comps.push({ input: img.data, left: left + Math.round((tileW - img.info.width) / 2), top: top + 44 + Math.round((tileH - 58 - img.info.height) / 2) });
  }
  await sharp({ create: { width: tileW * 2, height: tileH * Math.ceil(items.length / 2), channels: 4, background: "#ece7dd" } }).composite(comps).png().toFile(file);
}

function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso screenshot georef replay" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(path.join(root, "sneaker.jpg"), path.join(outDir, "0-reference-sneaker.jpg"));
  const { points } = await extractCenterline();
  const osm = await buildGraph();
  const segs = buildSegments(osm), index = segmentGrid(segs);
  const fitSeeds = [
    { top: 198, bottom: 457, north: 40.7316, south: 40.7076, west: -74.0140, east: -73.9774 },
    { top: 198, bottom: 457, north: 40.7313, south: 40.7067, west: -74.0147, east: -73.9733 },
    { top: 198, bottom: 457, north: 40.7264, south: 40.7040, west: -74.0144, east: -73.9754 },
  ];
  const fits = [];
  for (const seed of fitSeeds) {
    for (const top of [seed.top - 4, seed.top, seed.top + 4]) for (const bottom of [seed.bottom - 4, seed.bottom, seed.bottom + 4]) {
      for (const north of [seed.north - 0.0005, seed.north, seed.north + 0.0005]) for (const south of [seed.south - 0.0005, seed.south, seed.south + 0.0005]) {
        for (const west of [seed.west - 0.0005, seed.west, seed.west + 0.0005]) for (const east of [seed.east - 0.0005, seed.east, seed.east + 0.0005]) {
          if (north <= south || east <= west) continue;
          const fit = { left: 0, right: 390, top, bottom, north, south, west, east };
          fits.push({ ...fit, score: scoreFit(points, fit, segs, index) });
        }
      }
    }
  }
  fits.sort((a, b) => a.score - b.score);
  const routedCandidates = [];
  for (const fit of fits.slice(0, 12)) {
    const rawTarget = points.map((p) => pixelToLl(p, fit));
    for (const simplifyM of [45, 70, 95, 130]) {
      for (const anchorM of [80, 110, 145, 190]) {
        const target = simplifyLatLng(rawTarget, simplifyM);
        const routed = routeThroughOsm(osm, target, anchorM);
        if (routed.chain.length < 20) continue;
        let metersTotal = 0;
        for (let i = 1; i < routed.chain.length; i++) metersTotal += meters(routed.chain[i - 1], routed.chain[i]);
        const km = metersTotal / 1000;
        const routeScore = fit.score + Math.abs(km - 18.1) * 2.6 + routed.detours * 5 + routed.failed * 7 + Math.max(0, routed.chain.length - 500) * 0.02;
        routedCandidates.push({ fit, target, routed, km, routeScore, simplifyM, anchorM });
      }
    }
  }
  routedCandidates.sort((a, b) => a.routeScore - b.routeScore);
  const sheet = [];
  const summary = [];
  let id = 0;
  for (const candidate of routedCandidates.slice(0, 8)) {
    const name = `georef-${String(++id).padStart(3, "0")}`;
    const dir = path.join(outDir, name);
    await fs.mkdir(dir, { recursive: true });
    const img = path.join(dir, "route-blind.png");
    await renderStreet(candidate.routed.chain, osm, img, `${name} ${candidate.km.toFixed(1)} km`);
    await fs.writeFile(path.join(dir, `${name}.gpx`), gpx(name, candidate.routed.chain));
    sheet.push({ label: `${name} score ${candidate.routeScore.toFixed(1)} km ${candidate.km.toFixed(1)}`, file: img });
    summary.push({ id: name, fit: candidate.fit, routeScore: +candidate.routeScore.toFixed(2), simplifyM: candidate.simplifyM, anchorM: candidate.anchorM, km: +candidate.km.toFixed(2), anchors: candidate.routed.anchors, failed: candidate.routed.failed, detours: candidate.routed.detours, points: candidate.routed.chain.length, image: path.relative(root, img).replace(/\\/g, "/"), gpx: path.relative(root, path.join(dir, `${name}.gpx`)).replace(/\\/g, "/") });
  }
  await makeSheet(sheet, path.join(outDir, "georef-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ topFits: fits.slice(0, 20), results: summary }, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
