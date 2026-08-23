/**
 * Hand-curated Manhattan grid gas logo route (pump + hose + headphone person).
 * The grid polyline IS the run — no Mapbox snap. Same approach as runnable-smiley.
 *
 * Run: node scripts/render-gas-logo-route.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outDir = path.join(process.cwd(), "tmp-gas-logo-run");
await fs.mkdir(outDir, { recursive: true });

const width = 1440;
const height = 950;
const tileSize = 256;
/** East Village — regular walkable grid, away from rivers. */
const center = [40.7302, -73.9885];

const xStepMeters = 248;
const yStepMeters = 72;
const streetBearingDeg = 107;
const avenueBearingDeg = 17;

function bearingUnitVector(deg) {
  const rad = (deg * Math.PI) / 180;
  return { east: Math.sin(rad), north: Math.cos(rad) };
}

function offsetLatLngMeters([lat, lon], east, north) {
  const metersPerLat = 111_320;
  const metersPerLon = metersPerLat * Math.cos((lat * Math.PI) / 180);
  return [lat + north / metersPerLat, lon + east / metersPerLon];
}

const xAxis = bearingUnitVector(streetBearingDeg);
const yAxis = bearingUnitVector(avenueBearingDeg);

function gridPoint(x, y) {
  const east = x * xStepMeters * xAxis.east + y * yStepMeters * yAxis.east;
  const north = x * xStepMeters * xAxis.north + y * yStepMeters * yAxis.north;
  return offsetLatLngMeters(center, east, north);
}

function poly(points) {
  return points.map(([x, y]) => gridPoint(x, y));
}

/**
 * Etch-a-sketch gas mark in grid units (x = east, y = north).
 * Left: pump + display. Middle: hose loop. Right: headphone person + raised nozzle.
 */
const artStrokes = [
  {
    name: "gas logo",
    color: "#21b45d",
    points: poly([
      // 1. Person: raised nozzle arm
      [3.15, 5.85],
      [2.4, 3.6],
      [2.05, 4.55], // shoulders
      // 2. Head / headphones
      [1.25, 5.25],
      [1.15, 5.7],
      [2.05, 6.45],
      [2.95, 5.7],
      [3.05, 4.95],
      [2.35, 5.35],
      [2.05, 4.55], // shoulders
      // 3. Torso and legs
      [2.05, 0.45], // hip
      [2.75, -5.1], // right leg
      [2.05, 0.45], // back to hip
      [1.35, -5.1], // left leg
      // 4. Ground baseline connecting person to pump
      [-2.4, -5.1],
      // 5. Pump body
      [-5.1, -5.1], // bottom-left of pump
      [-5.1, 5.6],  // up left side of pump
      [-2.4, 5.6],  // across top of pump
      [-2.4, -5.1], // down right side of pump
      // 6. Pump middle divider line
      [-2.4, 0.2],
      [-5.1, 0.2],
      // 7. Walk to window
      [-5.1, 4.1],
      [-3.35, 4.1],
      // 8. Window loop
      [-3.35, 4.95],
      [-2.85, 4.95],
      [-2.85, 4.1],
      [-3.35, 4.1],
      // 9. Backtrack to pump exit and hose start
      [-5.1, 4.1],
      [-5.1, 0.2],
      [-2.4, 0.2],
      // 10. Hose loop
      [-1.7, 0.2],
      [-1.7, -2.6],
      [-0.9, -2.6],
      [-0.9, 1.6],
      [0.4, 1.6],
    ]),
  },
];

const connectorStrokes = [];

/** Single runnable LineString (corners only — what you run). */
function mergeRunCoords() {
  const out = [];
  const push = (pt) => {
    if (!pt) return;
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last[0] - pt[0]) < 1e-8 &&
      Math.abs(last[1] - pt[1]) < 1e-8
    ) {
      return;
    }
    out.push(pt);
  };
  for (const stroke of artStrokes) {
    for (const pt of stroke.points) push(pt);
  }
  for (const seg of connectorStrokes) {
    for (const pt of seg) push(pt);
  }
  return out;
}

function routeToGpxSimple(coords, name) {
  const pts = coords
    .map(
      ([lat, lng]) =>
        `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <desc>Hand-curated GAS logo grid route — East Village NYC</desc>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}

function routeKm(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const metersPerLat = 111_320;
    const metersPerLon = metersPerLat * Math.cos(latRad);
    km +=
      Math.hypot((lat2 - lat1) * metersPerLat, (lon2 - lon1) * metersPerLon) /
      1000;
  }
  return km;
}

const runCoords = mergeRunCoords();

const artKm =
  artStrokes.reduce((s, stroke) => s + routeKm(stroke.points), 0) +
  connectorStrokes.reduce((s, stroke) => s + routeKm(stroke), 0);
const runKm = routeKm(runCoords);

const allPoints = [
  ...artStrokes.flatMap((s) => s.points),
  ...connectorStrokes.flat(),
];

function lonToWorldX(lon, zoom) {
  return ((lon + 180) / 360) * tileSize * 2 ** zoom;
}

function latToWorldY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    tileSize *
    2 ** zoom
  );
}

function chooseZoom() {
  for (let zoom = 16; zoom >= 11; zoom--) {
    const xs = allPoints.map(([, lon]) => lonToWorldX(lon, zoom));
    const ys = allPoints.map(([lat]) => latToWorldY(lat, zoom));
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX <= width * 0.76 && spanY <= height * 0.76) return zoom;
  }
  return 12;
}

const zoom = chooseZoom();
const xs = allPoints.map(([, lon]) => lonToWorldX(lon, zoom));
const ys = allPoints.map(([lat]) => latToWorldY(lat, zoom));
const viewportX = (Math.min(...xs) + Math.max(...xs)) / 2 - width / 2;
const viewportY = (Math.min(...ys) + Math.max(...ys)) / 2 - height / 2;

function screenPoint([lat, lon]) {
  return [lonToWorldX(lon, zoom) - viewportX, latToWorldY(lat, zoom) - viewportY];
}

function pathData(points) {
  return points
    .map((point, i) => {
      const [x, y] = screenPoint(point);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

const minTileX = Math.floor(viewportX / tileSize);
const maxTileX = Math.floor((viewportX + width) / tileSize);
const minTileY = Math.floor(viewportY / tileSize);
const maxTileY = Math.floor((viewportY + height) / tileSize);

const tileComposites = [];
for (let tx = minTileX; tx <= maxTileX; tx++) {
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    const url = `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
    const res = await fetch(url, {
      headers: { "User-Agent": "PACE-CASSO gas logo route preview" },
    });
    if (!res.ok) continue;
    tileComposites.push({
      input: Buffer.from(await res.arrayBuffer()),
      left: Math.round(tx * tileSize - viewportX),
      top: Math.round(ty * tileSize - viewportY),
    });
  }
}

const artPaths = artStrokes
  .map(
    (stroke) =>
      `<path d="${pathData(stroke.points)}" fill="none" stroke="#075f32" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" opacity="0.98"/>` +
      `<path d="${pathData(stroke.points)}" fill="none" stroke="${stroke.color}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.96"/>`,
  )
  .join("\n");

const connectorPaths = connectorStrokes
  .map(
    (stroke) =>
      `<path d="${pathData(stroke)}" fill="none" stroke="#ffba00" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="14 12" opacity="0.85"/>`,
  )
  .join("\n");

const runPath =
  `<path d="${pathData(runCoords)}" fill="none" stroke="#e11d48" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"/>`;

const overlay = Buffer.from(`
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(255,255,255,0.03)"/>
  ${runPath}
  ${connectorPaths}
  ${artPaths}
  <g transform="translate(28 28)">
    <rect width="430" height="76" rx="8" fill="white" opacity="0.94"/>
    <text x="18" y="30" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#111">GAS logo — runnable Manhattan grid route</text>
    <text x="18" y="58" font-family="Arial, sans-serif" font-size="18" fill="#333">${runKm.toFixed(1)} km · pump · hose · headphone person</text>
  </g>
</svg>`);

const pngPath = path.join(outDir, "GAS-LOGO-RUN-map.png");
await sharp({
  create: {
    width,
    height,
    channels: 4,
    background: "#f2ede3",
  },
})
  .composite([...tileComposites, { input: overlay, left: 0, top: 0 }])
  .png()
  .toFile(pngPath);

const gpx = routeToGpxSimple(runCoords, "PACE-CASSO GAS logo NYC");
const gpxPath = path.join(outDir, "GAS-LOGO-RUN.gpx");
await fs.writeFile(gpxPath, gpx, "utf8");

const meta = {
  pngPath,
  gpxPath,
  runKm: Number(runKm.toFixed(2)),
  artKm: Number(artKm.toFixed(2)),
  vertexCount: runCoords.length,
  center,
  zoom,
};
await fs.writeFile(
  path.join(outDir, "route-meta.json"),
  JSON.stringify(meta, null, 2),
  "utf8",
);

console.log(JSON.stringify(meta, null, 2));
