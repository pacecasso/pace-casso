import assert from "node:assert/strict";
import { routeLegByLeg, type LatLng } from "./routeLegByLeg";

async function testTooFewAnchors() {
  const r = await routeLegByLeg([[40.75, -73.98]]);
  assert.equal(r.legCount, 0);
  assert.equal(r.coordinates.length, 1);
}

void testTooFewAnchors().then(() => {
  console.log("routeLegByLeg.test.ts ok (offline cases only; Mapbox legs need token)");
});
