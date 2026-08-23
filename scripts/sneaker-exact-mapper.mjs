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

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-exact-sneaker-map", stamp);

const sourceFile = path.join(root, "sneaker.jpg");
const osmFile = path.join(root, "tmp-gas-spike", "osm-walk-network.json");

const M_PER_LAT = 111320;
const lat0 = 40.715;
const mPerLng = M_PER_LAT * Math.cos((lat0 * Math.PI) / 180);
const roadTypes = new Set([
  "residential",
  "secondary",
  "primary",
  "tertiary",
  "unclassified",
  "living_street",
  "pedestrian",
  "secondary_link",
  "primary_link",
  "tertiary_link",
]);

const mapCrop = {
  left: 0,
  right: 389,
  top: 198,
  bottom: 457,
};

const idx = (x, y, w) => y * w + x;
const meters = (a, b) => Math.hypot((b[0] - a[0]) * M_PER_LAT, (b[1] - a[1]) * mPerLng);
const llToLocal = ([lat, lng]) => [(lng + 74.0) * mPerLng, (lat - lat0) * M_PER_LAT];
const localToLl = ([x, y]) => [lat0 + y / M_PER_LAT, -74.0 + x / mPerLng];

function routePixel(r, g, b) {
  return r >= 138 && g >= 70 && g <= 190 && b >= 45 && b <= 180 && r - g >= 16 && r - b >= 34;
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

function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = idx(x, y, w);
      if (!mask[start] || seen[start]) continue;
      const stack = [[x, y]];
      const pixels = [];
      seen[start] = 1;
      let minX = x, minY = y, maxX = x, maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        pixels.push([cx, cy]);
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);
        for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
          const ni = idx(nx, ny, w);
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      out.push({ pixels, count: pixels.length, bbox: { minX, minY, maxX, maxY } });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

function dilate(mask, w, h, r) {
  const out = new Uint8Array(w * h);
  const rr = r * r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[idx(x, y, w)]) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > rr) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[idx(nx, ny, w)] = 1;
        }
      }
    }
  }
  return out;
}

function pixelDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function simplifyPixels(points, minDist) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || pixelDist(last, p) >= minDist) {
      out.push(p);
      last = p;
    }
  }
  return out;
}

function stitchPixelStrokes(strokes) {
  const remaining = strokes.map((s) => s.slice());
  const route = remaining.shift() ?? [];
  while (remaining.length && route.length) {
    const last = route[route.length - 1];
    let bestIndex = 0, reverse = false, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const stroke = remaining[i];
      const da = pixelDist(last, stroke[0]);
      const db = pixelDist(last, stroke[stroke.length - 1]);
      if (da < bestD) { bestD = da; bestIndex = i; reverse = false; }
      if (db < bestD) { bestD = db; bestIndex = i; reverse = true; }
    }
    const next = remaining.splice(bestIndex, 1)[0];
    if (reverse) next.reverse();
    route.push(...next);
  }
  return route;
}

function centerlineFromRouteMask(routeMask, routeBbox, w, h) {
  const pad = 8;
  const crop = {
    minX: Math.max(0, routeBbox.minX - pad),
    minY: Math.max(0, routeBbox.minY - pad),
    maxX: Math.min(w - 1, routeBbox.maxX + pad),
    maxY: Math.min(h - 1, routeBbox.maxY + pad),
  };
  const cw = crop.maxX - crop.minX + 1;
  const ch = crop.maxY - crop.minY + 1;
  const lineMask = new Uint8Array(cw * ch);
  for (let y = crop.minY; y <= crop.maxY; y++) {
    for (let x = crop.minX; x <= crop.maxX; x++) {
      if (routeMask[idx(x, y, w)]) lineMask[idx(x - crop.minX, y - crop.minY, cw)] = 255;
    }
  }
  const strokes = prepareTracedBinaryComponents(lineMask, cw, ch, 6, 20)
    .map((comp) => centerlinePolylineFromPreparedBinary(comp, cw, ch))
    .filter((stroke) => stroke.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
    .map((stroke) => simplifyPixels(stroke.map(([x, y]) => [x + crop.minX, y + crop.minY]), 2.5));
  return simplifyPixels(stitchPixelStrokes(strokes), 3.5);
}
function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function fitPixelToLl([x, y], fit) {
  const u = (x - mapCrop.left) / (mapCrop.right - mapCrop.left);
  const v = (y - mapCrop.top) / (mapCrop.bottom - mapCrop.top);
  return [
    fit.north + (fit.south - fit.north) * v,
    fit.west + (fit.east - fit.west) * u,
  ];
}

function llToPixel([lat, lng], fit) {
  const u = (lng - fit.west) / (fit.east - fit.west);
  const v = (lat - fit.north) / (fit.south - fit.north);
  return [
    mapCrop.left + u * (mapCrop.right - mapCrop.left),
    mapCrop.top + v * (mapCrop.bottom - mapCrop.top),
  ];
}

function pointToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}

function readRouteMask(data, info) {
  const raw = new Uint8Array(info.width * info.height);
  for (let y = mapCrop.top; y <= mapCrop.bottom; y++) {
    for (let x = mapCrop.left; x <= mapCrop.right; x++) {
      const i = (y * info.width + x) * info.channels;
      if (routePixel(data[i], data[i + 1], data[i + 2])) raw[idx(x, y, info.width)] = 1;
    }
  }
  const kept = components(raw, info.width, info.height)
    .filter((c) => c.count >= 70 && c.bbox.minY >= mapCrop.top && c.bbox.maxY <= mapCrop.bottom)
    .slice(0, 12);
  const mask = new Uint8Array(info.width * info.height);
  for (const comp of kept) for (const [x, y] of comp.pixels) mask[idx(x, y, info.width)] = 1;
  const pixels = kept.flatMap((c) => c.pixels);
  return { mask, pixels, kept, bbox: bounds(pixels) };
}

function buildOsm(raw) {
  const coord = new Map();
  for (const el of raw.elements) if (el.type === "node") coord.set(el.id, [el.lat, el.lon]);

  const adj = new Map();
  const edges = [];
  const addAdj = (a, b, w, edgeIndex) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w, edgeIndex });
  };

  for (const way of raw.elements) {
    if (way.type !== "way" || !way.tags?.highway || !roadTypes.has(way.tags.highway)) continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1];
      const b = way.nodes[i];
      const ca = coord.get(a);
      const cb = coord.get(b);
      if (!ca || !cb) continue;
      const w = meters(ca, cb);
      const edgeIndex = edges.length;
      edges.push({
        index: edgeIndex,
        a,
        b,
        ca,
        cb,
        w,
        wayId: way.id,
        name: way.tags.name ?? "",
        highway: way.tags.highway,
      });
      addAdj(a, b, w, edgeIndex);
      addAdj(b, a, w, edgeIndex);
    }
  }

  const grid = new Map();
  const cell = 0.0025;
  const cellOf = ([lat, lng]) => `${Math.floor(lat / cell)}:${Math.floor(lng / cell)}`;
  for (const id of adj.keys()) {
    const c = coord.get(id);
    const key = cellOf(c);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(id);
  }
  return { coord, adj, edges, grid, cell };
}

function nearestNode(osm, p) {
  const gx = Math.floor(p[0] / osm.cell);
  const gy = Math.floor(p[1] / osm.cell);
  let best = -1, bestD = Infinity;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (const id of osm.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
        const d = meters(p, osm.coord.get(id));
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
    }
  }
  return best;
}

function buildStreetIndex(edges, cell = 180) {
  const grid = new Map();
  for (const e of edges) {
    const a = llToLocal(e.ca);
    const b = llToLocal(e.cb);
    e.la = a;
    e.lb = b;
    e.minX = Math.min(a[0], b[0]);
    e.maxX = Math.max(a[0], b[0]);
    e.minY = Math.min(a[1], b[1]);
    e.maxY = Math.max(a[1], b[1]);
    for (let gx = Math.floor(e.minX / cell); gx <= Math.floor(e.maxX / cell); gx++) {
      for (let gy = Math.floor(e.minY / cell); gy <= Math.floor(e.maxY / cell); gy++) {
        const key = `${gx}:${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(e.index);
      }
    }
  }
  return { grid, cell };
}

function nearestStreetDistance(p, edges, index, radius = 180) {
  const lp = llToLocal(p);
  const gx = Math.floor(lp[0] / index.cell);
  const gy = Math.floor(lp[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  let best = Infinity;
  const seen = new Set();
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dy = -cr; dy <= cr; dy++) {
      for (const edgeIndex of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
        if (seen.has(edgeIndex)) continue;
        seen.add(edgeIndex);
        const e = edges[edgeIndex];
        if (lp[0] < e.minX - radius || lp[0] > e.maxX + radius || lp[1] < e.minY - radius || lp[1] > e.maxY + radius) continue;
        best = Math.min(best, pointToSegment(lp, e.la, e.lb));
      }
    }
  }
  return best;
}

function scoreFit(routePixels, fit, edges, streetIndex) {
  const stride = Math.max(1, Math.floor(routePixels.length / 180));
  let sum = 0, veryClose = 0, missed = 0;
  for (let i = 0; i < routePixels.length; i += stride) {
    const d = nearestStreetDistance(fitPixelToLl(routePixels[i], fit), edges, streetIndex);
    if (d < 18) veryClose++;
    if (d > 85 || !Number.isFinite(d)) missed++;
    sum += Math.min(190, d);
  }
  const n = Math.ceil(routePixels.length / stride);
  return sum / n + missed * 5 - (veryClose / n) * 24;
}

function nearestStreetEdge(p, edges, index, radius = 160) {
  const lp = llToLocal(p);
  const gx = Math.floor(lp[0] / index.cell);
  const gy = Math.floor(lp[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  let best = null, bestD = Infinity;
  const seen = new Set();
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dy = -cr; dy <= cr; dy++) {
      for (const edgeIndex of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
        if (seen.has(edgeIndex)) continue;
        seen.add(edgeIndex);
        const e = edges[edgeIndex];
        if (lp[0] < e.minX - radius || lp[0] > e.maxX + radius || lp[1] < e.minY - radius || lp[1] > e.maxY + radius) continue;
        const d = pointToSegment(lp, e.la, e.lb);
        if (d < bestD) { bestD = d; best = e; }
      }
    }
  }
  return { edge: best, distance: bestD };
}

function selectEdgesFromCenterline(osm, fit, centerlinePixels, streetIndex, maxDistance) {
  const selected = new Map();
  for (const px of centerlinePixels) {
    const p = fitPixelToLl(px, fit);
    const { edge, distance } = nearestStreetEdge(p, osm.edges, streetIndex, 150);
    if (!edge || distance > maxDistance) continue;
    const prev = selected.get(edge.index);
    if (!prev || distance < prev.bestDistance) {
      selected.set(edge.index, { ...edge, hitRatio: 1, hits: 1, coreHits: 1, bestDistance: distance });
    }
  }
  return [...selected.values()];
}
function sampleSegmentPixels(a, b, step = 2.5) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(d / step));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function inImage([x, y], w, h, pad = 10) {
  return x >= -pad && y >= mapCrop.top - pad && x <= w + pad && y <= mapCrop.bottom + pad;
}

function selectEdges(osm, fit, routeMask, routeDilated, w, h, minRatio, minHits) {
  const selected = [];
  for (const edge of osm.edges) {
    const pa = llToPixel(edge.ca, fit);
    const pb = llToPixel(edge.cb, fit);
    if (!inImage(pa, w, h) && !inImage(pb, w, h)) continue;
    const box = {
      minX: Math.min(pa[0], pb[0]),
      maxX: Math.max(pa[0], pb[0]),
      minY: Math.min(pa[1], pb[1]),
      maxY: Math.max(pa[1], pb[1]),
    };
    if (box.maxX < -8 || box.minX > w + 8 || box.maxY < mapCrop.top - 8 || box.minY > mapCrop.bottom + 8) continue;
    const samples = sampleSegmentPixels(pa, pb);
    let hits = 0, coreHits = 0;
    for (const [fx, fy] of samples) {
      const x = Math.round(fx), y = Math.round(fy);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (routeDilated[idx(x, y, w)]) hits++;
      if (routeMask[idx(x, y, w)]) coreHits++;
    }
    const ratio = hits / samples.length;
    if (hits >= minHits && (ratio >= minRatio || coreHits >= 2)) {
      selected.push({ ...edge, hitRatio: ratio, hits, coreHits });
    }
  }
  return selected;
}

function rasterizeEdges(edges, fit, w, h, radius = 5) {
  const mask = new Uint8Array(w * h);
  for (const edge of edges) {
    const pa = llToPixel(edge.ca, fit);
    const pb = llToPixel(edge.cb, fit);
    for (const [fx, fy] of sampleSegmentPixels(pa, pb, 1.5)) {
      const cx = Math.round(fx), cy = Math.round(fy);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < w && y < h) mask[idx(x, y, w)] = 1;
        }
      }
    }
  }
  return mask;
}

function coverageScore(routePixels, edges, fit, w, h) {
  const streetMask = rasterizeEdges(edges, fit, w, h, 5);
  let covered = 0;
  for (const [x, y] of routePixels) if (streetMask[idx(x, y, w)]) covered++;
  const inkCoverage = covered / routePixels.length;
  const edgeKm = edges.reduce((sum, e) => sum + e.w, 0) / 1000;
  return { inkCoverage, edgeKm };
}

function dijkstra(osm, start, goal) {
  if (start === goal) return [start];
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const open = new Map([[start, 0]]);
  const done = new Set();
  let guard = 0;
  while (open.size && guard++ < 180000) {
    let cur = -1, best = Infinity;
    for (const [id, d] of open) if (d < best) { best = d; cur = id; }
    if (cur === goal) {
      const ids = [cur];
      while (prev.has(ids[ids.length - 1])) ids.push(prev.get(ids[ids.length - 1]));
      return ids.reverse();
    }
    open.delete(cur);
    done.add(cur);
    for (const edge of osm.adj.get(cur) ?? []) {
      if (done.has(edge.to)) continue;
      const nd = best + edge.w;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, cur);
        open.set(edge.to, nd);
      }
    }
  }
  return null;
}

function selectedComponents(selected) {
  const adj = new Map();
  for (const e of selected) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e);
    adj.get(e.b).push(e);
  }
  const seen = new Set();
  const comps = [];
  for (const node of adj.keys()) {
    if (seen.has(node)) continue;
    const stack = [node], nodes = new Set(), edges = new Set();
    seen.add(node);
    while (stack.length) {
      const n = stack.pop();
      nodes.add(n);
      for (const e of adj.get(n) ?? []) {
        edges.add(e.index);
        const other = e.a === n ? e.b : e.a;
        if (!seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
    }
    comps.push({ nodes: [...nodes], edgeIds: [...edges] });
  }
  return comps.sort((a, b) => b.edgeIds.length - a.edgeIds.length);
}

function dfsCoverComponent(comp, selectedByNode, start) {
  const used = new Set();
  const walk = [start];
  function go(node) {
    const edges = [...(selectedByNode.get(node) ?? [])]
      .filter((e) => comp.edgeIds.includes(e.index))
      .sort((a, b) => b.hitRatio - a.hitRatio);
    for (const e of edges) {
      if (used.has(e.index)) continue;
      used.add(e.index);
      const other = e.a === node ? e.b : e.a;
      walk.push(other);
      go(other);
      walk.push(node);
    }
  }
  go(start);
  const compact = [];
  for (const id of walk) if (compact[compact.length - 1] !== id) compact.push(id);
  return compact;
}

function stitchSelectedWalk(osm, selected) {
  const selectedByNode = new Map();
  for (const e of selected) {
    if (!selectedByNode.has(e.a)) selectedByNode.set(e.a, []);
    if (!selectedByNode.has(e.b)) selectedByNode.set(e.b, []);
    selectedByNode.get(e.a).push(e);
    selectedByNode.get(e.b).push(e);
  }
  const comps = selectedComponents(selected).filter((c) => c.edgeIds.length >= 2);
  const routeIds = [];
  let current = null;
  for (const comp of comps) {
    const endpoints = comp.nodes.filter((n) => (selectedByNode.get(n) ?? []).filter((e) => comp.edgeIds.includes(e.index)).length === 1);
    let start = endpoints[0] ?? comp.nodes[0];
    if (current !== null) {
      let bestNode = start, bestDist = Infinity;
      const curLl = osm.coord.get(current);
      for (const n of comp.nodes) {
        const d = meters(curLl, osm.coord.get(n));
        if (d < bestDist) { bestDist = d; bestNode = n; }
      }
      const connector = dijkstra(osm, current, bestNode);
      if (connector) for (const id of connector.slice(1)) routeIds.push(id);
      start = bestNode;
    }
    const compWalk = dfsCoverComponent(comp, selectedByNode, start);
    for (const id of compWalk) {
      if (routeIds[routeIds.length - 1] !== id) routeIds.push(id);
    }
    current = routeIds[routeIds.length - 1] ?? current;
  }
  return routeIds.map((id) => osm.coord.get(id)).filter(Boolean);
}

function pathD(points, project) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

async function renderMask(mask, w, h, file) {
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const j = i * 4;
    rgba[j] = 0;
    rgba[j + 1] = 0;
    rgba[j + 2] = 0;
  }
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
}

async function renderScreenshotOverlay(source, selected, fit, routeMask, w, h, file) {
  const base = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.from(base.data);
  for (let i = 0; i < routeMask.length; i++) {
    if (!routeMask[i]) continue;
    const j = i * 4;
    rgba[j] = Math.round(rgba[j] * 0.3);
    rgba[j + 1] = Math.round(rgba[j + 1] * 0.3 + 60);
    rgba[j + 2] = Math.round(rgba[j + 2] * 0.3 + 190);
    rgba[j + 3] = 255;
  }
  const streetPaths = selected.map((e) => {
    const a = llToPixel(e.ca, fit);
    const b = llToPixel(e.cb, fit);
    return `<path d="M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}" stroke="#00e5ff" stroke-width="3.2" stroke-linecap="round"/>`;
  }).join("\n");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${streetPaths}</svg>`);
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .composite([{ input: svg, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

async function renderStreetUnion(osm, selected, chain, file, label) {
  const pts = selected.flatMap((e) => [llToLocal(e.ca), llToLocal(e.cb)]);
  const b = bounds(pts);
  const pad = 260;
  const view = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  const w = 1100, h = 820;
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale;
  const usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const projectLocal = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [];
  for (const e of osm.edges) {
    const a = llToLocal(e.ca), b2 = llToLocal(e.cb);
    if (!inView(a) && !inView(b2)) continue;
    streets.push(`<path d="${pathD([a, b2], projectLocal)}" fill="none" stroke="#dddddd" stroke-width="1.5"/>`);
  }
  const unionPaths = selected.map((e) => `<path d="${pathD([llToLocal(e.ca), llToLocal(e.cb)], projectLocal)}" fill="none" stroke="#86172d" stroke-width="10" stroke-linecap="round"/>`).join("\n");
  const unionTop = selected.map((e) => `<path d="${pathD([llToLocal(e.ca), llToLocal(e.cb)], projectLocal)}" fill="none" stroke="#f15c2e" stroke-width="5" stroke-linecap="round"/>`).join("\n");
  const chainPath = chain.length ? `<path d="${pathD(chain.map(llToLocal), projectLocal)}" fill="none" stroke="#00a6c8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f6f4ef"/>
    <rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>
    ${streets.join("\n")}
    ${unionPaths}
    ${unionTop}
    ${chainPath}
    <text x="34" y="50" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso exact sneaker mapper" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

function geojsonEdges(selected) {
  return {
    type: "FeatureCollection",
    features: selected.map((e) => ({
      type: "Feature",
      properties: {
        wayId: e.wayId,
        name: e.name,
        highway: e.highway,
        hitRatio: +e.hitRatio.toFixed(3),
        meters: +e.w.toFixed(1),
      },
      geometry: {
        type: "LineString",
        coordinates: [[e.ca[1], e.ca[0]], [e.cb[1], e.cb[0]]],
      },
    })),
  };
}

async function makeSheet(items, file) {
  const tileW = 560, tileH = 430;
  const comps = [];
  for (let i = 0; i < items.length; i++) {
    const left = (i % 2) * tileW;
    const top = Math.floor(i / 2) * tileH;
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}"><rect width="100%" height="100%" fill="#f7f4ee"/><text x="18" y="32" font-family="Arial" font-size="19" font-weight="700">${items[i].label}</text></svg>`);
    const img = await sharp(items[i].file).resize({ width: tileW - 28, height: tileH - 52, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    comps.push({ input: label, left, top });
    comps.push({ input: img.data, left: left + Math.round((tileW - img.info.width) / 2), top: top + 44 + Math.round((tileH - 58 - img.info.height) / 2) });
  }
  await sharp({ create: { width: tileW * 2, height: tileH * Math.ceil(items.length / 2), channels: 4, background: "#ece7dd" } })
    .composite(comps)
    .png()
    .toFile(file);
}

function routeLengthKm(chain) {
  let total = 0;
  for (let i = 1; i < chain.length; i++) total += meters(chain[i - 1], chain[i]);
  return total / 1000;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(sourceFile, path.join(outDir, "0-reference-sneaker.jpg"));

  const image = await sharp(sourceFile).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = image.info;
  const route = readRouteMask(image.data, image.info);
  const centerlinePixels = centerlineFromRouteMask(route.mask, route.bbox, w, h);
  const routeDilated = dilate(route.mask, w, h, 6);
  await renderMask(route.mask, w, h, path.join(outDir, "1-route-mask.png"));

  const osm = buildOsm(JSON.parse(await fs.readFile(osmFile, "utf8")));
  const streetIndex = buildStreetIndex(osm.edges);

  const coarseFits = [];
  for (let north = 40.727; north <= 40.733; north += 0.001) {
    for (let south = 40.700; south <= 40.707; south += 0.001) {
      if (north <= south + 0.018) continue;
      for (let west = -74.020; west <= -74.013; west += 0.001) {
        for (let east = -73.982; east <= -73.972; east += 0.001) {
          if (east <= west + 0.035) continue;
          const fit = { north, south, west, east };
          const score = scoreFit(route.pixels, fit, osm.edges, streetIndex);
          coarseFits.push({ ...fit, score });
        }
      }
    }
  }
  coarseFits.sort((a, b) => a.score - b.score);

  const fitKeys = new Set();
  const fits = [];
  for (const seed of coarseFits.slice(0, 18)) {
    for (let dn = -0.0006; dn <= 0.00061; dn += 0.0003) {
      for (let ds = -0.0006; ds <= 0.00061; ds += 0.0003) {
        for (let dw = -0.0006; dw <= 0.00061; dw += 0.0003) {
          for (let de = -0.0006; de <= 0.00061; de += 0.0003) {
            const fit = {
              north: seed.north + dn,
              south: seed.south + ds,
              west: seed.west + dw,
              east: seed.east + de,
            };
            if (fit.north <= fit.south + 0.018 || fit.east <= fit.west + 0.035) continue;
            const key = `${fit.north.toFixed(4)}:${fit.south.toFixed(4)}:${fit.west.toFixed(4)}:${fit.east.toFixed(4)}`;
            if (fitKeys.has(key)) continue;
            fitKeys.add(key);
            const score = scoreFit(route.pixels, fit, osm.edges, streetIndex);
            fits.push({ ...fit, score });
          }
        }
      }
    }
  }
  fits.sort((a, b) => a.score - b.score);

  const candidates = [];
  for (const fit of fits.slice(0, 80)) {
    for (const maxDistance of [28, 34, 42, 52]) {
      const selected = selectEdgesFromCenterline(osm, fit, centerlinePixels, streetIndex, maxDistance);
      if (selected.length < 35) continue;
      const cov = coverageScore(route.pixels, selected, fit, w, h);
      const score = (1 - cov.inkCoverage) * 100 + Math.abs(cov.edgeKm - 18.1) * 3.4 + Math.max(0, selected.length - 260) * 0.06 + fit.score * 0.12;
      candidates.push({ fit, selected, cov, score, minRatio: `centerline-${maxDistance}m` });
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  const sheetItems = [];
  const results = [];
  let n = 0;
  for (const candidate of candidates.slice(0, 8)) {
    const idName = `exact-${String(++n).padStart(3, "0")}`;
    const dir = path.join(outDir, idName);
    await fs.mkdir(dir, { recursive: true });
    const chain = stitchSelectedWalk(osm, candidate.selected);
    const overlayFile = path.join(dir, "overlay-on-screenshot.png");
    const unionFile = path.join(dir, "street-union.png");
    await renderScreenshotOverlay(sourceFile, candidate.selected, candidate.fit, route.mask, w, h, overlayFile);
    await renderStreetUnion(osm, candidate.selected, chain, unionFile, `${idName} union ${candidate.cov.edgeKm.toFixed(1)} km, stitched ${routeLengthKm(chain).toFixed(1)} km`);
    await fs.writeFile(path.join(dir, `${idName}.gpx`), gpx(idName, chain));
    await fs.writeFile(path.join(dir, "matched-streets.geojson"), JSON.stringify(geojsonEdges(candidate.selected), null, 2));
    sheetItems.push({ label: `${idName} overlay cov ${(candidate.cov.inkCoverage * 100).toFixed(1)}% edges ${candidate.cov.edgeKm.toFixed(1)}km`, file: overlayFile });
    sheetItems.push({ label: `${idName} street union / GPX stitch`, file: unionFile });
    results.push({
      id: idName,
      score: +candidate.score.toFixed(3),
      fit: Object.fromEntries(Object.entries(candidate.fit).map(([k, v]) => [k, +v.toFixed(6)])),
      minRatio: candidate.minRatio,
      inkCoveragePct: +(candidate.cov.inkCoverage * 100).toFixed(2),
      selectedEdgeKm: +candidate.cov.edgeKm.toFixed(2),
      selectedEdges: candidate.selected.length,
      components: selectedComponents(candidate.selected).length,
      stitchedGpxKm: +routeLengthKm(chain).toFixed(2),
      stitchedPoints: chain.length,
      overlay: path.relative(root, overlayFile).replace(/\\/g, "/"),
      streetUnion: path.relative(root, unionFile).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(dir, `${idName}.gpx`)).replace(/\\/g, "/"),
      geojson: path.relative(root, path.join(dir, "matched-streets.geojson")).replace(/\\/g, "/"),
    });
  }

  await makeSheet(sheetItems, path.join(outDir, "exact-mapper-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({
    source: "sneaker.jpg",
    mapCrop,
    routePixels: route.pixels.length,
    routeBbox: route.bbox,
    keptComponents: route.kept.map((c) => ({ count: c.count, bbox: c.bbox })),
    topFits: fits.slice(0, 20).map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +v.toFixed(6)]))),
    results,
  }, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
