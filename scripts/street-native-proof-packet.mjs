import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-street-native-proof", stamp);

const cases = [
  {
    id: "love",
    title: "LOVE wordmark",
    reference: "LOVE.png",
    current: "tmp-wordmark/dt-LOVE/3-map.png",
    gpx: "tmp-wordmark/dt-LOVE/LOVE.gpx",
    verify: "tmp-wordmark/dt-LOVE/verify.json",
    status: "existing street-native proof",
    routeIdea:
      "Downtown fine-grid letter grammar: draw L/O/V/E as strokes on the street lattice instead of tracing the filled word outline.",
    next:
      "Generalize the wordmark grammar: extract letters, choose a fine-grid neighborhood, compile strokes, then blind-judge legibility.",
  },
  {
    id: "heart",
    title: "Heart",
    reference: "HEART.webp",
    current: "tmp-fill-designs/heart/3-map.png",
    gpx: "tmp-fill-designs/heart/HEART.gpx",
    meta: "tmp-fill-designs/heart/meta.json",
    status: "existing street-native proof, long-run scale",
    routeIdea:
      "Shape-first city template: lobes and point are laid out as large city-scale strokes, then compiled to the lattice.",
    next:
      "Add a runner-distance variant selector so the same grammar can target 8-15 km instead of only large statement routes.",
  },
  {
    id: "lion",
    title: "Lion",
    reference: "lion.webp",
    current: "tmp-interp-designs/lion/3-map.png",
    gpx: "tmp-interp-designs/lion/LION.gpx",
    meta: "tmp-interp-designs/lion/meta.json",
    verify: "tmp-interp-designs/lion/verify.json",
    status: "existing interpretation proof",
    routeIdea:
      "Semantic sketch first: preserve large animal silhouette and signature parts, then compile the simplified drawing to streets.",
    next:
      "Promote this to a candidate family: body arc, head/mane mass, tail/leg cues, with multiple city placements.",
  },
  {
    id: "unicorn",
    title: "Unicorn",
    reference: "unicorn.jpg",
    current: "tmp-trace/unicorn/map-clean.png",
    gpx: "tmp-trace/unicorn/unicorn.gpx",
    verify: "tmp-trace/unicorn/verify.json",
    status: "existing trace proof, not enough street-native design yet",
    routeIdea:
      "Currently more trace-derived than map-native. The proper grammar is horse body plus horn plus mane/tail cues.",
    next:
      "Use this as the first failure-to-success case for animal grammar: do not optimize the trace; generate new city-native animals.",
  },
  {
    id: "sneaker",
    title: "Sneaker",
    reference: "sneaker.jpg",
    status: "needs street-native generator",
    routeIdea:
      "Sole as a long corridor, toe as a rounded block loop, heel as a vertical block, laces as short cross-street bars.",
    next:
      "Build a sneaker primitive family and generate 20-50 candidate placements before any app integration.",
  },
  {
    id: "witch",
    title: "Witch",
    reference: "witch.jpg",
    status: "needs street-native generator",
    routeIdea:
      "Hat triangle and brim must dominate; face/body/broom are optional cues if the streets support them.",
    next:
      "Treat as a hierarchy: first make the hat readable, then add one secondary cue without clutter.",
  },
  {
    id: "several",
    title: "Several examples sheet",
    reference: "several.png",
    status: "acceptance target sheet",
    routeIdea:
      "Use as a visual bar for the city-native atlas: many different objects can be made if the route is designed from map primitives.",
    next:
      "Split into individual targets later; for now it is the comparison sheet for quality expectations.",
  },
];

async function exists(rel) {
  if (!rel) return false;
  try {
    await fs.access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function readJson(rel) {
  if (!(await exists(rel))) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(root, rel), "utf8"));
  } catch {
    return null;
  }
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function copyAsset(rel, prefix) {
  if (!(await exists(rel))) return null;
  const ext = path.extname(rel);
  const safeName = `${prefix}${ext}`;
  await fs.copyFile(path.join(root, rel), path.join(outDir, safeName));
  return safeName;
}

function metricText(c) {
  const m = c.verify ?? c.meta;
  if (!m) return "No route metrics yet.";
  const parts = [];
  if (typeof m.mapboxKm === "number") parts.push(`${m.mapboxKm.toFixed(1)} km Mapbox`);
  if (typeof m.chainKm === "number") parts.push(`${m.chainKm.toFixed(1)} km chain`);
  if (typeof m.km === "number") parts.push(`${m.km.toFixed(1)} km compiled`);
  if (typeof m.meanDev === "number") parts.push(`${Math.round(m.meanDev)} m mean deviation`);
  if (typeof m.legFailures !== "undefined") {
    parts.push(`${Array.isArray(m.legFailures) ? m.legFailures.length : m.legFailures} leg failures`);
  }
  return parts.length ? parts.join(" · ") : "Metrics present, no standard fields.";
}

async function makeTile(caseInfo) {
  const width = 1000;
  const panelW = 500;
  const imageH = 360;
  const textH = 210;
  const height = imageH + textH;
  const bg = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#f8f5ef",
    },
  })
    .png()
    .toBuffer();

  const composites = [];
  for (const [side, rel] of [
    ["reference", caseInfo.reference],
    ["route", caseInfo.current],
  ]) {
    if (!rel || !(await exists(rel))) continue;
    const input = await sharp(path.join(root, rel))
      .resize(panelW, imageH, { fit: "contain", background: "#ffffff" })
      .png()
      .toBuffer();
    composites.push({
      input,
      left: side === "reference" ? 0 : panelW,
      top: 0,
    });
  }

  const textSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${textH}">
      <rect width="${width}" height="${textH}" fill="#ffffff"/>
      <text x="24" y="34" font-family="Arial" font-size="24" font-weight="700" fill="#111">${esc(caseInfo.title)}</text>
      <text x="24" y="64" font-family="Arial" font-size="15" font-weight="700" fill="#9a6a00">${esc(caseInfo.status)}</text>
      <text x="24" y="94" font-family="Arial" font-size="14" fill="#333">${esc(metricText(caseInfo))}</text>
      <text x="24" y="126" font-family="Arial" font-size="14" fill="#111">${esc(caseInfo.routeIdea).slice(0, 132)}</text>
      <text x="24" y="156" font-family="Arial" font-size="14" fill="#444">${esc(caseInfo.next).slice(0, 132)}</text>
      <text x="24" y="190" font-family="Arial" font-size="12" fill="#777">left: source/reference · right: current best generated route map, if present</text>
    </svg>
  `);
  composites.push({ input: textSvg, left: 0, top: imageH });

  return sharp(bg).composite(composites).png().toBuffer();
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const enriched = [];
  for (const c of cases) {
    const entry = {
      ...c,
      hasReference: await exists(c.reference),
      hasCurrentRoute: await exists(c.current),
      hasGpx: await exists(c.gpx),
      verify: await readJson(c.verify),
      meta: await readJson(c.meta),
    };
    entry.referenceCopy = await copyAsset(c.reference, `${c.id}-reference`);
    entry.routeCopy = await copyAsset(c.current, `${c.id}-route`);
    entry.gpxCopy = await copyAsset(c.gpx, `${c.id}`);
    enriched.push(entry);
  }

  const tiles = [];
  for (const c of enriched) {
    tiles.push(await makeTile(c));
  }
  const tileW = 1000;
  const tileH = 570;
  const sheetW = tileW;
  const sheetH = tileH * tiles.length;
  await sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: "#f8f5ef",
    },
  })
    .composite(tiles.map((input, i) => ({ input, left: 0, top: i * tileH })))
    .png()
    .toFile(path.join(outDir, "proof-sheet.png"));

  const rows = enriched
    .map(
      (c) => `
        <section>
          <h2>${esc(c.title)}</h2>
          <p><strong>Status:</strong> ${esc(c.status)}</p>
          <p><strong>Route idea:</strong> ${esc(c.routeIdea)}</p>
          <p><strong>Next:</strong> ${esc(c.next)}</p>
          <p><strong>Metrics:</strong> ${esc(metricText(c))}</p>
          <div class="pair">
            ${c.referenceCopy ? `<figure><img src="${esc(c.referenceCopy)}"><figcaption>reference</figcaption></figure>` : ""}
            ${c.routeCopy ? `<figure><img src="${esc(c.routeCopy)}"><figcaption>current route</figcaption></figure>` : `<div class="missing">No generated route yet</div>`}
          </div>
          ${c.gpxCopy ? `<p><a href="${esc(c.gpxCopy)}">GPX</a></p>` : ""}
        </section>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Street-native proof packet</title>
  <style>
    body { margin: 0; padding: 32px; font-family: Arial, sans-serif; background: #f8f5ef; color: #171717; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .intro { max-width: 880px; color: #444; line-height: 1.45; }
    section { margin-top: 28px; padding-top: 24px; border-top: 1px solid #d8d0c3; }
    h2 { margin: 0 0 8px; font-size: 22px; }
    p { max-width: 980px; line-height: 1.45; }
    .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
    figure { margin: 0; background: white; border: 1px solid #ddd4c7; padding: 12px; }
    img { display: block; width: 100%; max-height: 620px; object-fit: contain; background: white; }
    figcaption, .missing { margin-top: 8px; color: #666; font-size: 13px; }
    .missing { min-height: 220px; display: grid; place-items: center; background: #fff; border: 1px dashed #c5bcad; }
  </style>
</head>
<body>
  <h1>Street-native proof packet</h1>
  <p class="intro">This packet separates the proven cases from the missing generator work. The target is not trace quality; it is whether a route designed from city-street primitives can read like the source image.</p>
  <p><a href="proof-sheet.png">Open proof sheet PNG</a></p>
  ${rows}
</body>
</html>`;

  await fs.writeFile(path.join(outDir, "index.html"), html, "utf8");
  await fs.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        cases: enriched.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          hasReference: c.hasReference,
          hasCurrentRoute: c.hasCurrentRoute,
          hasGpx: c.hasGpx,
          metrics: c.verify ?? c.meta ?? null,
          routeIdea: c.routeIdea,
          next: c.next,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(path.relative(root, outDir));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
