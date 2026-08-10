import assert from "node:assert/strict";
import {
  buildWalkingProofReport,
  parseGpxTrackpoints,
  pathDistanceMeters,
  selectValidationWaypoints,
  selectValidationWaypointsBySpacing,
} from "./streetRouteProof";

const gpx = `<?xml version="1.0"?>
<gpx>
  <trk><trkseg>
    <trkpt lat="40.0000000" lon="-73.0000000"></trkpt>
    <trkpt lat="not-a-number" lon="-73.0010000"></trkpt>
    <trkpt lat="40.0010000" lon="-73.0010000"></trkpt>
  </trkseg></trk>
</gpx>`;

const parsed = parseGpxTrackpoints(gpx);
assert.deepEqual(parsed, [
  [40, -73],
  [40.001, -73.001],
]);

const line: [number, number][] = [];
for (let i = 0; i <= 50; i++) {
  line.push([40, -73 + i * 0.001]);
}

const validation = selectValidationWaypoints(line, 25);
assert.equal(validation.length, 25);
assert.deepEqual(validation[0], line[0]);
assert.deepEqual(validation[validation.length - 1], line[line.length - 1]);
assert(pathDistanceMeters(validation) > 0);

const spacedValidation = selectValidationWaypointsBySpacing(line, {
  spacingMeters: 80,
  maxWaypoints: 100,
});
assert(spacedValidation.length > validation.length);
assert(spacedValidation.length <= 100);
assert.deepEqual(spacedValidation[0], line[0]);
assert.deepEqual(spacedValidation[spacedValidation.length - 1], line[line.length - 1]);
const targetDistanceMeters = pathDistanceMeters(line) * 1.02;
const passing = buildWalkingProofReport({
  candidate: line,
  mapboxWalkingRoute: line,
  validationWaypoints: validation,
  targetDistanceMeters,
});
assert.equal(passing.pass, true);
assert.deepEqual(passing.failures, []);
assert(passing.targetDistanceDeltaRatio != null);
assert(passing.targetDistanceDeltaRatio < 0.05);
assert.equal(passing.validationWaypointCount, 25);

const shifted = line.map(([lat, lng]) => [lat + 0.003, lng] as [number, number]);
const failing = buildWalkingProofReport({
  candidate: shifted,
  mapboxWalkingRoute: line,
  validationWaypoints: selectValidationWaypoints(shifted, 25),
  targetDistanceMeters,
});
assert.equal(failing.pass, false);
assert(failing.failures.includes("mean_deviation_too_high"));
assert(failing.failures.includes("p95_deviation_too_high"));

const tooLong = buildWalkingProofReport({
  candidate: [
    [40, -73],
    [40, -72.95],
  ],
  mapboxWalkingRoute: [
    [40, -73],
    [40, -72.95],
  ],
  validationWaypoints: [
    [40, -73],
    [40, -72.95],
  ],
  targetDistanceMeters: 500,
});
assert.equal(tooLong.pass, false);
assert(tooLong.failures.includes("target_distance_outside_tolerance"));

console.log("streetRouteProof tests ok");
