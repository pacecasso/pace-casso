/**
 * Quantize a placed contour into a Manhattan block outline in map meters.
 * Etch-a-sketch happens here — in city space, not image space.
 */
import type { ContourPoint, PlacementTransform } from "./placementFromContour";

export type LocalMeters = [number, number]; // [east, north] after placement rotation
export type LatLng = [number, number];

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegreeLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Map normalized contour to local east/north meters (same frame as placementFromContour). */
export function contourToLocalMeters(
  contour: ContourPoint[],
  { center, rotationDeg, scale }: PlacementTransform,
): LocalMeters[] {
  const valid = contour.filter(
    (p) => Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1,
  );
  if (!valid.length) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of valid) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const cxNorm = minX + width / 2;
  const cyNorm = minY + height / 2;

  const baseSpanMeters = 2000;
  const metersPerUnit = (baseSpanMeters * scale) / Math.max(width, height);

  const rad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  return valid.map((p) => {
    const localX = (p.x - cxNorm) * metersPerUnit;
    const localY = -(p.y - cyNorm) * metersPerUnit;
    const east = localX * cosR - localY * sinR;
    const north = localX * sinR + localY * cosR;
    return [east, north];
  });
}

function pointInPolygon(x: number, y: number, ring: LocalMeters[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

type GridCell = `${number},${number}`;

function rasterizeFilledCells(ring: LocalMeters[], blockMeters: number): Set<GridCell> {
  if (ring.length < 3) return new Set();

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const i0 = Math.floor(minX / blockMeters) - 1;
  const i1 = Math.ceil(maxX / blockMeters) + 1;
  const j0 = Math.floor(minY / blockMeters) - 1;
  const j1 = Math.ceil(maxY / blockMeters) + 1;

  const filled = new Set<GridCell>();
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const cx = (i + 0.5) * blockMeters;
      const cy = (j + 0.5) * blockMeters;
      if (pointInPolygon(cx, cy, ring)) filled.add(`${i},${j}`);
    }
  }
  return filled;
}

type BlockCorner = [number, number]; // integer grid-corner indices

function hasCell(filled: Set<GridCell>, i: number, j: number): boolean {
  return filled.has(`${i},${j}`);
}

/** Directed boundary edges around union of filled unit cells (CCW). */
function boundaryCornerLoop(filled: Set<GridCell>): BlockCorner[] {
  if (!filled.size) return [];

  type Edge = { from: BlockCorner; to: BlockCorner };
  const edges: Edge[] = [];

  for (const key of filled) {
    const [i, j] = key.split(",").map(Number) as [number, number];
    if (!hasCell(filled, i, j + 1)) edges.push({ from: [i, j + 1], to: [i + 1, j + 1] });
    if (!hasCell(filled, i + 1, j)) edges.push({ from: [i + 1, j + 1], to: [i + 1, j] });
    if (!hasCell(filled, i, j - 1)) edges.push({ from: [i + 1, j], to: [i, j] });
    if (!hasCell(filled, i - 1, j)) edges.push({ from: [i, j], to: [i, j + 1] });
  }

  const edgeFrom = new Map<string, Edge>();
  for (const e of edges) edgeFrom.set(`${e.from[0]},${e.from[1]}`, e);

  let start: BlockCorner | null = null;
  for (const e of edges) {
    if (
      !start ||
      e.from[1] < start[1] ||
      (e.from[1] === start[1] && e.from[0] < start[0])
    ) {
      start = e.from;
    }
  }
  if (!start) return [];

  const loop: BlockCorner[] = [];
  let cur: BlockCorner | null = start;
  const guard = edges.length + 5;
  for (let n = 0; n < guard && cur; n++) {
    loop.push(cur);
    const e = edgeFrom.get(`${cur[0]},${cur[1]}`);
    if (!e) break;
    cur = e.to;
    if (cur[0] === start[0] && cur[1] === start[1]) break;
  }
  return loop;
}

/** Drop collinear vertices on integer grid corners. */
function simplifyCornerLoop(corners: BlockCorner[]): BlockCorner[] {
  if (corners.length < 4) return corners;
  const out: BlockCorner[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n]!;
    const cur = corners[i]!;
    const next = corners[(i + 1) % n]!;
    const dx1 = cur[0] - prev[0];
    const dy1 = cur[1] - prev[1];
    const dx2 = next[0] - cur[0];
    const dy2 = next[1] - cur[1];
    if (dx1 === dx2 && dy1 === dy2) continue;
    out.push(cur);
  }
  return out.length >= 3 ? out : corners;
}

export function localMetersToLatLng(
  eastM: number,
  northM: number,
  center: LatLng,
): LatLng {
  const mplng = metersPerDegreeLng(center[0]);
  return [
    Number((center[0] + northM / METERS_PER_DEG_LAT).toFixed(6)),
    Number((center[1] + eastM / mplng).toFixed(6)),
  ];
}

export type CityBlockQuantizeResult = {
  /** Sparse corners — route these leg-by-leg. */
  cornerLatLngs: LatLng[];
  /** Full block-step outline in lat/lng (for preview). */
  blockStepLatLngs: LatLng[];
  filledCellCount: number;
  blockMeters: number;
};

export function quantizeContourToCityBlocks(
  contour: ContourPoint[],
  placement: PlacementTransform,
  blockMeters: number,
): CityBlockQuantizeResult | null {
  if (!Number.isFinite(blockMeters) || blockMeters < 40) return null;

  const ring = contourToLocalMeters(contour, placement);
  if (ring.length < 3) return null;

  const filled = rasterizeFilledCells(ring, blockMeters);
  if (filled.size < 4) return null;

  const cornerLoop = boundaryCornerLoop(filled);
  if (cornerLoop.length < 4) return null;

  const simplified = simplifyCornerLoop(cornerLoop);
  const toLatLng = (gx: number, gy: number): LatLng =>
    localMetersToLatLng(gx * blockMeters, gy * blockMeters, placement.center);

  const blockStepLatLngs = cornerLoop.map(([gx, gy]) => toLatLng(gx, gy));
  const cornerLatLngs = [...simplified.map(([gx, gy]) => toLatLng(gx, gy)), toLatLng(simplified[0]![0], simplified[0]![1])];

  return {
    cornerLatLngs,
    blockStepLatLngs,
    filledCellCount: filled.size,
    blockMeters,
  };
}
