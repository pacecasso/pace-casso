import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);

const { prepareTracedBinaryComponents, centerlinePolylineFromPreparedBinary } = jiti("../lib/centerlineFromMask.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-sneaker-gap6-order");
const source = process.argv[2] ?? path.join(root, "tmp-sneaker-screenshot-fit", "2026-07-17T12-19-00-708Z", "0-reference-sneaker.jpg");

function idx(x, y, w) { return y * w + x; }
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function isRoutePixel(r, g, b, y) {
  return y >= 190 && y <= 455 && r >= 125 && g >= 60 && b <= 135 && r - g >= 24 && g - b >= -5;
}
function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function normalize(points, pad = 26, width = 360, height = 222) {
  const b = bounds(points);
  const s = Math.min((width - pad * 2) / Math.max(1, b.maxX - b.minX), (height - pad * 2) / Math.max(1, b.maxY - b.minY));
  const usedW = (b.maxX - b.minX) * s;
  const usedH = (b.maxY - b.minY) * s;
  const ox = (width - usedW) / 2 - b.minX * s;
  const oy = (height - usedH) / 2 - b.minY * s;
  return points.map(([x, y]) => [x * s + ox, y * s + oy]);
}
function dAttr(points) {
  return points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
}
function orient(polyline, flip) { return flip ? [...polyline].reverse() : [...polyline]; }
function assemble(polylines, order, flips) {
  const parts = order.map((id, i) => ({ id, points: orient(polylines[id], flips[i]) }));
  const connectors = [];
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i - 1].points[parts[i - 1].points.length - 1];
    const b = parts[i].points[0];
    connectors.push({ a, b, d: dist(a, b), from: parts[i - 1].id, to: parts[i].id });
  }
  const points = parts.flatMap((p) => p.points);
  return { parts, connectors, points };
}
function scoreConnectors(connectors) {
  return connectors.reduce((sum, c) => {
    const dx = Math.abs(c.a[0] - c.b[0]);
    const dy = Math.abs(c.a[1] - c.b[1]);
    const diag = dx > 28 && dy > 28 ? 1.7 : 1;
    const long = c.d > 90 ? 2.4 : c.d > 55 ? 1.5 : 1;
    return sum + c.d * diag * long;
  }, 0);
}
function* permutations(items) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    for (const rest of permutations(items.slice(0, i).concat(items.slice(i + 1)))) yield [items[i], ...rest];
  }
}
function* flipMasks(n) {
  for (let mask = 0; mask < (1 << n); mask++) {
    yield Array.from({ length: n }, (_, i) => Boolean(mask & (1 << i)));
  }
}
async function renderSheet(candidates, file) {
  const tileW = 390, tileH = 292, cols = 4;
  const rows = Math.ceil(candidates.length / cols);
  const width = cols * tileW, height = rows * tileH;
  const tiles = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const tx = (i % cols) * tileW, ty = Math.floor(i / cols) * tileH;
    const finite = c.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const normAll = normalize(finite);
    const byPart = new Map();
    let cursor = 0;
    for (const part of c.parts) {
      byPart.set(part.id, normAll.slice(cursor, cursor + part.points.length));
      cursor += part.points.length;
    }
    const connectorLines = [];
    for (let j = 1; j < c.parts.length; j++) {
      const prev = byPart.get(c.parts[j - 1].id);
      const cur = byPart.get(c.parts[j].id);
      if (!prev?.length || !cur?.length) continue;
      const a = prev[prev.length - 1], b = cur[0];
      connectorLines.push(`<path d="M ${a[0].toFixed(2)} ${a[1].toFixed(2)} L ${b[0].toFixed(2)} ${b[1].toFixed(2)}" stroke="#d12d2d" stroke-width="2.4" stroke-dasharray="6 5" fill="none" opacity="0.58"/>`);
    }
    const strokes = c.parts.map((part) => {
      const d = dAttr(byPart.get(part.id) ?? []);
      return d ? `<path d="${d}" stroke="#101010" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` : "";
    }).join("\n");
    tiles.push(`<g transform="translate(${tx},${ty})"><rect x="0" y="0" width="${tileW}" height="${tileH}" fill="#fff"/><rect x="14" y="14" width="362" height="224" fill="#fafafa" stroke="#ddd"/><g transform="translate(15,15)">${connectorLines.join("\n")}${strokes}</g><text x="18" y="262" font-size="15" font-family="Arial" fill="#111">${esc(c.label)}</text><text x="18" y="282" font-size="12" font-family="Arial" fill="#555">score ${c.score.toFixed(1)} | gaps ${c.connectors.map((g) => Math.round(g.d)).join(",")}</text></g>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${tiles.join("\n")}</svg>`;
  await fs.writeFile(file.replace(/\.png$/, ".svg"), svg);
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const fullMask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (isRoutePixel(data[i], data[i + 1], data[i + 2], y)) fullMask[idx(x, y, info.width)] = 1;
    }
  }
  const routePixels = [];
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (fullMask[idx(x, y, info.width)]) routePixels.push([x, y]);
  const b = bounds(routePixels), pad = 8;
  const cw = b.maxX - b.minX + 1 + pad * 2, ch = b.maxY - b.minY + 1 + pad * 2;
  const lineMask = new Uint8Array(cw * ch);
  for (const [x, y] of routePixels) lineMask[idx(x - b.minX + pad, y - b.minY + pad, cw)] = 255;

  const masks = prepareTracedBinaryComponents(lineMask, cw, ch, 6, 20);
  const polylines = masks.map((comp) => centerlinePolylineFromPreparedBinary(comp, cw, ch)).filter((p) => p.length >= 2);
  const ids = polylines.map((_, i) => i);
  const all = [];
  for (const order of permutations(ids)) {
    for (const flips of flipMasks(order.length)) {
      const c = assemble(polylines, order, flips);
      c.order = order; c.flips = flips; c.score = scoreConnectors(c.connectors);
      c.label = order.map((id, i) => `${flips[i] ? "-" : "+"}${id}`).join(" ");
      all.push(c);
    }
  }
  all.sort((a, b) => a.score - b.score);
  const handOrders = [[1,4,0,3,2,5],[5,2,3,0,4,1],[1,5,2,3,0,4],[4,0,3,2,5,1],[1,4,0,2,3,5],[5,1,4,0,3,2],[1,2,3,0,4,5],[4,1,5,2,3,0],[1,4,0,3,2],[1,4,0,3,2,5]];
  const hand = [];
  for (const order of handOrders) hand.push(...all.filter((c) => c.order.join(",") === order.join(",")).slice(0, 4));
  await renderSheet(all.slice(0, 32), path.join(outDir, "top-shortest-connectors.png"));
  await renderSheet(hand, path.join(outDir, "hand-logical-orders.png"));
  await fs.writeFile(path.join(outDir, "components.json"), JSON.stringify(polylines.map((p, id) => ({ id, points: p.length, start: p[0], end: p[p.length - 1], bounds: bounds(p) })), null, 2));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ source: path.relative(root, source), componentCount: polylines.length, top: all.slice(0, 12).map((c) => ({ label: c.label, score: c.score, gaps: c.connectors.map((g) => Math.round(g.d)) })) }, null, 2));
  console.log(JSON.stringify({ outDir, componentCount: polylines.length }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
