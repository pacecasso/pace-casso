import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);

const {
  centerlinePolylinesFromLineMask,
} = jiti("../lib/centerlineFromMask.ts");
const { joinPolylinesAsOneLine } = jiti("../lib/oneLineArtPath.ts");
const {
  buildLatticeGraph,
  compileContourToLattice,
  haversineMeters,
} = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-sneaker-thick-fit", stamp);
const M_PER_LAT = 111320;

let projection = null;
function setProjection(lattice) {
  const lat0 = (lattice.bounds.south + lattice.bounds.north) / 2;
  const lng0 = (lattice.bounds.west + lattice.bounds.east) / 2;
  projection = {
    lat0,
    lng0,
    mPerLng: M_PER_LAT * Math.cos((lat0 * Math.PI) / 180),
  };
}

function idx(x, y, w) {
  return y * w + x;
}

function isScreenshotRoutePixel(r, g, b, y) {
  return (
    y >= 190 &&
    y <= 455 &&
    r >= 125 &&
    g >= 60 &&
    b <= 135 &&
    r - g >= 24 &&
    g - b >= -5
  );
}

function neighbors8(x, y, w, h) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push([nx, ny]);
    }
  }
  return out;
}

function redComponents(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = idx(x, y, w);
      if (!mask[start] || seen[start]) continue;
      const stack = [start];
      seen[start] = 1;
      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % w;
        const cy = Math.floor(cur / w);
        count++;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
          const ni = idx(nx, ny, w);
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      comps.push({ count, minX, maxX, minY, maxY });
    }
  }
  return comps.sort((a, b) => b.count - a.count);
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
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

function localToLatLng([x, y]) {
  if (!projection) throw new Error("projection not set");
  return [projection.lat0 + y / M_PER_LAT, projection.lng0 + x / projection.mPerLng];
}

function latLngToLocal([lat, lng]) {
  if (!projection) throw new Error("projection not set");
  return [(lng - projection.lng0) * projection.mPerLng, (lat - projection.lat0) * M_PER_LAT];
}

function rotatePoint([x, y], deg) {
  const a = (deg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return [x * ca - y * sa, x * sa + y * ca];
}

function placePoint(p, fit) {
  const x0 = (p[0] - 0.5) * fit.widthM;
  const y0 = (0.5 - p[1]) * fit.widthM * fit.heightRatio;
  const [rx, ry] = rotatePoint([x0, y0], fit.rotateDeg);
  return [fit.center[0] + rx, fit.center[1] + ry];
}

function placePath(points, fit) {
  return points.map((p) => localToLatLng(placePoint(p, fit)));
}

function buildStreetSegments(graph) {
  const seen = new Set();
  const segs = [];
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (dist(a, b) < 1) continue;
        segs.push({
          a,
          b,
          minX: Math.min(a[0], b[0]),
          maxX: Math.max(a[0], b[0]),
          minY: Math.min(a[1], b[1]),
          maxY: Math.max(a[1], b[1]),
        });
      }
    }
  }
  return segs;
}

function segmentGrid(segs, cell = 170) {
  const grid = new Map();
  const add = (key, value) => {
    const arr = grid.get(key);
    if (arr) arr.push(value);
    else grid.set(key, [value]);
  };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const minX = Math.floor(s.minX / cell);
    const maxX = Math.floor(s.maxX / cell);
    const minY = Math.floor(s.minY / cell);
    const maxY = Math.floor(s.maxY / cell);
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gy = minY; gy <= maxY; gy++) add(`${gx}:${gy}`, i);
    }
  }
  return { grid, cell };
}

function pointToSegment(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return { d: dist(p, a), vx: 0, vy: 0 };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const q = [a[0] + vx * t, a[1] + vy * t];
  return { d: dist(p, q), vx, vy };
}

function nearestStreet(p, tangent, segs, index, radius = 180) {
  const gx = Math.floor(p[0] / index.cell);
  const gy = Math.floor(p[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  const seen = new Set();
  let best = { d: Infinity, align: 0 };
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dy = -cr; dy <= cr; dy++) {
      for (const si of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
        if (seen.has(si)) continue;
        seen.add(si);
        const s = segs[si];
        if (
          p[0] < s.minX - radius ||
          p[0] > s.maxX + radius ||
          p[1] < s.minY - radius ||
          p[1] > s.maxY + radius
        ) {
          continue;
        }
        const hit = pointToSegment(p, s.a, s.b);
        if (hit.d >= best.d) continue;
        const sl = Math.hypot(hit.vx, hit.vy) || 1;
        const tl = Math.hypot(tangent[0], tangent[1]) || 1;
        const align = Math.abs((hit.vx / sl) * (tangent[0] / tl) + (hit.vy / sl) * (tangent[1] / tl));
        best = { d: hit.d, align };
      }
    }
  }
  return best;
}

function candidateCenters(graph) {
  const cells = new Map();
  for (const node of graph.nodes) {
    const p = latLngToLocal(node);
    const key = `${Math.round(p[0] / 360)}:${Math.round(p[1] / 360)}`;
    const cur = cells.get(key) ?? { sx: 0, sy: 0, count: 0 };
    cur.sx += p[0];
    cur.sy += p[1];
    cur.count++;
    cells.set(key, cur);
  }
  return [...cells.values()]
    .filter((c) => c.count >= 2)
    .map((c) => [c.sx / c.count, c.sy / c.count]);
}

function fitScore(design, fit, segs, index) {
  let sum = 0;
  let missed = 0;
  let close = 0;
  for (let i = 1; i < design.scoreSamples.length; i++) {
    const prev = design.scoreSamples[i - 1];
    const cur = design.scoreSamples[i];
    const p = placePoint(cur, fit);
    const pp = placePoint(prev, fit);
    const tangent = [p[0] - pp[0], p[1] - pp[1]];
    const hit = nearestStreet(p, tangent, segs, index, 185);
    if (!Number.isFinite(hit.d) || hit.d > 150) {
      missed++;
      sum += 210;
      continue;
    }
    if (hit.d < 55) close++;
    sum += hit.d + (1 - hit.align) * 45;
  }
  const n = Math.max(1, design.scoreSamples.length - 1);
  return {
    score: sum / n + missed * 4 - (close / n) * 22,
    missed,
    coverage: close / n,
  };
}

function routeD(chain, project) {
  return chain
    .map((p, i) => {
      const [x, y] = project(p);
      return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

async function renderPath(points, file, color = "#111") {
  const b = bounds(points);
  const w = 1100;
  const h = 820;
  const pad = 48;
  const scale = Math.min((w - pad * 2) / (b.maxX - b.minX || 1), (h - pad * 2) / (b.maxY - b.minY || 1));
  const usedW = (b.maxX - b.minX) * scale;
  const usedH = (b.maxY - b.minY) * scale;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - b.minX) * scale, oy + (y - b.minY) * scale];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${routeD(points, project)}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function renderStreet(chain, graph, file, label = "") {
  const route = chain.map(latLngToLocal);
  const rb = bounds(route);
  const pad = 260;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const w = 1100;
  const h = 820;
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale;
  const usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set();
  const streets = [];
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
      if (!pts.some(inView)) continue;
      streets.push(`<path d="${routeD(pts, project)}" fill="none" stroke="#dadada" stroke-width="2"/>`);
    }
  }
  const text = label
    ? `<text x="32" y="46" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>`
    : "";
  const rd = routeD(route, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#771225" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso thick sneaker fit" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

function runabilityStats(chain) {
  let maxHopMeters = 0;
  let totalMeters = 0;
  for (let i = 1; i < chain.length; i++) {
    const d = haversineMeters(chain[i - 1], chain[i]);
    totalMeters += d;
    maxHopMeters = Math.max(maxHopMeters, d);
  }
  return { points: chain.length, totalKm: totalMeters / 1000, maxHopMeters };
}

async function extractScreenshotRoute() {
  const source = path.join(root, "sneaker.jpg");
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const fullMask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (isScreenshotRoutePixel(data[i], data[i + 1], data[i + 2], y)) fullMask[idx(x, y, info.width)] = 1;
    }
  }

  const comps = redComponents(fullMask, info.width, info.height).filter(
    (c) => c.count >= 8 && c.maxY >= 198 && c.minY <= 452,
  );
  if (!comps.length) throw new Error("No screenshot route pixels found.");
  const crop = {
    minX: Math.max(0, Math.min(...comps.map((c) => c.minX)) - 4),
    maxX: Math.min(info.width - 1, Math.max(...comps.map((c) => c.maxX)) + 4),
    minY: Math.max(0, Math.min(...comps.map((c) => c.minY)) - 4),
    maxY: Math.min(info.height - 1, Math.max(...comps.map((c) => c.maxY)) + 4),
    components: comps.length,
  };
  const cw = crop.maxX - crop.minX + 1;
  const ch = crop.maxY - crop.minY + 1;
  const lineMask = new Uint8Array(cw * ch);
  for (let y = crop.minY; y <= crop.maxY; y++) {
    for (let x = crop.minX; x <= crop.maxX; x++) {
      if (fullMask[idx(x, y, info.width)]) lineMask[idx(x - crop.minX, y - crop.minY, cw)] = 255;
    }
  }

  const polylines = centerlinePolylinesFromLineMask(lineMask, cw, ch);
  const joined = simplifyByDistance(joinPolylinesAsOneLine(polylines), 1.8);
  const b = bounds(joined);
  const width = b.maxX - b.minX || 1;
  const unit = joined.map(([x, y]) => [(x - b.minX) / width, (y - b.minY) / width]);
  const scoreSamples = simplifyByDistance(unit, 0.018);

  return {
    crop,
    size: { width: cw, height: ch },
    polylines: polylines.length,
    points: joined,
    normalized: unit,
    scoreSamples,
    heightRatio: (b.maxY - b.minY) / width,
  };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(path.join(root, "sneaker.jpg"), path.join(outDir, "0-reference-sneaker.jpg"));
  const lattice = JSON.parse(await fs.readFile(path.join(root, "tmp-city-lattice", "manhattan-lattice.json"), "utf8"));
  setProjection(lattice);
  const graph = buildLatticeGraph(lattice);
  const design = await extractScreenshotRoute();
  await renderPath(design.points, path.join(outDir, "1-screenshot-centerline.png"));

  const segs = buildStreetSegments(graph);
  const index = segmentGrid(segs);
  const centers = candidateCenters(graph);
  const widths = [1900, 2200, 2500, 2800, 3100, 3400];
  const rotations = [-4, -2, 0, 2, 4];
  const heightMultipliers = [1.15, 1.35, 1.55, 1.75, 1.95, 2.15];

  const scanned = [];
  for (const center of centers) {
    for (const widthM of widths) {
      for (const rotateDeg of rotations) {
        for (const hm of heightMultipliers) {
          const fit = { center, widthM, rotateDeg, heightRatio: design.heightRatio * hm, heightMultiplier: hm };
          const f = fitScore(design, fit, segs, index);
          scanned.push({ ...fit, ...f });
        }
      }
    }
  }
  scanned.sort((a, b) => a.score - b.score);

  const compiled = [];
  let idCounter = 0;
  for (const c of scanned.slice(0, 520)) {
    const placed = placePath(design.normalized, c);
    const result = compileContourToLattice(placed, graph, {
      sampleMeters: 28,
      pinRadiusMeters: 135,
      minPinSpacingMeters: 48,
      maxLegDetourRatio: 2.8,
      maxLegDetourSlackMeters: 260,
    });
    if (!result) continue;
    const routeLocal = result.chain.map(latLngToLocal);
    const rb = bounds(routeLocal);
    const aspect = (rb.maxX - rb.minX) / Math.max(1, rb.maxY - rb.minY);
    const stats = runabilityStats(result.chain);
    const lengthPenalty = Math.max(0, Math.abs(result.km - 18.2) - 2.2) * 3.5;
    const score =
      c.score +
      result.meanDeviationMeters * 0.55 +
      result.skippedPins * 190 +
      Math.max(0, stats.maxHopMeters - 190) * 0.45 +
      Math.abs(aspect - 2.55) * 22 +
      lengthPenalty;
    compiled.push({
      id: `screenshot-fit-${String(++idCounter).padStart(4, "0")}`,
      score,
      fabricScore: c.score,
      rotateDeg: c.rotateDeg,
      center: c.center,
      widthM: c.widthM,
      heightRatio: c.heightRatio,
      heightMultiplier: c.heightMultiplier,
      coverage: c.coverage,
      missed: c.missed,
      km: result.km,
      meanDeviationMeters: result.meanDeviationMeters,
      maxDeviationMeters: result.maxDeviationMeters,
      skippedPins: result.skippedPins,
      legCount: result.legCount,
      aspect,
      runability: stats,
      chain: result.chain,
    });
  }
  compiled.sort((a, b) => a.score - b.score);

  const top = compiled.slice(0, 12);
  const summary = [];
  for (const c of top) {
    const dir = path.join(outDir, c.id);
    await fs.mkdir(dir, { recursive: true });
    await renderStreet(c.chain, graph, path.join(dir, "route-blind.png"));
    await renderStreet(c.chain, graph, path.join(dir, "route-labeled.png"), `${c.id} ${c.km.toFixed(1)} km`);
    await fs.writeFile(path.join(dir, `${c.id}.gpx`), gpx(c.id, c.chain), "utf8");
    const clean = { ...c };
    delete clean.chain;
    summary.push({
      ...clean,
      blindImage: path.relative(root, path.join(dir, "route-blind.png")).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(dir, `${c.id}.gpx`)).replace(/\\/g, "/"),
    });
  }
  await fs.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify({ design: { crop: design.crop, size: design.size, polylines: design.polylines, points: design.points.length, scoreSamples: design.scoreSamples.length, heightRatio: design.heightRatio }, scanned: scanned.length, top: summary }, null, 2),
  );
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


