import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-sample-study", stamp);

const samples = [
  { id: "heart", file: "HEART.webp", kind: "single-route" },
  { id: "lion", file: "lion.webp", kind: "single-route" },
  { id: "love", file: "LOVE.png", kind: "wordmark" },
  { id: "tiger", file: "TIGER.webp", kind: "single-route" },
  { id: "unicorn", file: "unicorn.jpg", kind: "strava-single-route" },
  { id: "witch", file: "witch.jpg", kind: "strava-single-route" },
  { id: "sneaker", file: "sneaker.jpg", kind: "strava-single-route" },
  { id: "several", file: "several.png", kind: "collage" },
];

const idx = (x, y, w) => y * w + x;

function routePixel(r, g, b) {
  const red = r >= 145 && r - g >= 38 && r - b >= 30;
  const brightOrange = r >= 185 && g >= 50 && g <= 165 && b <= 135 && r - g >= 34;
  const compressedStravaOrange = r >= 138 && g >= 78 && g <= 190 && b >= 55 && b <= 178 && r - g >= 18 && g - b >= 4 && r - b >= 36;
  const magentaRed = r >= 150 && g <= 95 && b <= 150 && r > b + 8;
  return red || brightOrange || compressedStravaOrange || magentaRed;
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

function connectedComponents(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const components = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = idx(x, y, w);
      if (!mask[start] || seen[start]) continue;
      const stack = [[x, y]];
      const pixels = [];
      seen[start] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        pixels.push([cx, cy]);
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
          const ni = idx(nx, ny, w);
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      components.push({
        pixels,
        count: pixels.length,
        bbox: { minX, minY, maxX, maxY },
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      });
    }
  }
  return components.sort((a, b) => b.count - a.count);
}

function chooseRouteComponents(components, w, h, kind) {
  const minArea = kind === "collage" ? 80 : 35;
  const minSpan = kind === "collage" ? 18 : 10;
  const usable = components.filter((c) => {
    if (c.count < minArea) return false;
    if (Math.max(c.width, c.height) < minSpan) return false;
    const yCenter = (c.bbox.minY + c.bbox.maxY) / 2;
    const xCenter = (c.bbox.minX + c.bbox.maxX) / 2;
    const topUi = yCenter < h * 0.16 && c.height < h * 0.09;
    const bottomUi = yCenter > h * 0.91 && c.height < h * 0.06;
    const sideUi = (xCenter < w * 0.08 || xCenter > w * 0.92) && c.count < 900;
    return !(topUi || bottomUi || sideUi);
  });

  if (kind === "collage") return usable.slice(0, 60);
  if (kind === "wordmark") return usable.slice(0, 24);

  const biggest = usable[0];
  if (!biggest) return [];
  const threshold = Math.max(40, biggest.count * 0.045);
  return usable.filter((c) => c.count >= threshold).slice(0, 18);
}

function maskFromComponents(components, w, h) {
  const out = new Uint8Array(w * h);
  for (const comp of components) {
    for (const [x, y] of comp.pixels) out[idx(x, y, w)] = 1;
  }
  return out;
}

function metricsFromComponents(components, w, h) {
  if (!components.length) {
    return {
      componentCount: 0,
      routePixels: 0,
      bbox: null,
      coveragePct: 0,
      bboxAspect: null,
      densityInBbox: 0,
    };
  }
  let minX = w, minY = h, maxX = 0, maxY = 0, routePixels = 0;
  for (const c of components) {
    routePixels += c.count;
    minX = Math.min(minX, c.bbox.minX);
    minY = Math.min(minY, c.bbox.minY);
    maxX = Math.max(maxX, c.bbox.maxX);
    maxY = Math.max(maxY, c.bbox.maxY);
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  return {
    componentCount: components.length,
    routePixels,
    bbox: { minX, minY, maxX, maxY, width: bw, height: bh },
    coveragePct: +(routePixels / (w * h) * 100).toFixed(3),
    bboxAspect: +(bw / Math.max(1, bh)).toFixed(3),
    densityInBbox: +(routePixels / Math.max(1, bw * bh)).toFixed(3),
  };
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

async function renderTrace(mask, w, h, file) {
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const j = i * 4;
    rgba[j] = 13;
    rgba[j + 1] = 13;
    rgba[j + 2] = 13;
  }
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .resize({ width: 900, withoutEnlargement: true, kernel: "nearest" })
    .png()
    .toFile(file);
}

async function renderOverlay(sourceFile, mask, w, h, file) {
  const resized = await sharp(sourceFile)
    .resize({ width: w, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (resized.info.width !== w || resized.info.height !== h) {
    throw new Error(`Overlay source/mask mismatch: source ${resized.info.width}x${resized.info.height}, mask ${w}x${h}`);
  }
  const rgba = Buffer.from(resized.data);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const j = i * 4;
    rgba[j] = Math.round(rgba[j] * 0.18 + 0 * 0.82);
    rgba[j + 1] = Math.round(rgba[j + 1] * 0.18 + 210 * 0.82);
    rgba[j + 2] = Math.round(rgba[j + 2] * 0.18 + 255 * 0.82);
    rgba[j + 3] = 255;
  }
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .resize({ width: 900, withoutEnlargement: true })
    .png()
    .toFile(file);
}

async function makeTile(sample, files, metrics) {
  const w = 760;
  const h = 570;
  const thumbW = 360;
  const thumbH = 360;
  async function thumbnail(file, background) {
    const resized = await sharp(file)
      .resize({ width: thumbW, height: thumbH, fit: "inside" })
      .png()
      .toBuffer({ resolveWithObject: true });
    const left = Math.round((thumbW - resized.info.width) / 2);
    const top = Math.round((thumbH - resized.info.height) / 2);
    return sharp({
      create: {
        width: thumbW,
        height: thumbH,
        channels: 4,
        background,
      },
    })
      .composite([{ input: resized.data, left, top }])
      .png()
      .toBuffer();
  }
  const source = await thumbnail(files.source, "#f5f2ea");
  const trace = await thumbnail(files.trace, "#ffffff");
  const label = [
    `<text x="28" y="420" font-size="28" font-weight="700" fill="#121212">${sample.id}</text>`,
    `<text x="28" y="456" font-size="18" fill="#333">components: ${metrics.componentCount}</text>`,
    `<text x="28" y="482" font-size="18" fill="#333">route pixels: ${metrics.routePixels}</text>`,
    `<text x="28" y="508" font-size="18" fill="#333">bbox aspect: ${metrics.bboxAspect ?? "n/a"}</text>`,
    `<text x="28" y="534" font-size="18" fill="#333">${sample.kind}</text>`,
  ].join("");
  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="100%" height="100%" fill="#f7f4ee"/>
      <rect x="20" y="20" width="${thumbW}" height="${thumbH}" fill="#fff"/>
      <rect x="400" y="20" width="${thumbW}" height="${thumbH}" fill="#fff"/>
      <text x="20" y="18" font-size="14" fill="#666">reference</text>
      <text x="400" y="18" font-size="14" fill="#666">extracted route ink</text>
      ${label}
    </svg>`
  );
  return sharp(base)
    .composite([
      { input: source, left: 20, top: 20 },
      { input: trace, left: 400, top: 20 },
    ])
    .png()
    .toBuffer();
}

async function makeContactSheet(tiles, file) {
  const cols = 2;
  const tileW = 760;
  const tileH = 570;
  const rows = Math.ceil(tiles.length / cols);
  const composites = tiles.map((input, i) => ({
    input,
    left: (i % cols) * tileW,
    top: Math.floor(i / cols) * tileH,
  }));
  await sharp({
    create: {
      width: cols * tileW,
      height: rows * tileH,
      channels: 4,
      background: "#ece7dd",
    },
  })
    .composite(composites)
    .png()
    .toFile(file);
}

async function processSample(sample) {
  const sourceFile = path.join(root, sample.file);
  const dir = path.join(outDir, sample.id);
  await fs.mkdir(dir, { recursive: true });
  const sourceOut = path.join(dir, `source${path.extname(sample.file).toLowerCase()}`);
  await fs.copyFile(sourceFile, sourceOut);

  const resized = sharp(sourceFile).resize({ width: 1000, withoutEnlargement: true });
  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (routePixel(r, g, b)) mask[idx(x, y, info.width)] = 1;
    }
  }

  const components = connectedComponents(mask, info.width, info.height);
  const kept = chooseRouteComponents(components, info.width, info.height, sample.kind);
  const routeMask = maskFromComponents(kept, info.width, info.height);
  const metrics = {
    id: sample.id,
    file: sample.file,
    kind: sample.kind,
    sourceWidth: info.width,
    sourceHeight: info.height,
    rawComponentCount: components.length,
    rawTopComponents: components.slice(0, 12).map((c) => ({
      count: c.count,
      width: c.width,
      height: c.height,
      bbox: c.bbox,
    })),
    ...metricsFromComponents(kept, info.width, info.height),
  };

  const files = {
    source: sourceFile,
    mask: path.join(dir, "mask.png"),
    trace: path.join(dir, "trace.png"),
    overlay: path.join(dir, "overlay.png"),
    metrics: path.join(dir, "metrics.json"),
  };
  await renderMask(routeMask, info.width, info.height, files.mask);
  await renderTrace(routeMask, info.width, info.height, files.trace);
  await renderOverlay(sourceFile, routeMask, info.width, info.height, files.overlay);
  await fs.writeFile(files.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
  const tile = await makeTile(sample, files, metrics);
  return { sample, metrics, files, tile };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const results = [];
  for (const sample of samples) {
    results.push(await processSample(sample));
  }
  await makeContactSheet(results.map((r) => r.tile), path.join(outDir, "extraction-sheet.png"));
  await fs.writeFile(
    path.join(outDir, "summary.json"),
    `${JSON.stringify(results.map(({ sample, metrics, files }) => ({
      id: sample.id,
      kind: sample.kind,
      metrics,
      trace: path.relative(root, files.trace).replace(/\\/g, "/"),
      overlay: path.relative(root, files.overlay).replace(/\\/g, "/"),
    })), null, 2)}\n`
  );
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
