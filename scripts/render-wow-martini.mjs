import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outDir = path.join(process.cwd(), "tmp-wow-route");
await fs.mkdir(outDir, { recursive: true });

// A deliberately designed Manhattan martini-glass route:
// rim, bowl, stem, and base. The coordinates sit on/near Manhattan streets
// and Central Park paths so the line reads as a real run, not a floating icon.
const route = [
  [40.7818, -73.9824],
  [40.7776, -73.9634],
  [40.7628, -73.9749],
  [40.7818, -73.9824],
  [40.7776, -73.9634],
  [40.7628, -73.9749],
  [40.7489, -73.9851],
  [40.7439, -73.9888],
  [40.7412, -73.9762],
  [40.7461, -73.9725],
  [40.7489, -73.9851],
];

const width = 1440;
const height = 950;
const tileSize = 256;

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

function worldToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / (tileSize * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function worldToLon(x, zoom) {
  return (x / (tileSize * 2 ** zoom)) * 360 - 180;
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

function chooseZoom() {
  for (let zoom = 16; zoom >= 11; zoom--) {
    const xs = route.map(([, lon]) => lonToWorldX(lon, zoom));
    const ys = route.map(([lat]) => latToWorldY(lat, zoom));
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX <= width * 0.72 && spanY <= height * 0.72) return zoom;
  }
  return 12;
}

const zoom = chooseZoom();
const xs = route.map(([, lon]) => lonToWorldX(lon, zoom));
const ys = route.map(([lat]) => latToWorldY(lat, zoom));
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);
const centerX = (minX + maxX) / 2;
const centerY = (minY + maxY) / 2;
const viewportX = centerX - width / 2;
const viewportY = centerY - height / 2;

const minTileX = Math.floor(viewportX / tileSize);
const maxTileX = Math.floor((viewportX + width) / tileSize);
const minTileY = Math.floor(viewportY / tileSize);
const maxTileY = Math.floor((viewportY + height) / tileSize);

const tileComposites = [];
for (let tx = minTileX; tx <= maxTileX; tx++) {
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    const url = `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "PACE-CASSO local route preview (development)",
      },
    });
    if (!res.ok) continue;
    const input = Buffer.from(await res.arrayBuffer());
    tileComposites.push({
      input,
      left: Math.round(tx * tileSize - viewportX),
      top: Math.round(ty * tileSize - viewportY),
    });
  }
}

const screenPoints = route.map(([lat, lon]) => [
  lonToWorldX(lon, zoom) - viewportX,
  latToWorldY(lat, zoom) - viewportY,
]);
const pathData = screenPoints
  .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`)
  .join(" ");

const km = routeKm(route);
const overlay = Buffer.from(`
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(255,255,255,0.08)"/>
  <path d="${pathData}" fill="none" stroke="#0b6f3a" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity="0.96"/>
  <path d="${pathData}" fill="none" stroke="#ffd400" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="18 12" opacity="0.95"/>
  <circle cx="${screenPoints[0][0].toFixed(1)}" cy="${screenPoints[0][1].toFixed(1)}" r="9" fill="#ffb000" stroke="#0b6f3a" stroke-width="3"/>
  <g transform="translate(28 28)">
    <rect width="330" height="70" rx="8" fill="white" opacity="0.94"/>
    <text x="18" y="29" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#111">Martini glass route</text>
    <text x="18" y="55" font-family="Arial, sans-serif" font-size="18" fill="#333">${km.toFixed(1)} km across Manhattan</text>
  </g>
</svg>`);

const pngPath = path.join(outDir, "martini-route.png");
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

const bounds = {
  north: worldToLat(viewportY, zoom),
  south: worldToLat(viewportY + height, zoom),
  west: worldToLon(viewportX, zoom),
  east: worldToLon(viewportX + width, zoom),
};

console.log(
  JSON.stringify(
    {
      pngPath,
      km: Number(km.toFixed(2)),
      zoom,
      bounds,
      tiles: tileComposites.length,
    },
    null,
    2,
  ),
);
