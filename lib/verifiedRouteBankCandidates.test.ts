import assert from "node:assert/strict";
import { CITY_PRESETS, type CityPreset } from "./cityPresets";
import {
  generateMapNativeCandidates,
  manhattanRouteLibraryCandidates,
  verifiedRouteBankCandidates,
  type MapNativeDesignDraft,
} from "./mapNativeDesigner";
import {
  REJECTED_ROUTE_BANK_SUBJECTS,
  VERIFIED_ROUTE_BANK_SUBJECTS,
  type VerifiedRouteBankCityId,
} from "./verifiedRouteBankManifest";

const presetByCity: Record<VerifiedRouteBankCityId, CityPreset> = {
  manhattan: CITY_PRESETS.manhattan!,
  dc: CITY_PRESETS.dc!,
};

function draftFromFeatures(id: string, features: string[]): MapNativeDesignDraft {
  return {
    label: id,
    description: `uploaded logo resembling ${features.join(", ")}`,
    visualFeatures: features,
    points: [],
    designScore: 1,
  };
}

function candidateIntents(draft: MapNativeDesignDraft, preset: CityPreset): string[] {
  return verifiedRouteBankCandidates([draft], preset, 8).map(
    (candidate) => candidate.designIntent,
  );
}

for (const subject of VERIFIED_ROUTE_BANK_SUBJECTS) {
  const draft = draftFromFeatures(subject.id, subject.features);
  const preset = presetByCity[subject.cityId];
  const candidates = verifiedRouteBankCandidates([draft], preset, 8);
  const verified = candidates.find((candidate) =>
    candidate.designIntent.includes(subject.expectedIntent),
  );

  assert(verified, `${subject.id} should resolve to its verified route in ${subject.cityId}`);
  assert.equal(verified.routeMode, "direct-grid", `${subject.id} should use street-native anchors`);
  assert(
    verified.anchors.length >= subject.minAnchors,
    `${subject.id} should keep at least ${subject.minAnchors} anchors for proof rendering`,
  );
  assert(
    Number.isFinite(verified.km) && verified.km >= 3 && verified.km <= 35,
    `${subject.id} should stay inside the verified-route distance envelope`,
  );

  for (const [cityId, otherPreset] of Object.entries(presetByCity)) {
    if (cityId === subject.cityId) continue;
    assert(
      !candidateIntents(draft, otherPreset).some((intent) =>
        intent.includes(subject.expectedIntent),
      ),
      `${subject.id} should not leak its verified intent into ${cityId}`,
    );
  }
}

for (const rejected of REJECTED_ROUTE_BANK_SUBJECTS) {
  const draft = draftFromFeatures(rejected.id, rejected.features);
  const intents = candidateIntents(draft, presetByCity[rejected.cityId]);
  assert(
    !intents.some((intent) => intent.includes(rejected.rejectedIntent)),
    `${rejected.id} should remain rejected, not promoted as ${rejected.rejectedIntent}`,
  );
}

const dcMartiniDraft = draftFromFeatures("martini", [
  "martini",
  "cocktail",
  "glass",
  "stem",
]);
assert.equal(
  manhattanRouteLibraryCandidates([dcMartiniDraft], presetByCity.dc, 8).length,
  0,
  "the Manhattan route library should stay off for DC presets",
);
// Aug 11 re-verification demoted the DC martini (blind judges read "dog"
// both rounds) — it must NOT be reachable as a verified candidate anymore.
assert(
  !generateMapNativeCandidates({
    drafts: [dcMartiniDraft],
    preset: presetByCity.dc,
    targetDistanceKm: 8,
  }).some((candidate) => candidate.designIntent.includes("Verified martini DC v1")),
  "the demoted DC martini must not surface as a verified candidate",
);

console.log("verifiedRouteBankCandidates tests ok");
