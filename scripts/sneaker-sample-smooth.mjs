import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { prepareTracedBinaryComponents, centerlinePolylineFromPreparedBinary } = jiti("../lib/centerlineFromMask.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-sneaker-sample-smooth", new Date().toISOString().replace(/[:.]/g, "-"));
const idx = (x, y, w) => y * w + x;

function routePixel(r, g, b) {
  return r >= 138 && g >= 78 && g <= 190 && b >= 55 && b <= 178 && r - g >= 18 && g - b >= 4 && r - b >= 36;
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
function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
function simplify(points, minDist) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || dist(last, p) >= minDist) { out.push(p); last = p; }
  }
  const tail = points[points.length - 1];
  if (tail && out.length && dist(out[out.length - 1], tail) > 0.01) out.push(tail);
  return out;
}
function chaikin(points, passes) {
  let out = points.map((p) => p.slice());
  for (let pass = 0; pass < passes; pass++) {
    if (out.length < 3) return out;
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}
function routeD(points, project) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}
async function extractStrokes(gapClose) {
  const source = path.join(root, "sneaker.jpg");
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (routePixel(data[i], data[i + 1], data[i + 2])) mask[idx(x, y, info.width)] = 1;
  }
  const kept = components(mask, info.width, info.height)
    .filter((c) => ((c.bbox.minY + c.bbox.maxY) / 2) > info.height * 0.42 && c.count >= 45)
    .slice(0, 8);
  const all = kept.flatMap((c) => c.pixels), b = bounds(all), pad = 8;
  const crop = { minX: Math.max(0, b.minX - pad), minY: Math.max(0, b.minY - pad), maxX: Math.min(info.width - 1, b.maxX + pad), maxY: Math.min(info.height - 1, b.maxY + pad) };
  const cw = crop.maxX - crop.minX + 1, ch = crop.maxY - crop.minY + 1;
  const lineMask = new Uint8Array(cw * ch);
  for (const c of kept) for (const [x, y] of c.pixels) lineMask[idx(x - crop.minX, y - crop.minY, cw)] = 255;
  return prepareTracedBinaryComponents(lineMask, cw, ch, gapClose, 20)
    .map((comp) => centerlinePolylineFromPreparedBinary(comp, cw, ch))
    .filter((s) => s && s.length >= 3)
    .sort((a, b2) => b2.length - a.length)
    .slice(0, 8)
    .map((s) => simplify(s.map(([x, y]) => [x + crop.minX, y + crop.minY]), 2.2));
}
async function render(strokes, file, label, passes) {
  const smooth = strokes.map((s) => chaikin(s, passes));
  const all = smooth.flat(), b = bounds(all);
  const w = 900, h = 560, pad = 28;
  const scale = Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2) / (b.maxY - b.minY));
  const usedW = (b.maxX - b.minX) * scale, usedH = (b.maxY - b.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - b.minX) * scale, oy + (y - b.minY) * scale];
  const paths = smooth.map((s) => `<path d="${routeD(s, project)}" fill="none" stroke="#111" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${paths}<text x="18" y="34" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;
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
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const sheet = [], summary = [];
  for (const gap of [1, 2, 4, 6, 8]) {
    const strokes = await extractStrokes(gap);
    for (const passes of [0, 1, 2]) {
      const id = `gap${gap}-smooth${passes}`;
      const dir = path.join(outDir, id);
      await fs.mkdir(dir, { recursive: true });
      await render(strokes, path.join(dir, "trace.png"), id, passes);
      summary.push({ id, gap, passes, strokes: strokes.length, points: strokes.map((s) => s.length), image: path.relative(root, path.join(dir, "trace.png")).replace(/\\/g, "/") });
      sheet.push({ label: `${id} ${strokes.length} strokes`, file: path.join(dir, "trace.png") });
    }
  }
  await makeSheet(sheet, path.join(outDir, "smooth-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
