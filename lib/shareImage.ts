/**
 * The share image for a /draw result: the customer's own picture beside the
 * route that draws it, with the distance and time, as one square PNG to post
 * (the Nov 11 blind review: nothing to show for the run but a GPX file).
 *
 * No map tiles: they load from another site and a canvas that has drawn them
 * cannot be saved. The route line on a dark card is what Strava posts look
 * like anyway.
 */

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

  // the route
  const top = pad + tile + 50;
  const line = fitRoute(points, { x: pad + 20, y: top, w: S - 2 * pad - 40, h: S - top - 150 });
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 9;
  ctx.beginPath();
  line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
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
  ctx.fillText("PACECASSO", pad, S - 62);
  ctx.fillStyle = "#9ca3af";
  ctx.font = "34px Arial, Helvetica, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("pacecasso.com/draw", S - pad, S - 62);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
