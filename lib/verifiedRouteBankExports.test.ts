import assert from "node:assert/strict";
import {
  getVerifiedRouteBankExport,
  listVerifiedRouteBankExports,
  verifiedRouteBankExportToGpx,
} from "./verifiedRouteBankExports";
import { safeRouteCoords } from "./routeExport";
import { VERIFIED_ROUTE_BANK_SUBJECTS } from "./verifiedRouteBankManifest";

const exportsById = new Map(listVerifiedRouteBankExports().map((entry) => [entry.id, entry]));
assert.equal(exportsById.size, listVerifiedRouteBankExports().length, "verified export ids should be unique");
assert.deepEqual(
  [...exportsById.keys()].sort(),
  VERIFIED_ROUTE_BANK_SUBJECTS.map((subject) => subject.proofId).sort(),
  "verified export registry should exactly match the strict proof-bank manifest",
);

for (const subject of VERIFIED_ROUTE_BANK_SUBJECTS) {
  const entry = getVerifiedRouteBankExport(subject.proofId);
  assert(entry, `missing verified GPX export for ${subject.proofId}`);
  const coords = safeRouteCoords(entry.route);
  assert(
    coords.length >= subject.minAnchors,
    `${subject.proofId} export should preserve at least ${subject.minAnchors} route coordinates`,
  );
  const gpx = verifiedRouteBankExportToGpx(entry);
  assert(gpx.includes(`<name>${entry.title}</name>`));
  assert(gpx.includes('creator="PaceCasso verified route bank"'));
  assert.equal(
    (gpx.match(/<trkpt /g) ?? []).length,
    coords.length,
    `${subject.proofId} GPX should contain every route coordinate`,
  );
}

assert.equal(getVerifiedRouteBankExport("martini"), undefined, "ambiguous martini export id should stay city-explicit");
console.log("verifiedRouteBankExports tests ok");
