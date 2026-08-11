import assert from "node:assert";
import {
  REVERIFIED_CATALOG_IDS,
  VERIFIED_ROUTE_BANK_GALLERY_RUNS,
} from "./verifiedRouteBankGallery";
import { getVerifiedRouteBankExport } from "./verifiedRouteBankExports";
import { CURATED_MANHATTAN_RUNS } from "./curatedManhattanRuns";
import { VERIFIED_ROUTE_BANK_SUBJECTS } from "./verifiedRouteBankManifest";

// Aug 11 re-verification: only double-3/3 passers are shown publicly.
assert.equal(VERIFIED_ROUTE_BANK_GALLERY_RUNS.length, 1);
assert.equal(VERIFIED_ROUTE_BANK_GALLERY_RUNS[0]!.id, "apple");

// The public bank cards must be a subset of the manifest's verified set.
const verifiedIds = new Set(VERIFIED_ROUTE_BANK_SUBJECTS.map((s) => s.id));
for (const run of VERIFIED_ROUTE_BANK_GALLERY_RUNS) {
  assert.ok(
    verifiedIds.has(run.id),
    `gallery card ${run.id} must be verified in the manifest`,
  );
}

const ids = new Set<string>();
for (const run of VERIFIED_ROUTE_BANK_GALLERY_RUNS) {
  assert.ok(!ids.has(run.id), `duplicate gallery id: ${run.id}`);
  ids.add(run.id);
  const bankEntry = getVerifiedRouteBankExport(run.id);
  assert.ok(bankEntry, `gallery card ${run.id} must map to a bank export`);
  assert.ok(run.coords.length >= 50, `${run.id}: route has real geometry`);
  assert.ok(run.distanceKm > 1, `${run.id}: distance is real (${run.distanceKm})`);
  assert.ok(run.title.length > 0 && run.blurb.length > 0 && run.area.length > 0);
}

// Bank ids must not collide with the curated catalog ids — both share the
// /api/curated-gpx/[id] namespace and the /curated/<id>.png image dir.
for (const run of CURATED_MANHATTAN_RUNS) {
  assert.ok(!ids.has(run.id), `bank id collides with curated catalog: ${run.id}`);
}

// Re-verified catalog list: every id must exist in the catalog, and the
// known Aug 11 failures (smiley, giraffe) must NOT be in it.
for (const id of REVERIFIED_CATALOG_IDS) {
  assert.ok(
    CURATED_MANHATTAN_RUNS.some((run) => run.id === id),
    `${id} must exist in the curated catalog`,
  );
}
assert.ok(!(REVERIFIED_CATALOG_IDS as readonly string[]).includes("catalog-smiley-face"));
assert.ok(!(REVERIFIED_CATALOG_IDS as readonly string[]).includes("catalog-giraffe"));

console.log("verifiedRouteBankGallery tests ok");
