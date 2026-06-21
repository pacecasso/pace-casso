import assert from "node:assert/strict";
import {
  enumerateCityFocusPlacements,
  enumerateCityFirstHeartPlacements,
  cleanVisionDesignDrafts,
  scoreAutoPlacementCandidate,
  selectDiverseAutoFindPickIndices,
  snappedRouteDistanceKm,
  type AutoFindPickSelectionCandidate,
} from "./autoFindTop5";
import { CHICAGO_PRESET, MANHATTAN_PRESET } from "./cityPresets";

assert(
  scoreAutoPlacementCandidate(70, 90) > scoreAutoPlacementCandidate(90, 70),
  "shape match should matter more than clean-line score for placement ranking",
);

assert.equal(
  scoreAutoPlacementCandidate(140, -20),
  scoreAutoPlacementCandidate(100, 0),
  "scores should be clamped before blending",
);

assert.equal(
  snappedRouteDistanceKm({
    coordinates: [
      [40, -73],
      [40.001, -73],
    ],
    distanceMeters: 1234,
  }),
  1.234,
  "valid Mapbox distance should be used when present",
);

const measuredKm = snappedRouteDistanceKm({
  coordinates: [
    [40, -73],
    [40.009, -73],
  ],
  distanceMeters: -10,
});
assert(
  measuredKm != null && measuredKm > 0.9 && measuredKm < 1.1,
  `invalid distance should fall back to polyline length, got ${measuredKm}`,
);

assert.equal(
  snappedRouteDistanceKm({ coordinates: [[40, -73]], distanceMeters: 100 }),
  null,
  "single-point routes have no usable distance",
);

assert.equal(
  snappedRouteDistanceKm({
    coordinates: [
      [40, -73],
      [120, -73],
    ],
    distanceMeters: -10,
  }),
  null,
  "out-of-range coordinates should not be measured as candidate distance",
);

const bunchedCandidates: AutoFindPickSelectionCandidate[] = [
  {
    placement: { center: [40, -73], scale: 1, rotationDeg: 0 },
    qualityScore: 95,
    shapeMatchScore: 95,
  },
  {
    placement: { center: [40.0004, -73.0004], scale: 1.02, rotationDeg: 3 },
    qualityScore: 94,
    shapeMatchScore: 94,
  },
  {
    placement: { center: [40.0005, -73.0005], scale: 0.98, rotationDeg: -2 },
    qualityScore: 93,
    shapeMatchScore: 93,
  },
  {
    placement: { center: [40.018, -73], scale: 1, rotationDeg: 0 },
    qualityScore: 82,
    shapeMatchScore: 82,
  },
  {
    placement: { center: [40, -73], scale: 1.6, rotationDeg: 45 },
    qualityScore: 80,
    shapeMatchScore: 80,
  },
];

assert.deepEqual(
  selectDiverseAutoFindPickIndices(bunchedCandidates, 3),
  [0, 3, 4],
  "fallback picks should avoid showing three tiny variations of one placement",
);

assert.deepEqual(
  selectDiverseAutoFindPickIndices(bunchedCandidates, 3, [2, 1, 0, 3]),
  [2, 3, 4],
  "vision order should lead when route scores are close, then diversify if ranked picks bunch together",
);

const heartLikeCandidates: AutoFindPickSelectionCandidate[] = [
  {
    placement: { center: [40.72, -73.99], scale: 1, rotationDeg: 0 },
    qualityScore: 56,
    shapeMatchScore: 58,
  },
  {
    placement: { center: [40.73, -74.0], scale: 0.95, rotationDeg: 6 },
    qualityScore: 65,
    shapeMatchScore: 73,
  },
  {
    placement: { center: [40.75, -73.98], scale: 1.1, rotationDeg: -12 },
    qualityScore: 58,
    shapeMatchScore: 60,
  },
];

assert.deepEqual(
  selectDiverseAutoFindPickIndices(heartLikeCandidates, 3, [0, 1, 2]),
  [1, 0, 2],
  "a clearly better snapped route should outrank a weaker vision-preferred option",
);

const iconicHeart = [
  { x: 0.5, y: 0.9 },
  { x: 0.2, y: 0.62 },
  { x: 0.1, y: 0.36 },
  { x: 0.22, y: 0.16 },
  { x: 0.39, y: 0.2 },
  { x: 0.5, y: 0.35 },
  { x: 0.61, y: 0.2 },
  { x: 0.78, y: 0.16 },
  { x: 0.9, y: 0.36 },
  { x: 0.8, y: 0.62 },
  { x: 0.5, y: 0.9 },
];

const cityHeartSeeds = enumerateCityFirstHeartPlacements(
  iconicHeart,
  MANHATTAN_PRESET,
);
assert(
  cityHeartSeeds.length >= 20,
  "Manhattan heart-like art should get city-first seed placements",
);
assert(
  cityHeartSeeds.some((p) => Math.abs(p.rotationDeg) === 29),
  "Manhattan heart seeds should include grid-aware rotations",
);
assert.equal(
  enumerateCityFirstHeartPlacements(iconicHeart, CHICAGO_PRESET).length,
  0,
  "city-first heart seeds are currently Manhattan-specific",
);
assert.equal(
  enumerateCityFirstHeartPlacements(
    [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
      { x: 0.2, y: 0.2 },
    ],
    MANHATTAN_PRESET,
  ).length,
  0,
  "non-heart art should not use Manhattan heart-specific seeds",
);

const manhattanFocus = enumerateCityFocusPlacements(
  iconicHeart,
  MANHATTAN_PRESET,
);
assert(
  manhattanFocus.length > cityHeartSeeds.length,
  "Manhattan focus search should add broad district seeds beyond heart-only seeds",
);
assert(
  manhattanFocus.some((p) => p.center[0] > 40.74 && p.center[0] < 40.77),
  "Manhattan focus search should include midtown/chelsea-style centers",
);

const chicagoFocus = enumerateCityFocusPlacements(iconicHeart, CHICAGO_PRESET);
assert(
  chicagoFocus.length > 0,
  "non-Manhattan cities should still get city-focus search seeds",
);
assert(
  chicagoFocus.some((p) => p.rotationDeg === 0 || p.rotationDeg === 90),
  "city-focus search should respect city grid bearings",
);

const cleanedDrafts = cleanVisionDesignDrafts({
  drafts: [
    {
      label: "Overdrawn",
      description: "usable but too many small turns",
      points: Array.from({ length: 45 }, (_, i) => {
        const t = (Math.PI * 2 * i) / 44;
        return {
          x: 0.5 + Math.cos(t) * 0.38,
          y: 0.5 + Math.sin(t) * 0.32,
        };
      }),
    },
    {
      label: "Pump first",
      description: "street-grid gas pump",
      points: [
        { x: -0.2, y: 0.2 },
        { x: 0.4, y: 0.3 },
        { x: 1.2, y: 0.9 },
        { x: 0.7, y: 0.9 },
        { x: 0.2, y: 0.6 },
        { x: -0.2, y: 0.2 },
      ],
    },
    {
      label: "bad draft",
      points: [{ x: "nope", y: 0.2 }],
    },
  ],
});
assert.equal(cleanedDrafts.length, 2, "invalid AI drafts should be dropped");
assert.equal(
  cleanedDrafts[0]!.label,
  "Pump first",
  "stronger street-design drafts should be tried before weaker valid drafts",
);
assert.deepEqual(
  cleanedDrafts[0]!.points,
  [
    { x: 0, y: 0.2 },
    { x: 0.4, y: 0.3 },
    { x: 1, y: 0.9 },
    { x: 0.7, y: 0.9 },
    { x: 0.2, y: 0.6 },
    { x: 0, y: 0.2 },
  ],
  "AI draft points should be clamped into normalized image space",
);
assert.equal(
  typeof cleanedDrafts[0]!.designScore,
  "number",
  "accepted AI drafts should carry a street-design score",
);

const noisyDrafts = cleanVisionDesignDrafts({
  drafts: [
    {
      label: "tiny mess",
      points: [
        { x: 0.48, y: 0.48 },
        { x: 0.49, y: 0.48 },
        { x: 0.49, y: 0.49 },
        { x: 0.48, y: 0.49 },
        { x: 0.48, y: 0.48 },
      ],
    },
  ],
});
assert.equal(
  noisyDrafts.length,
  0,
  "AI drafts collapsed into tiny detail should be rejected before routing",
);

console.log("autoFindTop5 tests ok");
