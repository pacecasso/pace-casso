import assert from "node:assert/strict";
import { BROOKLYN_PRESET } from "./cityPresets";
import { generateMapNativeCandidates, type MapNativeDesignDraft } from "./mapNativeDesigner";
import { CURATED_GAS_LOGO_BROOKLYN_DESIGN_INTENT } from "./curatedGasLogoBrooklynRoute";

const gasDraft: MapNativeDesignDraft = {
  label: "gas pump person logo",
  description: "gas pump with hose and person figure",
  visualFeatures: ["gas pump", "hose", "person", "legs"],
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  designScore: 100,
};

const candidates = generateMapNativeCandidates({
  drafts: [gasDraft],
  preset: BROOKLYN_PRESET,
  targetDistanceKm: 10,
});

assert(candidates.length > 0, "Brooklyn gas drafts should produce candidates");
assert.equal(candidates[0]?.designIntent, CURATED_GAS_LOGO_BROOKLYN_DESIGN_INTENT);
assert.equal(candidates[0]?.routeMode, "direct-grid");
assert(candidates[0]!.km >= 29 && candidates[0]!.km <= 33);
assert(candidates[0]!.anchors.length >= 1000);

console.log("mapNativeDesigner gas Brooklyn tests ok");