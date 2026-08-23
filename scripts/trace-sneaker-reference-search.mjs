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
} = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-traced-sneaker-search", stamp);

const M_PER_LAT = 111320;
const BASE = [40.744061, -74.006811];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

function idx(x, y, w) {
  return y * w + x;
}

function isReferenceRouteRed(r, g, b) {
  return r > 105 && r - g > 24 && r - b > 18;
}

function neighbors8(x, y, w, h) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
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

function traceCropBounds(components) {
  const shoeComps = components.filter(
    (c) => c.maxY > 220 && c.count >= 35 && c.maxX - c.minX >= 4 && c.maxY - c.minY >= 4,
  );
  if (!shoeComps.length) throw new Error("No sneaker route components found.");
  return {
    minX: Math.max(0, Math.min(...shoeComps.map((c) => c.minX)) - 8),
    maxX: Math.max(...shoeComps.map((c) => c.maxX)) + 8,
    minY: Math.max(0, Math.min(...shoeComps.map((c) => c.minY)) - 8),
    maxY: Math.max(...shoeComps.map((c) => c.maxY)) + 8,
    components: shoeComps.length,
  };
}

function simplifyByDistance(points, minDist) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) {
      out.push(p);
      last = p;
    }
  }
  const tail = points[points.length - 1];
  if (tail && out.length && out[out.length - 1] !== tail) out.push(tail);
  return out;
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

function normalizeTrace(points) {
  const b = bounds(points);
  const w = b.maxX - b.minX || 1;
  return points.map(([x, y]) => ({
    x: (x - b.minX) / w,
    y: (y - b.minY) / w,
  }));
}

function transformTrace(unit, { rotateDeg, mirrorX, mirrorY }) {
  const a = (rotateDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const original = bounds(unit.map((p) => [p.x, p.y]));
  const cx = (original.minX + original.maxX) / 2;
  const cy = (original.minY + original.maxY) / 2;
  const pts = unit.map((p) => {
    let x = (mirrorX ? original.maxX - (p.x - original.minX) : p.x) - cx;
    let y = (mirrorY ? original.maxY - (p.y - original.minY) : p.y) - cy;
    const rx = x * ca - y * sa;
    const ry = x * sa + y * ca;
    return [rx, ry];
  });
  const b = bounds(pts);
  const width = b.maxX - b.minX || 1;
  const height = b.maxY - b.minY || 1;
  return {
    points: pts.map(([x, y]) => [(x - b.minX) / width, (y - b.minY) / height]),
    heightRatio: height / width,
  };
}

function localToLatLng([x, y]) {
  const e = x * X.e + y * Y.e;
  const n = x * X.n + y * Y.n;
  const mPerLng = M_PER_LAT * Math.cos((BASE[0] * Math.PI) / 180);
  return [BASE[0] + n / M_PER_LAT, BASE[1] + e / mPerLng];
}

function latLngToLocal([lat, lng]) {
  const mPerLng = M_PER_LAT * Math.cos((BASE[0] * Math.PI) / 180);
  const n = (lat - BASE[0]) * M_PER_LAT;
  const e = (lng - BASE[1]) * mPerLng;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}

function place(unitPts, center, widthM, heightRatio) {
  const heightM = widthM * heightRatio;
  return unitPts.map(([u, v]) => {
    const x = center[0] + (u - 0.5) * widthM;
    const y = center[1] + (v - 0.5) * heightM;
    return localToLatLng([x, y]);
  });
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
  const s = Math.min((w - pad * 2) / (b.maxX - b.minX || 1), (h - pad * 2) / (b.maxY - b.minY || 1));
  const usedW = (b.maxX - b.minX) * s;
  const usedH = (b.maxY - b.minY) * s;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - b.minX) * s, oy + (y - b.minY) * s];
  const d = routeD(points, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function renderStreet(chain, graph, file, label = "") {
  const route = chain.map(latLngToLocal);
  const rb = bounds(route);
  const pad = 260;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const w = 1100;
  const h = 820;
  const s = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * s;
  const usedH = (view.maxY - view.minY) * s;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * s, oy + (view.maxY - y) * s];
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
  const rd = routeD(route, project);
  const text = label ? `<text x="32" y="46" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#771225" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso traced sneaker search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function extractSneakerTrace() {
  const source = path.join(root, "sneaker.jpg");
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const fullMask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (isReferenceRouteRed(data[i], data[i + 1], data[i + 2])) fullMask[idx(x, y, info.width)] = 1;
    }
  }

  const components = redComponents(fullMask, info.width, info.height);
  const crop = traceCropBounds(components);
  const cw = crop.maxX - crop.minX + 1;
  const ch = crop.maxY - crop.minY + 1;
  const ink = [];
  for (let y = crop.minY; y <= crop.maxY; y++) {
    for (let x = crop.minX; x <= crop.maxX; x++) {
      if (fullMask[idx(x, y, info.width)]) ink.push([x - crop.minX, y - crop.minY]);
    }
  }

  const bin = 7;
  const cols = [];
  for (let x0 = 0; x0 < cw; x0 += bin) {
    const xs = ink.filter(([x]) => x >= x0 && x < x0 + bin).map(([, y]) => y).sort((a, b) => a - b);
    if (xs.length < 2) continue;
    cols.push({ x: x0 + bin / 2, top: xs[Math.floor(xs.length * 0.08)], bottom: xs[Math.floor(xs.length * 0.94)] });
  }
  if (cols.length < 8) throw new Error("No usable sneaker envelope columns found.");

  function smooth(values, key) {
    return values.map((v, i) => {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(values.length - 1, i + 2); j++) {
        sum += values[j][key];
        count++;
      }
      return { ...v, [key]: sum / count };
    });
  }
  const topCols = smooth(cols, "top");
  const bottomCols = smooth(cols, "bottom");
  const interp = (arr, key, xNorm) => {
    const x = xNorm * cw;
    let best = arr[0];
    for (const c of arr) if (Math.abs(c.x - x) < Math.abs(best.x - x)) best = c;
    return best[key] / ch;
  };
  const norm = ([x, y]) => [Math.max(0, Math.min(1, x / cw)), Math.max(0, Math.min(1, y / ch))];

  const bottom = bottomCols.map((c) => norm([c.x, c.bottom]));
  const top = [...topCols].reverse().map((c) => norm([c.x, c.top]));
  const silhouette = [...bottom, [1.02, 0.64], [0.98, 0.38], ...top, [-0.01, 0.50], bottom[0]];

  const detail = [];
  const addStroke = (pts) => detail.push(...pts.map(([x, y]) => [x, y]));
  addStroke([[0.10, interp(bottomCols, "bottom", 0.10) - 0.12], [0.38, interp(bottomCols, "bottom", 0.38) - 0.11], [0.70, interp(bottomCols, "bottom", 0.70) - 0.10], [0.90, interp(bottomCols, "bottom", 0.90) - 0.12]]);
  addStroke([[0.20, 0.52], [0.34, 0.36], [0.54, 0.30], [0.76, 0.40], [0.90, 0.56]]);
  addStroke([[0.45, 0.30], [0.50, 0.52], [0.56, 0.31], [0.62, 0.52], [0.69, 0.34]]);
  addStroke([[0.08, 0.50], [0.10, 0.74], [0.22, 0.82]]);

  const points = simplifyByDistance([
    ...silhouette.map(([x, y]) => [x * cw, y * ch]),
    ...detail.map(([x, y]) => [x * cw, y * ch]),
  ], 3.5);
  return { crop, polylines: [points], points, normalized: normalizeTrace(points) };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(path.join(root, "sneaker.jpg"), path.join(outDir, "0-reference-sneaker.jpg"));

  const lattice = JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8"));
  const graph = buildLatticeGraph(lattice);
  const trace = await extractSneakerTrace();
  await fs.writeFile(path.join(outDir, "trace-meta.json"), JSON.stringify({
    crop: trace.crop,
    polylines: trace.polylines.length,
    points: trace.points.length,
  }, null, 2));
  await renderPath(trace.points, path.join(outDir, "1-reference-red-route-trace.png"));

  const centersLatLng = [
    [40.7165, -73.9960],
    [40.7185, -73.9980],
    [40.7205, -73.9965],
    [40.7220, -73.9945],
    [40.7240, -73.9930],
    [40.7145, -73.9995],
    [40.7115, -74.0015],
  ];
  const centers = centersLatLng.map(latLngToLocal);
  const widths = [1800, 2050, 2300, 2550, 2800, 3050];
  const rotations = [-12, -8, -4, 0, 4, 8, 12];
  const heightMultipliers = [0.72, 0.82, 0.92, 1, 1.08];
  const all = [];
  let idxCounter = 0;

  for (const rotateDeg of rotations) {
    for (const mirrorX of [false, true]) {
      for (const mirrorY of [false]) {
        const transformed = transformTrace(trace.normalized, { rotateDeg, mirrorX, mirrorY });
        const unit = transformed.points;
        const baseHeightRatio = transformed.heightRatio;
        for (const heightMultiplier of heightMultipliers) {
          const heightRatio = baseHeightRatio * heightMultiplier;
          for (const center of centers) {
            for (const widthM of widths) {
              const placed = place(unit, center, widthM, heightRatio);
              const res = compileContourToLattice(placed, graph, {
                sampleMeters: 34,
                pinRadiusMeters: 180,
                minPinSpacingMeters: 70,
                maxLegDetourRatio: 3.4,
                maxLegDetourSlackMeters: 320,
              });
              if (!res) continue;
              const rb = bounds(res.chain.map(latLngToLocal));
              const aspect = (rb.maxX - rb.minX) / Math.max(1, rb.maxY - rb.minY);
              const targetKm = 18.1;
              const routeLenPenalty = Math.max(0, Math.abs(res.km - targetKm) - 1.0) * 3.0;
              const score =
                res.meanDeviationMeters +
                res.skippedPins * 220 +
                Math.abs(aspect - 2.15) * 20 +
                routeLenPenalty;
              all.push({
                id: `trace-${String(++idxCounter).padStart(4, "0")}`,
                score,
                rotateDeg,
                mirrorX,
                mirrorY,
                widthM,
                heightRatio,
                heightMultiplier,
                km: res.km,
                meanDeviationMeters: res.meanDeviationMeters,
                maxDeviationMeters: res.maxDeviationMeters,
                skippedPins: res.skippedPins,
                legCount: res.legCount,
                aspect,
                chain: res.chain,
              });
            }
          }
        }
      }
    }
  }

  all.sort((a, b) => a.score - b.score);
  const top = all.slice(0, 16);
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
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});





