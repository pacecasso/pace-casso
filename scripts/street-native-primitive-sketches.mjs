import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);

const {
  buildLatticeGraph,
  compileContourToLattice,
} = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-street-native-proof", `primitive-${stamp}`);

// Chelsea / downtown-ish frame, aligned to Manhattan's grid bearings.
const origin = [40.744061, -74.006811];
const X = {
  e: Math.sin((119 * Math.PI) / 180),
  n: Math.cos((119 * Math.PI) / 180),
};
const Y = {
  e: Math.sin((29 * Math.PI) / 180),
  n: Math.cos((29 * Math.PI) / 180),
};
const M_PER_LAT = 111320;

function toLatLng([x, y]) {
  const e = x * X.e + y * Y.e;
  const n = x * X.n + y * Y.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}

function toLocal([lat, lng]) {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}

function densify(points, maxStep = 90) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    out.push(a);
    const b = points[i + 1];
    if (!b) continue;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(d / maxStep));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function sneakerSketch() {
  // One continuous line: sole/body silhouette first, then lace bars. It is
  // intentionally shoe-like, not a literal sneaker trace.
  return densify([
    [0, 260],
    [0, 760],
    [260, 920],
    [720, 920],
    [1200, 780],
    [1680, 560],
    [1840, 360],
    [1720, 220],
    [980, 120],
    [180, 130],
    [0, 260],
    [360, 710],
    [780, 360],
    [560, 760],
    [980, 390],
    [770, 790],
    [1210, 450],
    [1030, 760],
    [1450, 520],
  ]);
}

function witchSketch() {
  // Hat-first hierarchy: if the city only preserves one thing, it should be
  // the wide brim + triangular hat. Face and broom are secondary cues.
  return densify([
    [0, 760],
    [1120, 760],
    [760, 720],
    [530, 0],
    [310, 720],
    [0, 760],
    [240, 850],
    [820, 850],
    [910, 1030],
    [760, 1210],
    [450, 1240],
    [300, 1050],
    [240, 850],
    [760, 1120],
    [1320, 1260],
    [1500, 1160],
    [1320, 1260],
    [1520, 1340],
  ]);
}

const sketches = [
  {
    id: "sneaker",
    title: "Sneaker primitive",
    reference: "sneaker.jpg",
    points: sneakerSketch(),
    compile: { sampleMeters: 36, pinRadiusMeters: 130, maxLegDetourRatio: 2.2 },
    intent:
      "Long sole corridor, rounded toe, block heel, and cross-street lace bars.",
  },
  {
    id: "witch",
    title: "Witch primitive",
    reference: "witch.jpg",
    points: witchSketch(),
    compile: { sampleMeters: 36, pinRadiusMeters: 135, maxLegDetourRatio: 2.3 },
    intent:
      "Dominant brim and hat triangle first; face and broom are secondary cues.",
  },
];

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

function svgPath(points, b, w, h, pad = 40) {
  const sx = (w - pad * 2) / Math.max(1, b.maxX - b.minX);
  const sy = (h - pad * 2) / Math.max(1, b.maxY - b.minY);
  const s = Math.min(sx, sy);
  const usedW = (b.maxX - b.minX) * s;
  const usedH = (b.maxY - b.minY) * s;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  return points
    .map(([x, y], i) => {
      const px = ox + (x - b.minX) * s;
      const py = oy + (b.maxY - y) * s;
      return `${i === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");
}

async function renderLine(points, file, title, subtitle) {
  const w = 900;
  const h = 620;
  const b = bounds(points);
  const d = svgPath(points, b, w, h - 90);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#fff"/>
    <rect x="0" y="0" width="${w}" height="${h - 90}" fill="#fafafa"/>
    <path d="${d}" fill="none" stroke="#e11d48" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="24" y="${h - 52}" font-family="Arial" font-size="24" font-weight="700" fill="#111">${title}</text>
    <text x="24" y="${h - 24}" font-family="Arial" font-size="15" fill="#555">${subtitle}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}


async function renderLatticeMap(chain, graph, file, title, subtitle) {
  const w = 900;
  const h = 620;
  const localChain = chain.map(toLocal);
  const b = bounds(localChain);
  const pad = 44;
  const sx = (w - pad * 2) / Math.max(1, b.maxX - b.minX);
  const sy = (h - 112 - pad) / Math.max(1, b.maxY - b.minY);
  const s = Math.min(sx, sy);
  const usedW = (b.maxX - b.minX) * s;
  const usedH = (b.maxY - b.minY) * s;
  const ox = (w - usedW) / 2;
  const oy = (h - 92 - usedH) / 2;
  const project = ([x, y]) => [
    ox + (x - b.minX) * s,
    oy + (b.maxY - y) * s,
  ];
  const marginM = 520;
  const streetRows = [];
  const seen = new Set();
  for (const [from, entries] of graph.adj.entries()) {
    for (const entry of entries) {
      const key = from < entry.to ? `${from}:${entry.to}` : `${entry.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [graph.nodes[from], ...entry.via, graph.nodes[entry.to]].map(toLocal);
      if (
        pts.every(
          ([x, y]) =>
            x < b.minX - marginM ||
            x > b.maxX + marginM ||
            y < b.minY - marginM ||
            y > b.maxY + marginM,
        )
      ) {
        continue;
      }
      streetRows.push(`<polyline points="${pts
        .map((p) => project(p).map((v) => v.toFixed(1)).join(","))
        .join(" ")}" fill="none" stroke="#e5e7eb" stroke-width="1"/>`);
    }
  }
  const streetLines = streetRows.join("\n");
  const route = localChain
    .map((p) => project(p).map((v) => v.toFixed(1)).join(","))
    .join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#fff"/>
    <rect x="0" y="0" width="${w}" height="${h - 90}" fill="#fbfbf8"/>
    ${streetLines}
    <polyline points="${route}" fill="none" stroke="#e11d48" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="24" y="${h - 52}" font-family="Arial" font-size="24" font-weight="700" fill="#111">${title}</text>
    <text x="24" y="${h - 24}" font-family="Arial" font-size="15" fill="#555">${subtitle}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso street-native primitive" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name}</name><trkseg>
${chain.map(([lat, lng]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>
`;
}

async function copyIfExists(rel, dest) {
  try {
    await fs.copyFile(path.join(root, rel), dest);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const latticeData = JSON.parse(
    await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8"),
  );
  const graph = buildLatticeGraph(latticeData);
  const summary = [];

  for (const sketch of sketches) {
    const dir = path.join(outDir, sketch.id);
    await fs.mkdir(dir, { recursive: true });
    await copyIfExists(sketch.reference, path.join(dir, "0-reference" + path.extname(sketch.reference)));

    await renderLine(
      sketch.points,
      path.join(dir, "1-street-native-sketch.png"),
      sketch.title,
      sketch.intent,
    );

    const placed = sketch.points.map(toLatLng);
    const result = compileContourToLattice(placed, graph, sketch.compile);
    if (!result) {
      summary.push({ id: sketch.id, ok: false, reason: "compile failed" });
      continue;
    }

    const localChain = result.chain.map(toLocal);
    await renderLine(
      localChain,
      path.join(dir, "2-compiled-lattice-route.png"),
      `${sketch.title} compiled`,
      `${result.km.toFixed(1)} km · mean deviation ${Math.round(result.meanDeviationMeters)} m · skipped pins ${result.skippedPins}`,
    );
    await renderLatticeMap(
      result.chain,
      graph,
      path.join(dir, "3-lattice-street-map.png"),
      `${sketch.title} street-lattice map`,
      `${result.km.toFixed(1)} km � ${result.legCount} legs � 0 external map tiles`,
    );
    await fs.writeFile(path.join(dir, `${sketch.id}.gpx`), gpx(sketch.title, result.chain), "utf8");
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2), "utf8");
    summary.push({
      id: sketch.id,
      ok: true,
      km: Number(result.km.toFixed(2)),
      inputKm: Number(result.inputKm.toFixed(2)),
      meanDeviationMeters: Number(result.meanDeviationMeters.toFixed(1)),
      maxDeviationMeters: Number(result.maxDeviationMeters.toFixed(1)),
      legCount: result.legCount,
      skippedPins: result.skippedPins,
      intent: sketch.intent,
    });
  }

  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(path.relative(root, outDir));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
