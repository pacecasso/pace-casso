import { haversineMeters } from "./haversine";

export type GridPoint = [number, number];
export type LatLng = [number, number];

export function interpolateGrid(a: GridPoint, b: GridPoint): GridPoint[] {
  const [x0, y0] = a;
  const [x1, y1] = b;
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  const out: GridPoint[] = [];
  let x = x0;
  let y = y0;
  while (x !== x1 || y !== y1) {
    if (x !== x1) x += dx;
    else if (y !== y1) y += dy;
    out.push([x, y]);
  }
  return out;
}

export function expandGrid(points: GridPoint[]): GridPoint[] {
  const out: GridPoint[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1]!;
    const next = points[i]!;
    for (const p of interpolateGrid(prev, next)) out.push(p);
  }
  return out;
}

function bearingUnitVector(deg: number): { east: number; north: number } {
  const rad = (deg * Math.PI) / 180;
  return { east: Math.sin(rad), north: Math.cos(rad) };
}

/** Project integer grid steps to lat/lng with separate street vs avenue block sizes. */
export function projectGridToLatLngDual({
  center,
  streetMeters,
  avenueMeters,
  streetBearingDeg,
  grid,
  expand = true,
}: {
  center: LatLng;
  streetMeters: number;
  avenueMeters: number;
  streetBearingDeg: number;
  grid: GridPoint[];
  expand?: boolean;
}): LatLng[] {
  const xAxis = bearingUnitVector(streetBearingDeg);
  const yAxis = bearingUnitVector(streetBearingDeg + 90);
  const lat0 = center[0];
  const metersPerLat = 111_320;
  const metersPerLng = metersPerLat * Math.cos((lat0 * Math.PI) / 180);
  const steps = expand ? expandGrid(grid) : grid;

  return steps.map(([gx, gy]) => {
    const eastM = gx * streetMeters * xAxis.east + gy * avenueMeters * yAxis.east;
    const northM = gx * streetMeters * xAxis.north + gy * avenueMeters * yAxis.north;
    return [
      Number((center[0] + northM / metersPerLat).toFixed(6)),
      Number((center[1] + eastM / metersPerLng).toFixed(6)),
    ];
  });
}

export function routeLengthKm(coords: LatLng[]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    meters += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return meters / 1000;
}
