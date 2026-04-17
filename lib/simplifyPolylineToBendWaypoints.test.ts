import assert from "node:assert";
import { simplifyPolylineToBendWaypoints } from "./simplifyPolylineToBendWaypoints";

/** ~10 m per step due north, 40 steps ≈ 400 m — few turns → few waypoints. */
function straightNorth(): [number, number][] {
  const out: [number, number][] = [];
  const lat0 = 40.75;
  const lng = -73.99;
  for (let i = 0; i < 40; i++) {
    out.push([lat0 + i * 9e-5, lng]);
  }
  return out;
}

{
  const s = simplifyPolylineToBendWaypoints(straightNorth(), {
    minTurnDeg: 30,
    maxStraightRunM: 120,
  });
  assert(s.length <= 10, `straight line should collapse, got ${s.length}`);
}

{
  const rightAngle: [number, number][] = [
    [40.75, -73.99],
    [40.751, -73.99],
    [40.752, -73.99],
    [40.753, -73.99],
    [40.753, -73.989],
    [40.753, -73.988],
    [40.753, -73.987],
  ];
  const s = simplifyPolylineToBendWaypoints(rightAngle, { minTurnDeg: 20 });
  assert(s.length >= 2 && s.length <= 6, `corner path got ${s.length} pts`);
}

console.log("simplifyPolylineToBendWaypoints tests ok");
