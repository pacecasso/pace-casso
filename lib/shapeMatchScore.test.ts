import assert from "node:assert";
import {
  interpretationMatchPercent,
  meanBidirectionalErrorMeters,
  shapeAccuracyPercent,
} from "./shapeMatchScore";

/** Short Manhattan-ish segment */
const a: [number, number][] = [
  [40.75, -73.99],
  [40.76, -73.99],
  [40.76, -73.98],
];

const same = a.map(([la, ln]) => [la, ln] as [number, number]);

{
  const m = meanBidirectionalErrorMeters(same, same);
  assert.strictEqual(m, 0);
  assert.strictEqual(shapeAccuracyPercent(same, same), 100);
  assert.strictEqual(interpretationMatchPercent(same, same), 100);
}

/** Slightly jittered route along same corridor — interpretation should not collapse vs tight fit */
const b: [number, number][] = [
  [40.7501, -73.9902],
  [40.759, -73.9895],
  [40.7595, -73.979],
];

{
  const tight = shapeAccuracyPercent(a, b);
  const interp = interpretationMatchPercent(a, b);
  assert(tight >= 0 && tight <= 100);
  assert(interp >= 0 && interp <= 100);
  assert(
    interp >= tight - 5,
    `expected interpretation >= tight - 5, got tight=${tight} interp=${interp}`,
  );
}

console.log("shapeMatchScore tests ok");
