import assert from "node:assert";
import { VERIFIED_ROUTE_BANK_GALLERY_RUNS } from "./verifiedRouteBankGallery";
import { getVerifiedRouteBankExport } from "./verifiedRouteBankExports";
import { CURATED_MANHATTAN_RUNS } from "./curatedManhattanRuns";

assert.equal(
  VERIFIED_ROUTE_BANK_GALLERY_RUNS.length,
  9,
  "every verified bank export gets a gallery card",
);

const ids = new Set<string>();
for (const run of VERIFIED_ROUTE_BANK_GALLERY_RUNS) {
  assert.ok(!ids.has(run.id), `duplicate gallery id: ${run.id}`);
  ids.add(run.id);

  const bankEntry = getVerifiedRouteBankExport(run.id);
  assert.ok(bankEntry, `gallery card ${run.id} must map to a bank export`);

  assert.ok(run.coords.length >= 50, `${run.id}: route has real geometry`);
  assert.ok(run.distanceKm > 1, `${run.id}: distance is real (${run.distanceKm})`);
  assert.ok(run.title.length > 0 && run.blurb.length > 0 && run.area.length > 0);
  assert.ok(
    run.area.includes(`${run.distanceKm} km`),
    `${run.id}: area line quotes the computed distance`,
  );
}

// Bank ids must not collide with the curated catalog ids — both share the
// /api/curated-gpx/[id] namespace and the /curated/<id>.png image dir.
for (const run of CURATED_MANHATTAN_RUNS) {
  assert.ok(!ids.has(run.id), `bank id collides with curated catalog: ${run.id}`);
}

console.log("verifiedRouteBankGallery tests ok");
