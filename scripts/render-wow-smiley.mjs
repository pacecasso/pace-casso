import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outDir = path.join(process.cwd(), "tmp-wow-route");
await fs.mkdir(outDir, { recursive: true });

const width = 1440;
const height = 950;
const tileSize = 256;
const center = [40.781, -73.965];

function offsetLatLngMeters([lat, lon], east, north) {
  const metersPerLat = 111_320;
  const metersPerLon = metersPerLat * Math.cos((lat * Math.PI) / 180);
  return [lat + north / metersPerLat, lon + east / metersPerLon];
}

function ellipseStroke(cx, cy, rx, ry, startDeg, endDeg, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const deg = startDeg + (endDeg - startDeg) * t;
    const rad = (deg * Math.PI) / 180;
    out.push(offsetLatLngMeters(center, cx + Math.cos(rad) * rx, cy + Math.sin(rad) * ry));
  }
  return out;
}

function circleStroke(cx, cy, r, steps = 24) {
  return ellipseStroke(cx, cy, r, r, 0, 360, steps);
}

const face = ellipseStroke(0, 0, 1720, 2280, 0, 360, 96);
const leftEye = circleStroke(-620, 680, 230, 28);
const rightEye = circleStroke(620, 680, 230, 28);
const smile = ellipseStroke(0, -420, 980, 740, 205, 335, 36);

const artStrokes = [
  { name: "face", points: face },
  { name: "left eye", points: leftEye },
  { name: "right eye", points: rightEye },
  { name: "smile", points: smile },
];

const connectorStrokes = [
  [face.at(-1), leftEye[0]],
  [leftEye.at(-1), rightEye[0]],
  [rightEye.at(-1), smile[0]],
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
    if (spanX <= width * 0.7 && spanY <= height * 0.72) return zoom;
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
      headers: { "User-Agent": "PACE-CASSO local route preview (development)" },
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
      `<path d="${pathData(stroke.points)}" fill="none" stroke="#0b7a3b" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" opacity="0.96"/>` +
      `<path d="${pathData(stroke.points)}" fill="none" stroke="#18b45b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>`,
  )
  .join("\n");

const connectorPaths = connectorStrokes
  .map(
    (stroke) =>
      `<path d="${pathData(stroke)}" fill="none" stroke="#ffba00" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="14 12" opacity="0.78"/>`,
  )
  .join("\n");

const km = totalRunKm();
const overlay = Buffer.from(`
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(255,255,255,0.04)"/>
  ${connectorPaths}
  ${artPaths}
  <g transform="translate(28 28)">
    <rect width="348" height="72" rx="8" fill="white" opacity="0.94"/>
    <text x="18" y="29" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#111">Smiley face route</text>
    <text x="18" y="56" font-family="Arial, sans-serif" font-size="18" fill="#333">${km.toFixed(1)} km including connectors</text>
  </g>
</svg>`);

const pngPath = path.join(outDir, "smiley-route.png");
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
