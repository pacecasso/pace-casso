/**
 * The share image for a /draw result: the customer's own picture beside the
 * route that draws it, with the distance and time, as one square PNG to post
 * (the Nov 11 blind review: nothing to show for the run but a GPX file).
 *
 * The route is drawn on the street map (Ralph, Nov 12: "the share pic should
 * also show the streets"). The tiles come from the same Esri server as the
 * page's maps, which allows other sites to read them, so the canvas can
 * still be saved. If a tile fails to load the route is drawn on the plain
 * dark card instead.
 */
import { OSM_TILE_URL } from "./mapAttribution";

export type Box = { x: number; y: number; w: number; h: number };

/**
 * [lat, lng] points -> canvas [x, y] inside `box`: north up, the same scale
 * both ways (longitude shrunk by the latitude), centred.
 */
export function fitRoute(points: [number, number][], box: Box): [number, number][] {
  if (points.length === 0) return [];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of points) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const w = (maxLng - minLng) * k;
  const h = maxLat - minLat;
  const s = Math.min(box.w / (w || 1e-9), box.h / (h || 1e-9));
  const ox = box.x + (box.w - w * s) / 2;
  const oy = box.y + (box.h - h * s) / 2;
  return points.map(([lat, lng]) => [ox + (lng - minLng) * k * s, oy + (maxLat - lat) * s]);
}

export const SHARE_SIZE = 1200;

const TILE = 256;
const MAX_ZOOM = 17;

/** [lat, lng] -> web-mercator position on the zoom-0 world (one 256 px tile) */
function world([lat, lng]: [number, number]): [number, number] {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * TILE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE];
}

export type MapTile = { z: number; x: number; y: number; left: number; top: number; size: number };
export type MapView = { line: [number, number][]; tiles: MapTile[] };

/**
 * The street map behind a route: the route fills `box` less `pad` on each
 * side, and `tiles` are the map tiles that cover the whole box, each with
 * its place on the canvas. Tiles are drawn at 50-100% of their size, so the
 * street names stay sharp.
 */
export function mapView(points: [number, number][], box: Box, pad: number): MapView {
  if (points.length === 0) return { line: [], tiles: [] };
  const w = points.map(world);
  const xs = w.map((p) => p[0]);
  const ys = w.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  // canvas pixels per zoom-0 pixel
  const fit = Math.min((box.w - 2 * pad) / (maxX - minX || 1e-9), (box.h - 2 * pad) / (maxY - minY || 1e-9));
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.ceil(Math.log2(fit))));
  const s = Math.min(fit, 2 ** z);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const ox = box.x + box.w / 2 - cx * s, oy = box.y + box.h / 2 - cy * s;
  const n = 2 ** z;
  const size = (TILE / n) * s;
  const tiles: MapTile[] = [];
  const x0 = Math.floor(((box.x - ox) / s / TILE) * n), x1 = Math.floor(((box.x + box.w - ox) / s / TILE) * n);
  const y0 = Math.floor(((box.y - oy) / s / TILE) * n), y1 = Math.floor(((box.y + box.h - oy) / s / TILE) * n);
  for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
    for (let x = x0; x <= x1; x++) {
      // the map repeats east-west
      tiles.push({ z, x: ((x % n) + n) % n, y, left: ox + x * size, top: oy + y * size, size });
    }
  }
  return { line: w.map(([x, y]) => [ox + x * s, oy + y * s]), tiles };
}

function loadTile(t: MapTile): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image();
    // without this the canvas could not be saved after drawing the tile
    im.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), 8000);
    im.onload = () => {
      clearTimeout(timer);
      resolve(im);
    };
    im.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    im.src = OSM_TILE_URL.replace("{z}", String(t.z)).replace("{y}", String(t.y)).replace("{x}", String(t.x));
  });
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

/**
 * Browser only. `picture`: the upload's thumbnail (a data URL kept in this
 * browser), or null on another device, where the card is drawn without it.
 */
export async function drawShareImage(
  points: [number, number][],
  picture: string | null,
  stats: string,
): Promise<Blob | null> {
  const S = SHARE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx || points.length < 2) return null;
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, S, S);

  // top band: the picture on a white tile, the stats beside it
  const pad = 56;
  const tile = 250;
  const im = picture ? await loadImage(picture) : null;
  let textX = pad;
  if (im) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(pad, pad, tile, tile, 24);
    ctx.fill();
    const k = Math.min((tile - 40) / im.width, (tile - 40) / im.height);
    ctx.drawImage(im, pad + (tile - im.width * k) / 2, pad + (tile - im.height * k) / 2, im.width * k, im.height * k);
    textX = pad + tile + 44;
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#9ca3af";
  ctx.font = "600 34px Arial, Helvetica, sans-serif";
  ctx.fillText(im ? "My logo, drawn as a run" : "Drawn as a run", textX, pad + 78);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 76px Arial, Helvetica, sans-serif";
  ctx.fillText(stats, textX, pad + 172, S - textX - pad);

  // the route, on the street map when its tiles load
  const top = pad + tile + 40;
  const area: Box = { x: pad, y: top, w: S - 2 * pad, h: S - top - 130 };
  const view = mapView(points, area, 60);
  const tiles = view.tiles.length <= 80 ? await Promise.all(view.tiles.map(loadTile)) : [];
  const mapped = tiles.length > 0 && tiles.every((t) => t !== null);
  const line = mapped ? view.line : fitRoute(points, { x: area.x + 20, y: area.y, w: area.w - 40, h: area.h });
  if (mapped) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(area.x, area.y, area.w, area.h, 24);
    ctx.clip();
    view.tiles.forEach((t, i) => ctx.drawImage(tiles[i] as HTMLImageElement, t.left, t.top, t.size + 0.5, t.size + 0.5));
    // a light wash, so the route stands out from the orange roads of the map
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(area.x, area.y, area.w, area.h);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(area.x + area.w - 500, area.y + area.h - 34, 500, 34);
    ctx.fillStyle = "#374151";
    ctx.font = "20px Arial, Helvetica, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("Map: Esri, HERE, Garmin, © OpenStreetMap contributors", area.x + area.w - 12, area.y + area.h - 10);
    ctx.textAlign = "left";
    ctx.restore();
  }
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const stroke = (colour: string, width: number) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  };
  if (mapped) {
    stroke("#ffffff", 14);
    stroke("#dc2626", 8);
  } else {
    stroke("#f97316", 9);
  }
  const dot = ([x, y]: [number, number], fill: string) => {
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  };
  dot(line[line.length - 1], "#111827");
  dot(line[0], "#16a34a");

  ctx.fillStyle = "#facc15";
  ctx.font = "bold 40px Arial, Helvetica, sans-serif";
  ctx.fillText("PACECASSO", pad, S - 50);
  ctx.fillStyle = "#9ca3af";
  ctx.font = "34px Arial, Helvetica, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("pacecasso.com/draw", S - pad, S - 50);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
