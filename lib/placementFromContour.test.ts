import assert from "node:assert";
import { buildAnchorLatLngsFromContour, type ContourPoint } from "./placementFromContour";

const center: [number, number] = [40, -73];

function distanceKm(contour: ContourPoint[]): number {
  return buildAnchorLatLngsFromContour(contour, {
    center,
    rotationDeg: 0,
    scale: 1,
  }).approxDistanceKm;
}

{
  const openCorner: ContourPoint[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ];
  const km = distanceKm(openCorner);
  assert(Math.abs(km - 4) < 0.001, `open path should be 4 km, got ${km}`);
}

{
  const closedSquare: ContourPoint[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: 0, y: 0 },
  ];
  const km = distanceKm(closedSquare);
  assert(Math.abs(km - 8) < 0.001, `closed square should be 8 km, got ${km}`);
}

{
  const visuallyOpenSquare: ContourPoint[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const km = distanceKm(visuallyOpenSquare);
  assert(
    Math.abs(km - 6) < 0.001,
    `non-duplicate square path should remain open at 6 km, got ${km}`,
  );
}

{
  const malformed: ContourPoint[] = [
    { x: 0, y: 0 },
    { x: Number.NaN, y: 0.5 },
    { x: 1, y: 1 },
  ];
  const result = buildAnchorLatLngsFromContour(malformed, {
    center,
    rotationDeg: 0,
    scale: 1,
  });
  assert.equal(result.anchorLatLngs.length, 2);
  assert(result.anchorLatLngs.every(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)));
  assert(result.approxDistanceKm > 0);
}

{
  const result = buildAnchorLatLngsFromContour(
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    {
      center: [120, -73],
      rotationDeg: 0,
      scale: 1,
    },
  );
  assert.deepEqual(result, { anchorLatLngs: [], approxDistanceKm: 0 });
}

{
  const result = buildAnchorLatLngsFromContour(
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    {
      center,
      rotationDeg: 0,
      scale: 0,
    },
  );
  assert.deepEqual(result, { anchorLatLngs: [], approxDistanceKm: 0 });
}

console.log("placementFromContour tests ok");
