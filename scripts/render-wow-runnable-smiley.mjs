import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outDir = path.join(process.cwd(), "tmp-wow-route");
await fs.mkdir(outDir, { recursive: true });

const width = 1440;
const height = 950;
const tileSize = 256;
const center = [40.7558, -73.984];

const xStepMeters = 275; // about one Manhattan avenue gap
const yStepMeters = 80; // about one Manhattan street gap
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

const artStrokes = [
  {
    name: "face outline",
    points: poly([
      [-4.5, 18],
      [4.5, 18],
      [4.5, -18],
      [-4.5, -18],
      [-4.5, 18],
    ]),
  },
  {
    name: "left eye",
    points: poly([
      [-3.3, 8],
      [-2.2, 8],
      [-2.2, 4],
      [-3.3, 4],
      [-3.3, 8],
    ]),
  },
  {
    name: "right eye",
    points: poly([
      [2.2, 8],
      [3.3, 8],
      [3.3, 4],
      [2.2, 4],
      [2.2, 8],
    ]),
  },
  {
    name: "smile",
    points: poly([
      [-3.5, -5],
      [-3.5, -9],
      [-2.4, -12],
      [0, -13],
      [2.4, -12],
      [3.5, -9],
      [3.5, -5],
    ]),
  },
];

const connectorStrokes = [
  [artStrokes[0].points.at(-1), artStrokes[1].points[0]],
  [artStrokes[1].points.at(-1), artStrokes[2].points[0]],
  [artStrokes[2].points.at(-1), artStrokes[3].points[0]],
].filter(([a, b]) => a && b);

const allPoints = [
  ...artStrokes.flatMap((stroke) => stroke.points),
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

function totalRunKm() {
  return (
    artStrokes.reduce((sum, stroke) => sum + routeKm(stroke.points), 0) +
    connectorStrokes.reduce((sum, stroke) => sum + routeKm(stroke), 0)
  );
}

function chooseZoom() {
  for (let zoom = 16; zoom >= 11; zoom--) {
    const xs = allPoints.map(([, lon]) => lonToWorldX(lon, zoom));
    const ys = allPoints.map(([lat]) => latToWorldY(lat, zoom));
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX <= width * 0.72 && spanY <= height * 0.72) return zoom;
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
      headers: { "User-Agent": "PACE-CASSO local runnable route preview" },
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
      `<path d="${pathData(stroke.points)}" fill="none" stroke="#075f32" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity="0.98"/>` +
      `<path d="${pathData(stroke.points)}" fill="none" stroke="#21b45d" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>`,
  )
  .join("\n");

const connectorPaths = connectorStrokes
  .map(
    (stroke) =>
      `<path d="${pathData(stroke)}" fill="none" stroke="#ffba00" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="14 12" opacity="0.8"/>`,
  )
  .join("\n");

const km = totalRunKm();
const overlay = Buffer.from(`
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(255,255,255,0.03)"/>
  ${connectorPaths}
  ${artPaths}
  <g transform="translate(28 28)">
    <rect width="390" height="76" rx="8" fill="white" opacity="0.94"/>
    <text x="18" y="30" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#111">Runnable grid-smiley route</text>
    <text x="18" y="58" font-family="Arial, sans-serif" font-size="18" fill="#333">${km.toFixed(1)} km on Manhattan grid corridors</text>
  </g>
</svg>`);

const pngPath = path.join(outDir, "runnable-smiley-route.png");
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

console.log(
  JSON.stringify(
    {
      pngPath,
      km: Number(km.toFixed(2)),
      zoom,
      tiles: tileComposites.length,
    },
    null,
    2,
  ),
);
