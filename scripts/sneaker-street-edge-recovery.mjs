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
const outDir = path.join(root, "tmp-sneaker-street-edge-recovery", stamp);

const sourceFile = path.join(root, "sneaker.jpg");
const osmFile = path.join(root, "tmp-gas-spike", "osm-walk-network.json");

const M_PER_LAT = 111320;
const lat0 = 40.715;
const mPerLng = M_PER_LAT * Math.cos((lat0 * Math.PI) / 180);

const mapCrop = { left: 0, right: 389, top: 198, bottom: 457 };

const fit = {
  north: 40.7313,
  south: 40.7067,
  west: -74.0147,
  east: -73.9733,
};

const roadTypes = new Set([
  "residential",
  "secondary",
  "primary",
  "tertiary",
  "unclassified",
  "living_street",
  "pedestrian",
  "footway",
  "path",
  "cycleway",
  "secondary_link",
  "primary_link",
  "tertiary_link",
]);

const idx = (x, y, w) => y * w + x;

function meters(a, b) {
  return Math.hypot((b[0] - a[0]) * M_PER_LAT, (b[1] - a[1]) * mPerLng);
}

function routePixel(r, g, b) {
  return (
    r >= 138 &&
    g >= 70 &&
    g <= 190 &&
    b >= 45 &&
    b <= 180 &&
    r - g >= 16 &&
    r - b >= 34
  );
}

function llToLocal([lat, lng]) {
  return [(lng + 74.0) * mPerLng, (lat - lat0) * M_PER_LAT];
}

function fitPixelToLl([x, y]) {
  const u = (x - mapCrop.left) / (mapCrop.right - mapCrop.left);
  const v = (y - mapCrop.top) / (mapCrop.bottom - mapCrop.top);
  return [
    fit.north + (fit.south - fit.north) * v,
    fit.west + (fit.east - fit.west) * u,
  ];
}

function llToPixel([lat, lng]) {
  const u = (lng - fit.west) / (fit.east - fit.west);
  const v = (lat - fit.north) / (fit.south - fit.north);
  return [
    mapCrop.left + u * (mapCrop.right - mapCrop.left),
    mapCrop.top + v * (mapCrop.bottom - mapCrop.top),
  ];
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
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
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

function readRouteMask(data, info) {
  const raw = new Uint8Array(info.width * info.height);
  for (let y = mapCrop.top; y <= mapCrop.bottom; y++) {
    for (let x = mapCrop.left; x <= mapCrop.right; x++) {
      const i = (y * info.width + x) * info.channels;
      if (routePixel(data[i], data[i + 1], data[i + 2])) {
        raw[idx(x, y, info.width)] = 1;
      }
    }
  }
  const kept = components(raw, info.width, info.height)
    .filter(
      (c) =>
        c.count >= 70 &&
        c.bbox.minY >= mapCrop.top &&
        c.bbox.maxY <= mapCrop.bottom,
    )
    .slice(0, 14);
  const mask = new Uint8Array(info.width * info.height);
  for (const comp of kept) {
    for (const [x, y] of comp.pixels) mask[idx(x, y, info.width)] = 1;
  }
  const pixels = kept.flatMap((c) => c.pixels);
  return { mask, pixels, kept, bbox: bounds(pixels) };
}

function stitchPixelStrokes(strokes) {
  const remaining = strokes.map((s) => s.slice());
  const route = remaining.shift() ?? [];
  while (remaining.length && route.length) {
    const last = route[route.length - 1];
    let bestIndex = 0;
    let reverse = false;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const stroke = remaining[i];
      const da = pixelDist(last, stroke[0]);
      const db = pixelDist(last, stroke[stroke.length - 1]);
      if (da < bestD) {
        bestD = da;
        bestIndex = i;
        reverse = false;
      }
      if (db < bestD) {
        bestD = db;
        bestIndex = i;
        reverse = true;
      }
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
    .slice(0, 8)
    .map((stroke) =>
      simplifyPixels(
        stroke.map(([x, y]) => [x + crop.minX, y + crop.minY]),
        2.5,
      ),
    );
  return simplifyPixels(stitchPixelStrokes(strokes), 3.5);
}

function buildOsm(raw) {
  const coord = new Map();
  for (const el of raw.elements) {
    if (el.type === "node") coord.set(el.id, [el.lat, el.lon]);
  }

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
  return { coord, adj, edges };
}

function pointToSegmentInfo(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2))
    : 0;
  const x = a[0] + vx * t;
  const y = a[1] + vy * t;
  return { t, distance: Math.hypot(p[0] - x, p[1] - y) };
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

function nearestStreetEdge(ll, edges, index, radius = 150) {
  const lp = llToLocal(ll);
  const gx = Math.floor(lp[0] / index.cell);
  const gy = Math.floor(lp[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  let best = null;
  let bestInfo = { t: 0, distance: Infinity };
  const seen = new Set();
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dy = -cr; dy <= cr; dy++) {
      for (const edgeIndex of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
        if (seen.has(edgeIndex)) continue;
        seen.add(edgeIndex);
        const e = edges[edgeIndex];
        if (
          lp[0] < e.minX - radius ||
          lp[0] > e.maxX + radius ||
          lp[1] < e.minY - radius ||
          lp[1] > e.maxY + radius
        ) {
          continue;
        }
        const info = pointToSegmentInfo(lp, e.la, e.lb);
        if (info.distance < bestInfo.distance) {
          bestInfo = info;
          best = e;
        }
      }
    }
  }
  return { edge: best, ...bestInfo };
}

function dijkstra(osm, start, goal) {
  if (start === goal) return { ids: [start], meters: 0 };
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const open = new Map([[start, 0]]);
  const done = new Set();
  let guard = 0;
  while (open.size && guard++ < 220000) {
    let cur = -1;
    let best = Infinity;
    for (const [id, d] of open) {
      if (d < best) {
        best = d;
        cur = id;
      }
    }
    if (cur === goal) {
      const ids = [cur];
      while (prev.has(ids[ids.length - 1])) ids.push(prev.get(ids[ids.length - 1]));
      return { ids: ids.reverse(), meters: best };
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

function orderedEdgeVisits(centerlinePixels, osm, streetIndex) {
  const visits = [];
  const byEdge = new Map();
  for (let i = 0; i < centerlinePixels.length; i++) {
    const px = centerlinePixels[i];
    const ll = fitPixelToLl(px);
    const hit = nearestStreetEdge(ll, osm.edges, streetIndex, 52);
    if (!hit.edge || hit.distance > 42) continue;
    const prev = visits[visits.length - 1];
    if (prev?.edge.index === hit.edge.index) {
      prev.samples.push({ i, t: hit.t, distance: hit.distance, px });
    } else {
      const visit = { edge: hit.edge, samples: [{ i, t: hit.t, distance: hit.distance, px }] };
      visits.push(visit);
      if (!byEdge.has(hit.edge.index)) byEdge.set(hit.edge.index, []);
      byEdge.get(hit.edge.index).push(visit);
    }
  }
  return visits.filter((v) => v.samples.length >= 1);
}

function visitDirection(visit) {
  const first = visit.samples[0].t;
  const last = visit.samples[visit.samples.length - 1].t;
  return first <= last
    ? { start: visit.edge.a, end: visit.edge.b }
    : { start: visit.edge.b, end: visit.edge.a };
}

function pushNode(routeIds, id) {
  if (routeIds[routeIds.length - 1] !== id) routeIds.push(id);
}

function buildRouteFromVisits(osm, visits) {
  const routeIds = [];
  const connectors = [];
  const traversedEdges = [];
  for (const [visitIndex, visit] of visits.entries()) {
    const dir = visitDirection(visit);
    if (!routeIds.length) {
      pushNode(routeIds, dir.start);
    } else {
      const current = routeIds[routeIds.length - 1];
      const options = [
        { ...dir, reversed: false },
        { start: dir.end, end: dir.start, reversed: true },
      ];
      let chosen = options[0];
      let connector = dijkstra(osm, current, chosen.start);
      let connectorDistance = connector?.meters ?? Infinity;
      const alt = dijkstra(osm, current, options[1].start);
      if ((alt?.meters ?? Infinity) < connectorDistance) {
        chosen = options[1];
        connector = alt;
        connectorDistance = alt?.meters ?? Infinity;
      }
      if (connector?.ids?.length) {
        for (const id of connector.ids.slice(1)) pushNode(routeIds, id);
      }
      connectors.push({
        visitIndex,
        from: current,
        to: chosen.start,
        meters: +connectorDistance.toFixed(1),
        insertedNodes: Math.max(0, (connector?.ids?.length ?? 0) - 2),
        reversed: chosen.reversed,
        edgeIndex: visit.edge.index,
        street: visit.edge.name,
      });
      pushNode(routeIds, chosen.start);
      pushNode(routeIds, chosen.end);
      traversedEdges.push(visit.edge.index);
      continue;
    }
    pushNode(routeIds, dir.start);
    pushNode(routeIds, dir.end);
    traversedEdges.push(visit.edge.index);
  }
  return {
    routeIds,
    connectors,
    traversedEdges,
    chain: routeIds.map((id) => osm.coord.get(id)).filter(Boolean),
  };
}

function routeLengthMeters(chain) {
  let total = 0;
  for (let i = 1; i < chain.length; i++) total += meters(chain[i - 1], chain[i]);
  return total;
}

function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-edge recovery" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

function pathD(points, project) {
  return points
    .map((p, i) => {
      const [x, y] = project(p);
      return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

async function renderBlind(chain, file) {
  const local = chain.map(llToLocal);
  const b = bounds(local);
  const pad = 230;
  const w = 1100;
  const h = 820;
  const view = {
    minX: b.minX - pad,
    maxX: b.maxX + pad,
    minY: b.minY - pad,
    maxY: b.maxY + pad,
  };
  const scale = Math.min(
    (w - 70) / (view.maxX - view.minX || 1),
    (h - 70) / (view.maxY - view.minY || 1),
  );
  const usedW = (view.maxX - view.minX) * scale;
  const usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const d = pathD(local, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="none" stroke="#df7d25" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function renderScreenshotOverlay(source, visits, routeMask, w, h, file) {
  const base = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.from(base.data);
  for (let i = 0; i < routeMask.length; i++) {
    if (!routeMask[i]) continue;
    const j = i * 4;
    rgba[j] = Math.round(rgba[j] * 0.35);
    rgba[j + 1] = Math.round(rgba[j + 1] * 0.35 + 70);
    rgba[j + 2] = Math.round(rgba[j + 2] * 0.35 + 190);
    rgba[j + 3] = 255;
  }
  const streetPaths = visits
    .map((v) => {
      const a = llToPixel(v.edge.ca);
      const b = llToPixel(v.edge.cb);
      return `<path d="M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}" stroke="#00e5ff" stroke-width="2.7" stroke-linecap="round"/>`;
    })
    .join("\n");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${streetPaths}</svg>`);
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .composite([{ input: svg, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const image = await sharp(sourceFile).raw().toBuffer({ resolveWithObject: true });
  const route = readRouteMask(image.data, image.info);
  const centerlinePixels = centerlineFromRouteMask(
    route.mask,
    route.bbox,
    image.info.width,
    image.info.height,
  );
  const osm = buildOsm(JSON.parse(await fs.readFile(osmFile, "utf8")));
  const streetIndex = buildStreetIndex(osm.edges);
  const visits = orderedEdgeVisits(centerlinePixels, osm, streetIndex);
  const uniqueEdges = new Set(visits.map((v) => v.edge.index));
  const recovered = buildRouteFromVisits(osm, visits);
  const lengthMeters = routeLengthMeters(recovered.chain);
  const connectorMeters = recovered.connectors.reduce((sum, c) => sum + c.meters, 0);
  const longConnectors = recovered.connectors.filter((c) => c.meters > 220);

  await fs.copyFile(sourceFile, path.join(outDir, "0-source-screenshot.jpg"));
  await renderScreenshotOverlay(
    sourceFile,
    visits,
    route.mask,
    image.info.width,
    image.info.height,
    path.join(outDir, "1-fragments-to-streets.png"),
  );
  await renderBlind(recovered.chain, path.join(outDir, "2-recovered-route-blind.png"));
  await fs.writeFile(path.join(outDir, "recovered-route.gpx"), gpx("sneaker-street-edge-recovery", recovered.chain));
  await fs.writeFile(
    path.join(outDir, "connector-table.json"),
    JSON.stringify(recovered.connectors, null, 2),
  );
  await fs.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(
      {
        status: longConnectors.length ? "needs_review" : "complete",
        source: path.relative(root, sourceFile),
        fit,
        orangeComponents: route.kept.length,
        orderedCenterlinePoints: centerlinePixels.length,
        orderedStreetVisits: visits.length,
        uniqueStreetEdges: uniqueEdges.size,
        routePoints: recovered.chain.length,
        routeKm: +(lengthMeters / 1000).toFixed(2),
        connectorKm: +(connectorMeters / 1000).toFixed(2),
        connectorCount: recovered.connectors.length,
        longConnectorCount: longConnectors.length,
        longConnectors: longConnectors.slice(0, 20),
        artifacts: {
          source: "0-source-screenshot.jpg",
          fragmentOverlay: "1-fragments-to-streets.png",
          blindRoute: "2-recovered-route-blind.png",
          gpx: "recovered-route.gpx",
          connectors: "connector-table.json",
        },
      },
      null,
      2,
    ),
  );
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
