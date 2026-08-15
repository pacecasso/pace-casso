import assert from "node:assert/strict";
import { BROOKLYN_PRESET, MANHATTAN_PRESET } from "./cityPresets";
import { generateMapNativeCandidates, isSneakerDraftSet, type MapNativeDesignDraft } from "./mapNativeDesigner";
import { CURATED_SNEAKER_DESIGN_INTENT } from "./curatedSneakerManhattanRoute";

const sneakerDraft: MapNativeDesignDraft = {
  label: "uploaded sneaker route art",
  description: "running shoe sneaker with laces, sole, toe cap, heel, and tongue",
  visualFeatures: ["sneaker", "shoe", "laces", "sole", "toe", "heel"],
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  designScore: 100,
};

assert(isSneakerDraftSet([sneakerDraft]), "shoe drafts with laces/sole/toe/heel should be recognized");

const manhattanCandidates = generateMapNativeCandidates({
  drafts: [sneakerDraft],
  preset: MANHATTAN_PRESET,
  targetDistanceKm: 10,
});

assert(manhattanCandidates.length > 0, "Manhattan sneaker drafts should produce candidates");
assert.equal(manhattanCandidates[0]?.designIntent, CURATED_SNEAKER_DESIGN_INTENT);
assert.equal(manhattanCandidates[0]?.routeMode, "direct-grid");
assert(manhattanCandidates[0]!.km >= 18 && manhattanCandidates[0]!.km <= 20);
assert(manhattanCandidates[0]!.anchors.length >= 1000);

const brooklynCandidates = generateMapNativeCandidates({
  drafts: [sneakerDraft],
  preset: BROOKLYN_PRESET,
  targetDistanceKm: 10,
});

assert(
  brooklynCandidates.every((candidate) => candidate.designIntent !== CURATED_SNEAKER_DESIGN_INTENT),
  "the Manhattan sneaker route should not leak into Brooklyn candidates",
);

console.log("mapNativeDesigner sneaker Manhattan tests ok");