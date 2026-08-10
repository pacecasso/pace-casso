import assert from "node:assert/strict";
import {
  REJECTED_ROUTE_BANK_SUBJECTS,
  VERIFIED_ROUTE_BANK_SUBJECTS,
} from "./verifiedRouteBankManifest";

assert.equal(VERIFIED_ROUTE_BANK_SUBJECTS.length, 9);
assert.equal(new Set(VERIFIED_ROUTE_BANK_SUBJECTS.map((s) => s.id)).size, VERIFIED_ROUTE_BANK_SUBJECTS.length);
assert.equal(new Set(VERIFIED_ROUTE_BANK_SUBJECTS.map((s) => s.proofId)).size, VERIFIED_ROUTE_BANK_SUBJECTS.length);
assert.equal(
  VERIFIED_ROUTE_BANK_SUBJECTS.filter((s) => s.cityId === "dc").map((s) => s.id).join(","),
  "martini",
  "only the proved DC martini should be verified outside Manhattan for now",
);
for (const subject of VERIFIED_ROUTE_BANK_SUBJECTS) {
  assert(["manhattan", "dc"].includes(subject.cityId), subject.id + " should declare its verified city");
  assert(subject.features.length >= 3, subject.id + " should have searchable features");
  assert(subject.expectedIntent.includes("Verified"), subject.id + " should identify a verified route intent");
  assert(subject.minAnchors >= 60, subject.id + " should preserve enough route detail for proof rendering");
}
for (const rejected of REJECTED_ROUTE_BANK_SUBJECTS) {
  assert(["manhattan", "dc"].includes(rejected.cityId), rejected.id + " should declare its rejection city");
  assert(!VERIFIED_ROUTE_BANK_SUBJECTS.some((subject) => subject.id === rejected.id));
  assert(rejected.reason.length >= 20, rejected.id + " should document why it is not promoted");
}
console.log("verifiedRouteBankManifest tests ok");
