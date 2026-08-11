import assert from "node:assert/strict";
import {
  REJECTED_ROUTE_BANK_SUBJECTS,
  VERIFIED_ROUTE_BANK_SUBJECTS,
} from "./verifiedRouteBankManifest";

// Aug 11 re-verification: only subjects passing the blind instrument 3/3
// in BOTH rounds stay verified (raw verdicts in
// tmp-gas-commission/reverify/). Eight July "proofs" were demoted.
assert.equal(VERIFIED_ROUTE_BANK_SUBJECTS.length, 1);
assert.equal(VERIFIED_ROUTE_BANK_SUBJECTS[0]!.id, "apple");
assert.equal(new Set(VERIFIED_ROUTE_BANK_SUBJECTS.map((s) => s.id)).size, VERIFIED_ROUTE_BANK_SUBJECTS.length);
assert.equal(new Set(VERIFIED_ROUTE_BANK_SUBJECTS.map((s) => s.proofId)).size, VERIFIED_ROUTE_BANK_SUBJECTS.length);
assert.equal(
  VERIFIED_ROUTE_BANK_SUBJECTS.filter((s) => s.cityId === "dc").length,
  0,
  "the DC martini failed Aug 11 re-verification; nothing outside Manhattan is currently verified",
);
// Every demotion must carry the re-verification reason.
for (const id of ["sneaker", "sailboat", "heart-les", "turtle", "key", "martini", "umbrella", "trophy"]) {
  const rejected = REJECTED_ROUTE_BANK_SUBJECTS.find((s) => s.id === id);
  assert(rejected, `${id} must be recorded as rejected after failing re-verification`);
  assert(/re-verification/.test(rejected.reason), `${id} rejection must cite the re-verification`);
}
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
