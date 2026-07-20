import assert from "node:assert/strict";
import {
  enumerateCityFocusPlacements,
  anchorSourceForAutoFindCandidate,
  buildApprovedSketchDraft,
  enumerateCityFirstHeartPlacements,
  addRepresentativeDesignDrafts,
  cleanVisionDesignDrafts,
  deriveRequiredVisualFeatures,
  finalRouteTruthVerdict,
  gasPumpPersonStructureScore,
  hasCompleteGasPumpPersonText,
  inferWordmarkTextFromSourceName,
  inferGasLogoFromSourceName,
  injectGasRepresentativeDrafts,
  injectSwooshRepresentativeDrafts,
  inferSwooshFromSourceName,
  isDisplayWorthyAutoFindCandidate,
  meetsAbsoluteDisplayFloor,
  visionDescribesLettering,
  isSketchLedPlacementSearch,
  mergeVisionDesignDrafts,
  recoverLooseVisionDesignDrafts,
  requiredFeatureCoverageScore,
  routeShapeMatchPercent,
  scoreAutoPlacementCandidate,
  selectDiverseAutoFindPickIndices,
  snappedRouteDistanceKm,
  sweepVisualStructureScore,
  usableTargetDistanceKm,
  visualStructureMatchPercent,
  type AutoFindPickSelectionCandidate,
} from "./autoFindTop5";
import { CHICAGO_PRESET, MANHATTAN_PRESET } from "./cityPresets";
import {
  cityGridSketchCandidates,
  generateMapNativeCandidates,
  isGasLogoDraftSet,
  manhattanRouteLibraryCandidates,
  streetMonogramCandidates,
  streetWordmarkCandidates,
} from "./mapNativeDesigner";

assert.equal(
  anchorSourceForAutoFindCandidate("direct-grid", "image"),
  "street-native",
  "direct-grid candidates should preserve street-native anchors through snapping",
);

assert.equal(
  anchorSourceForAutoFindCandidate("direct-grid", undefined),
  "street-native",
  "direct-grid candidates should still use street-native snapping without an upload anchor source",
);

assert.equal(
  anchorSourceForAutoFindCandidate(undefined, "image"),
  "image",
  "regular image candidates should keep the requested image simplification path",
);

assert(
  scoreAutoPlacementCandidate(70, 90) > scoreAutoPlacementCandidate(90, 70),
  "shape match should matter more than clean-line score for placement ranking",
);

assert.equal(
  scoreAutoPlacementCandidate(140, -20),
  scoreAutoPlacementCandidate(100, 0),
  "scores should be clamped before blending",
);

// Lettering is the one class where scale IS legibility: a glyph stroke has
// to be several blocks thick to read from map altitude. The 9 km default
// produced cramped, unreadable wordmarks; the best one this project has
// made ("JUST DO IT" across 14th-54th St) is roughly 50 km.
assert.equal(
  usableTargetDistanceKm({
    shapeClass: "letter",
    rotationStrategy: "upright",
    scaleHint: "sprawling",
    reason: "five letters",
  }),
  18,
  "wordmarks aim big — block letters only read when they're drawn large",
);

assert.equal(
  usableTargetDistanceKm(
    {
      shapeClass: "letter",
      rotationStrategy: "upright",
      scaleHint: "sprawling",
      reason: "five letters",
    },
    16,
  ),
  16,
  "an explicit target distance should override the usable default",
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

function metersToLatLng(points: [number, number][]): [number, number][] {
  const origin: [number, number] = [40.75, -73.99];
  const metersPerLat = 111_320;
  const metersPerLng = metersPerLat * Math.cos((origin[0] * Math.PI) / 180);
  return points.map(([east, north]) => [
    origin[0] + north / metersPerLat,
    origin[1] + east / metersPerLng,
  ]);
}

const taperedSweepSketch = metersToLatLng([
  [0, 0],
  [420, 170],
  [920, 220],
  [1450, 40],
  [1020, 92],
  [470, 64],
  [0, 0],
]);
const collapsedSweepRoute = metersToLatLng([
  [0, 40],
  [1450, 40],
]);
const sameSweepRoute = metersToLatLng([
  [0, 0],
  [420, 170],
  [920, 220],
  [1450, 40],
  [1020, 92],
  [470, 64],
  [0, 0],
]);

assert(
  visualStructureMatchPercent(taperedSweepSketch, sameSweepRoute) >= 95,
  "identical art and route should keep a high visual-structure score",
);
assert(
  visualStructureMatchPercent(taperedSweepSketch, collapsedSweepRoute) < 70,
  "a collapsed line should not pass as the same visual structure as a tapered mark",
);
assert(
  routeShapeMatchPercent(taperedSweepSketch, collapsedSweepRoute) <
    routeShapeMatchPercent(taperedSweepSketch, sameSweepRoute),
  "shape match should blend visual structure with line proximity",
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
  [0, 3, 4],
  "route geometry score should lead, with vision order as a light tie-breaker before diversity",
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
  "a visibly stronger runnable route should beat a weaker vision-first route",
);

const readableStarCandidates: AutoFindPickSelectionCandidate[] = [
  {
    placement: { center: [40.72, -73.99], scale: 1.6, rotationDeg: 0 },
    qualityScore: 79,
    shapeMatchScore: 64,
    distanceKm: 11.8,
  },
  {
    placement: { center: [40.735, -73.985], scale: 0.9, rotationDeg: 60 },
    qualityScore: 47,
    shapeMatchScore: 72,
    distanceKm: 7.9,
  },
];

assert.deepEqual(
  selectDiverseAutoFindPickIndices(readableStarCandidates, 2, [1, 0]),
  [0, 1],
  "a modest shape advantage should not beat a much cleaner route after snapping",
);

const badVisionFavorite: AutoFindPickSelectionCandidate[] = [
  {
    placement: { center: [40.72, -73.99], scale: 1, rotationDeg: 0 },
    qualityScore: 22,
    shapeMatchScore: 74,
    distanceKm: 39,
  },
  {
    placement: { center: [40.73, -74.0], scale: 0.95, rotationDeg: 6 },
    qualityScore: 72,
    shapeMatchScore: 70,
    distanceKm: 9,
  },
];

assert.deepEqual(
  selectDiverseAutoFindPickIndices(badVisionFavorite, 2, [0, 1]),
  [1, 0],
  "vision cannot promote a long low-clean route over a clean runnable one",
);

assert.equal(
  isDisplayWorthyAutoFindCandidate(badVisionFavorite[0]!),
  false,
  "long low-clean wordmark tangles should not be shown as viable top picks",
);
assert.equal(
  isDisplayWorthyAutoFindCandidate(badVisionFavorite[1]!),
  true,
  "clean medium-distance candidates should remain displayable",
);

// --- lettering uploads must reach the block-letter route ------------------
// The best Nike result this project has produced was "JUST DO IT" typeset as
// giant block letters across 14th-54th St. It became unreachable because the
// wordmark path only fired when the shape hint was exactly "letter" (a
// symbol-plus-slogan lockup never is), so those uploads fell through to
// tracing and produced scribble.
assert.equal(
  visionDescribesLettering([
    { label: "Swoosh + slogan", description: "a checkmark above block letters reading JUST DO IT" },
  ]),
  true,
  "a lockup described as having block letters is wordmark-eligible",
);
assert.equal(
  visionDescribesLettering([
    { label: "Tiger", description: "a big cat with dense stripe texture and a curved tail" },
  ]),
  false,
  "an ordinary picture is not mistaken for a wordmark",
);
assert.equal(
  visionDescribesLettering([]),
  false,
  "no drafts means no lettering claim",
);

// --- absolute display floor: the "never show a scribble" rule -------------
assert.equal(
  meetsAbsoluteDisplayFloor(badVisionFavorite[1]!),
  true,
  "a clean, well-matched route clears the absolute floor",
);
assert.equal(
  meetsAbsoluteDisplayFloor({
    placement: { center: [40.75, -73.98], scale: 1, rotationDeg: 0 },
    qualityScore: 40,
    shapeMatchScore: 12,
    distanceKm: 9,
  }),
  false,
  "a route that no longer resembles the artwork is never shown, even as a fallback",
);
assert.equal(
  meetsAbsoluteDisplayFloor({
    placement: { center: [40.75, -73.98], scale: 1, rotationDeg: 0 },
    qualityScore: 8,
    shapeMatchScore: 65,
    distanceKm: 9,
  }),
  false,
  "a retraced/jittery tangle is never shown, even as a fallback",
);
assert.equal(
  meetsAbsoluteDisplayFloor({
    placement: { center: [40.75, -73.98], scale: 1, rotationDeg: 0 },
    qualityScore: 60,
    shapeMatchScore: 60,
    distanceKm: 41,
  }),
  false,
  "an unrunnable sprawl is never shown, even as a fallback",
);
assert.equal(
  meetsAbsoluteDisplayFloor({
    placement: { center: [40.75, -73.98], scale: 1, rotationDeg: 0 },
    qualityScore: 30,
    shapeMatchScore: 42,
    distanceKm: 12,
  }),
  true,
  "the floor stays well below the normal bar — imperfect but readable routes still show",
);

assert.equal(
  finalRouteTruthVerdict({
    placement: { center: [40.73, -74], scale: 1, rotationDeg: 0 },
    kind: "street-design",
    qualityScore: 82,
    shapeMatchScore: 76,
    sourceMatchScore: 26,
    distanceKm: 8,
  }).ok,
  true,
  "sketch-led street routes should pass on etch-a-sketch readability, not pixel faithfulness to the upload",
);

assert.equal(
  finalRouteTruthVerdict(
    {
      placement: { center: [40.73, -74], scale: 1, rotationDeg: 0 },
      kind: "street-wordmark",
      qualityScore: 64,
      shapeMatchScore: 72,
      sourceMatchScore: 56,
      distanceKm: 9,
    },
    { shapeClass: "letter", rotationStrategy: "upright", scaleHint: "medium", reason: "wordmark" },
    ["letters", "reading order", "baseline"],
  ).ok,
  true,
  "a readable snapped word route can pass when it clears both shape and source-art floors",
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
      description: "usable but full of tiny jitter",
      // Dense smooth curves are now rewarded (curve sampling for the lattice
      // compiler); what must still rank below a clean icon is JITTER — tiny
      // segments with sharp alternating turns.
      points: Array.from({ length: 100 }, (_, i) => {
        const t = i / 99;
        return {
          x: 0.1 + 0.8 * t + (i % 2 === 0 ? 0.006 : -0.006),
          y: 0.2 + 0.6 * t + (i % 2 === 0 ? -0.008 : 0.008),
        };
      }),
    },
    {
      label: "Icon first",
      description: "street-grid icon",
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
  "Icon first",
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

const blockLoopRepresentative = cleanVisionDesignDrafts({
  drafts: [
    {
      label: "Weak pump trace",
      description: "gas pump, hose, person, and small display but collapsed into tiny detail",
      visualFeatures: ["block", "window", "hose", "head", "legs"],
      points: [
        { x: 0.48, y: 0.48 },
        { x: 0.49, y: 0.48 },
        { x: 0.49, y: 0.49 },
        { x: 0.48, y: 0.49 },
      ],
    },
  ],
});
assert.equal(
  blockLoopRepresentative[0]?.label,
  "Representative gas pump + person logo",
  "gas pump/person uploads should get a dedicated pump-hose-figure representative first",
);
assert(
  !blockLoopRepresentative.some((d) => d.label === "Representative block + loop icon"),
  "gas pump/person uploads should not fall back to generic block/loop routes that lose the person",
);
assert(
  !blockLoopRepresentative.some((d) => d.label === "Representative block + figure icon"),
  "gas pump/person uploads should not fall back to generic block/figure routes that lose the hose",
);

const phoneRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Phone charger icon",
    description: "device rectangle with screen and cable loop",
    visualFeatures: ["device", "screen", "cable"],
  },
]);
assert(
  phoneRepresentative.some((d) => d.label === "Representative block + loop icon"),
  "the same generic block/loop primitive should work for non-gas uploads",
);

assert.deepEqual(
  deriveRequiredVisualFeatures([
    {
      label: "Balanced logo route",
      description: "preserve the important features",
      visualFeatures: ["pump", "hose loop", "headphones", "body", "legs"],
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
      designScore: 100,
    },
  ]),
  ["pump", "hose loop", "headphones", "body", "legs"],
  "required feature checklist should come from the uploaded art's visualFeatures",
);

assert.deepEqual(
  deriveRequiredVisualFeatures([
    {
      label: "Sweeping mark",
      description: "street-ready route",
      visualFeatures: ["swoosh", "curve", "rising tail"],
      points: [
        { x: 0.1, y: 0.8 },
        { x: 0.9, y: 0.2 },
      ],
      designScore: 100,
    },
  ]),
  ["swoosh", "curve", "rising tail"],
  "required feature checklist should also work for non-object abstract marks",
);

assert.deepEqual(
  deriveRequiredVisualFeatures([
    {
      label: "Representative star icon",
      description: "five point star",
      visualFeatures: ["star", "five points", "sharp tips", "inner crossings"],
      points: [
        { x: 0.1, y: 0.8 },
        { x: 0.9, y: 0.2 },
      ],
      designScore: 104,
    },
    {
      label: "Top-heavy star alternative",
      description: "alternate star variant",
      visualFeatures: ["top heavy", "wide fat", "inner pentagon"],
      points: [
        { x: 0.1, y: 0.8 },
        { x: 0.9, y: 0.2 },
      ],
      designScore: 100,
    },
    {
      label: "Stair-step block star",
      description: "another alternate star variant",
      points: [
        { x: 0.1, y: 0.8 },
        { x: 0.9, y: 0.2 },
      ],
      designScore: 100,
    },
  ]),
  ["star", "five points", "sharp tips", "inner crossings"],
  "required features should not turn every alternate draft label into an impossible checklist",
);

assert.equal(
  requiredFeatureCoverageScore(
    "Street-native sweeping mark. Features: swoosh, curve, rising tail.",
    ["swoosh", "curve", "rising tail"],
  ),
  100,
  "feature coverage should reward candidates that preserve the uploaded art checklist",
);
assert.equal(
  requiredFeatureCoverageScore("clean rounded route with nice blocks", [
    "swoosh",
    "curve",
    "rising tail",
  ]),
  0,
  "feature coverage should not pass clean-but-wrong generic routes",
);
assert(
  requiredFeatureCoverageScore(
    "solid Manhattan grid placement, clear five-point star silhouette with sharp tips",
    ["classic star outline", "five points", "sharp tips", "inner crossings"],
  ) >= 50,
  "feature coverage should accept natural wording such as five-point star for required star features",
);
assert(
  requiredFeatureCoverageScore(
    "walkable midtown corridor; LAUREN letterforms readable left-to-right",
    ["letters", "reading order", "bridges"],
  ) >= 33,
  "feature coverage should accept natural wordmark language such as letterforms and left-to-right readability",
);
assert(
  requiredFeatureCoverageScore("all on Manhattan streets, recognizable LAUREN wordmark", [
    "letters",
    "reading order",
    "bridges",
  ]) >= 33,
  "feature coverage should treat visible wordmark language as a letter-route match",
);
assert(
  requiredFeatureCoverageScore(
    "clear left-hump and right-hump with bottom-point on Manhattan streets",
    ["heart", "left lobe", "right lobe", "bottom point", "center dip"],
  ) >= 40,
  "feature coverage should accept heart wording such as humps for lobes",
);
assert.equal(
  inferWordmarkTextFromSourceName("lauren.svg"),
  "LAUREN",
  "wordmark uploads should be able to use a clean filename as a weak text hint",
);
assert.equal(
  inferWordmarkTextFromSourceName("pace-logo-final.png"),
  "PACE",
  "wordmark filename hints should ignore generic logo/final words",
);

const gasStructureCandidates = generateMapNativeCandidates({
  drafts: blockLoopRepresentative,
  preset: MANHATTAN_PRESET,
  targetDistanceKm: 10,
});
const gasStructureCandidate = gasStructureCandidates.find((candidate) =>
  candidate.designIntent.includes("Human-grade Manhattan gas logo") ||
  candidate.designIntent.includes("Representative gas pump + person logo"),
);
assert(gasStructureCandidate, "gas representative should produce map-native candidates");
assert(
  gasPumpPersonStructureScore(
    gasStructureCandidate.anchors,
    gasStructureCandidate.placement,
  ) >= 62,
  "dedicated gas representative should pass the pump/hose/person structure gate",
);
assert.equal(
  hasCompleteGasPumpPersonText("bold gas pump block with hose loop to nozzle"),
  false,
  "semantic gate should reject pump/hose descriptions that lose the person",
);
assert.equal(
  hasCompleteGasPumpPersonText(
    "clear gas pump body with hose loop and headphone person legs",
  ),
  true,
  "semantic gate should accept descriptions that preserve pump, hose, and person",
);

const gasOnlyFiltered = cleanVisionDesignDrafts({
  drafts: [
    {
      label: "Pump only",
      description: "gas pump block with display window",
      visualFeatures: ["gas", "pump", "window"],
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.1, y: 0.9 },
        { x: 0.45, y: 0.9 },
        { x: 0.45, y: 0.1 },
        { x: 0.1, y: 0.1 },
      ],
    },
    {
      label: "Complete gas mark",
      description: "gas pump with hose loop and person figure",
      visualFeatures: ["gas", "pump", "hose", "person"],
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.1, y: 0.8 },
        { x: 0.4, y: 0.8 },
        { x: 0.52, y: 0.55 },
        { x: 0.66, y: 0.88 },
        { x: 0.86, y: 0.55 },
        { x: 0.76, y: 0.2 },
        { x: 0.9, y: 0.3 },
      ],
    },
  ],
});
assert(
  !gasOnlyFiltered.some((draft) => draft.label === "Pump only"),
  "gas-logo pools should filter pump-only drafts when hose/person are required",
);
assert(
  gasOnlyFiltered.some((draft) => draft.label === "Representative gas pump + person logo"),
  "gas-logo pools should keep the complete representative structure",
);

const starIconRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Star as block letter icon",
    description: "geometric star icon with five points",
    visualFeatures: ["star", "points", "icon"],
  },
]);
assert(
  !starIconRepresentative.some((d) => d.label === "Representative STAR wordmark"),
  "a labeled icon should not become a wordmark unless the subject is actual text",
);
assert.equal(
  starIconRepresentative[0]?.label,
  "Representative star icon",
  "star/geometric uploads should get a sharp star representative, not generic outline leftovers",
);
assert(
  !starIconRepresentative.some((d) => d.label === "Representative block + figure icon"),
  "star/geometric uploads should not inject generic block-plus-figure fallbacks",
);

const sweepingStarRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Wide star icon",
    description: "five-point star with sweeping arms and sharp tips",
    visualFeatures: ["star", "five points", "sweeping arms"],
  },
]);
assert.equal(
  sweepingStarRepresentative[0]?.label,
  "Representative star icon",
  "star uploads with sweeping arms should still prefer the star representative",
);
assert(
  !sweepingStarRepresentative.some((d) => d.label === "Representative swoosh mark"),
  "star uploads should not also inject a swoosh representative",
);

const heartRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Heart icon",
    description: "rounded heart with two lobes, curve, and bottom point",
    visualFeatures: ["heart", "lobes", "curve", "bottom point"],
  },
]);
assert.equal(
  heartRepresentative[0]?.label,
  "Representative heart icon",
  "heart uploads should get a dedicated heart representative before generic routes",
);
assert(
  !heartRepresentative.some((d) => d.label === "Representative swoosh mark"),
  "generic heart curves should not be misread as swoosh/checkmark marks",
);
assert(
  !heartRepresentative.some((d) => d.label === "Representative star icon"),
  "heart bottom points should not be misread as star tips",
);

const swooshRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Nike swoosh style logo",
    description: "sweeping checkmark wing mark with a rising tail",
    visualFeatures: ["swoosh", "curve", "wing"],
  },
]);
assert.equal(
  swooshRepresentative[0]?.label,
  "Representative swoosh mark",
  "swoosh/checkmark logos should get a dedicated sweeping-mark representative",
);

const pointedSwooshRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Pointed Nike swoosh",
    description: "swoosh with sharp pointed tip and sweeping belly",
    visualFeatures: ["swoosh", "pointed tip", "rising tail"],
  },
]);
assert.equal(
  pointedSwooshRepresentative[0]?.label,
  "Representative swoosh mark",
  "pointed swoosh tips should not turn a swoosh into a star",
);
assert(
  !pointedSwooshRepresentative.some((d) => d.label === "Representative star icon"),
  "swoosh/checkmark uploads should not inject a star representative",
);

const boltRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Lightning bolt icon",
    description: "sharp zigzag thunderbolt with a pointed top and bottom",
    visualFeatures: ["lightning", "zigzag", "pointed"],
  },
]);
assert.equal(
  boltRepresentative[0]?.label,
  "Representative lightning bolt icon",
  "lightning/bolt uploads should get a dedicated zigzag representative",
);
assert(
  !boltRepresentative.some((d) => d.label === "Representative star icon"),
  "bolt points should not be misread as star tips",
);
assert(
  !boltRepresentative.some((d) => d.label === "Representative swoosh mark"),
  "bolt diagonals should not become generic swooshes",
);

const arrowRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Arrow direction icon",
    description: "long shaft and triangular arrow head pointing right",
    visualFeatures: ["arrow", "shaft", "head"],
  },
]);
assert.equal(
  arrowRepresentative[0]?.label,
  "Representative arrow icon",
  "arrow uploads should preserve shaft-plus-head structure",
);

const crownRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Crown icon",
    description: "royal crown with base and three peaks",
    visualFeatures: ["crown", "base", "peaks"],
  },
]);
assert.equal(
  crownRepresentative[0]?.label,
  "Representative crown icon",
  "crown uploads should get a crown representative instead of a generic zigzag",
);

const waveRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Sine wave icon",
    description: "wavy line with two alternating bends",
    visualFeatures: ["wave", "curve", "flow"],
  },
]);
assert.equal(
  waveRepresentative[0]?.label,
  "Representative wave icon",
  "wave uploads should get a dedicated two-bend representative",
);
assert(
  !waveRepresentative.some((d) => d.label === "Representative crown icon"),
  "wave peaks/valleys should not be misread as a crown",
);
assert(
  !waveRepresentative.some((d) => d.label === "Representative lightning bolt icon"),
  "wavy/zigzag language should not override explicit wave detection",
);

const shieldRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Shield badge",
    description: "shield silhouette with broad shoulders and bottom point",
    visualFeatures: ["shield", "badge", "pointed bottom"],
  },
]);
assert.equal(
  shieldRepresentative[0]?.label,
  "Representative shield icon",
  "shield/badge uploads should not be stolen by the star representative",
);
assert(
  !shieldRepresentative.some((d) => d.label === "Representative star icon"),
  "shield bottom points should not be treated as star tips",
);

const diamondRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Diamond gem icon",
    description: "diamond outline with four corners and center cross",
    visualFeatures: ["diamond", "gem", "corners"],
  },
]);
assert.equal(
  diamondRepresentative[0]?.label,
  "Representative diamond icon",
  "diamond/gem uploads should preserve the closed four-corner family",
);
assert(
  !diamondRepresentative.some((d) => d.label === "Representative arrow icon"),
  "diamond corners should not become arrowheads",
);

const houseRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "House icon",
    description: "home with roof, walls, base, and front door",
    visualFeatures: ["house", "roof", "door"],
  },
]);
assert.equal(
  houseRepresentative[0]?.label,
  "Representative house icon",
  "house/building uploads should use the roof-and-walls representative",
);

const flowerRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Shamrock flower",
    description: "clover flower with lobes, petals, and stem",
    visualFeatures: ["flower", "petals", "stem"],
  },
]);
assert.equal(
  flowerRepresentative[0]?.label,
  "Representative flower icon",
  "flower/clover uploads should not collapse into a heart just because they have lobes",
);
assert(
  !flowerRepresentative.some((d) => d.label === "Representative heart icon"),
  "petal lobes should not trigger the heart representative",
);

const swooshStreetNative = cityGridSketchCandidates(
  swooshRepresentative,
  MANHATTAN_PRESET,
  8,
);
assert(
  swooshStreetNative.length > 0,
  "swoosh/checkmark representatives should produce city-grid candidates",
);
assert(
  swooshStreetNative.some((candidate) =>
    candidate.designIntent.includes("Representative swoosh mark"),
  ),
  "swoosh candidates should preserve their route intent instead of becoming generic icons",
);
assert(
  swooshStreetNative.some((candidate) =>
    candidate.designIntent.includes("Human-grade Manhattan open sweep"),
  ),
  "tapered swoosh representatives should include simple open-sweep routes for street readability",
);
assert(
  swooshStreetNative.some((candidate) =>
    candidate.designIntent.includes("Human-grade Manhattan tapered swoosh outline"),
  ),
  "swoosh/checkmark representatives should include tapered outline routes, not only centerlines",
);
const strongestSwooshSweep = swooshStreetNative.find((candidate) =>
  candidate.designIntent.includes("Human-grade Manhattan tapered swoosh outline"),
);
assert(strongestSwooshSweep, "swoosh candidates should include a direct tapered outline");
assert(
  Math.max(
    ...swooshStreetNative
      .filter((candidate) =>
        candidate.designIntent.includes("Human-grade Manhattan tapered swoosh outline"),
      )
      .map((candidate) =>
        sweepVisualStructureScore(candidate.anchors, candidate.placement),
      ),
  ) >= 34,
  "generic sweep structure gate should accept street-realistic tapered outline candidates",
);
assert(
  sweepVisualStructureScore(
    [
      [40.735, -73.99],
      [40.765, -73.99],
    ],
    { center: [40.75, -73.99], rotationDeg: 90, scale: 1 },
  ) < 18,
  "generic sweep structure gate should reject plain vertical-line impostors",
);

const boltStreetNative = cityGridSketchCandidates(
  boltRepresentative,
  MANHATTAN_PRESET,
  8,
);
assert(
  boltStreetNative.some((candidate) =>
    candidate.designIntent.includes("Human-grade Manhattan lightning bolt"),
  ),
  "bolt representatives should include direct Manhattan zigzag candidates before generic snapping",
);
assert(
  !boltStreetNative.some((candidate) =>
    candidate.designIntent.includes("Human-grade Manhattan tapered swoosh outline"),
  ),
  "bolt representatives should not borrow swoosh-specific helpers",
);

const cometTailStreetNative = cityGridSketchCandidates(
  [
    {
      label: "Comet tail mark",
      description: "wide abstract curve with a rising tail and diagonal sweep",
      visualFeatures: ["curve", "rising tail", "diagonal sweep"],
      points: [
        { x: 0.05, y: 0.7 },
        { x: 0.32, y: 0.72 },
        { x: 0.58, y: 0.52 },
        { x: 0.92, y: 0.14 },
      ],
      designScore: 96,
    },
  ],
  MANHATTAN_PRESET,
  8,
);
assert(
  cometTailStreetNative.some((candidate) =>
    /(?:Ribbon|Street|Broad) sweep Comet tail mark/.test(candidate.designIntent),
  ),
  "curve/tail marks should get generic street-sweep candidates, not only named swoosh helpers",
);
assert(
  cometTailStreetNative.some((candidate) =>
    candidate.designIntent.includes("Human-grade Manhattan open sweep"),
  ),
  "curve/tail marks should get direct Manhattan open-sweep candidates before snapping",
);
assert(
  cometTailStreetNative.some((candidate) => candidate.km >= 5 && candidate.km <= 13),
  "generic street-sweep candidates should land in a runnable distance band",
);

const starRouteLibrary = manhattanRouteLibraryCandidates(
  [
    {
      label: "Representative star icon",
      description: "five-point icon reduced to strong connected strokes",
      visualFeatures: ["star", "five points", "sharp tips"],
      points: [
        { x: 0.5, y: 0.05 },
        { x: 0.62, y: 0.38 },
        { x: 0.96, y: 0.38 },
        { x: 0.68, y: 0.58 },
        { x: 0.8, y: 0.92 },
        { x: 0.5, y: 0.7 },
        { x: 0.2, y: 0.92 },
        { x: 0.32, y: 0.58 },
        { x: 0.04, y: 0.38 },
        { x: 0.38, y: 0.38 },
        { x: 0.5, y: 0.05 },
      ],
      designScore: 95,
    },
  ],
  MANHATTAN_PRESET,
  8,
);
assert(
  starRouteLibrary.some((candidate) =>
    candidate.designIntent.includes("Route-library Manhattan midtown five-point star"),
  ),
  "star uploads should get a curated Manhattan route-library star before generic tracing",
);
assert(
  starRouteLibrary.some((candidate) => candidate.km >= 5 && candidate.km <= 15),
  "route-library stars should be in a plausible running distance band",
);

const swooshRouteLibrary = manhattanRouteLibraryCandidates(
  swooshRepresentative,
  MANHATTAN_PRESET,
  8,
);
assert(
  swooshRouteLibrary.some((candidate) =>
    candidate.designIntent.includes("Route-library Manhattan west-side tapered sweep"),
  ),
  "swoosh uploads should get a curated Manhattan tapered sweep candidate",
);
assert(
  swooshRouteLibrary.every((candidate) => candidate.kind === "street-design"),
  "route-library candidates should enter the same street-design pool as other map-native routes",
);

const boltRouteLibrary = manhattanRouteLibraryCandidates(
  boltRepresentative,
  MANHATTAN_PRESET,
  8,
);
assert(
  boltRouteLibrary.some((candidate) =>
    candidate.designIntent.includes("Route-library Manhattan downtown lightning bolt"),
  ),
  "bolt uploads should get a curated Manhattan lightning candidate",
);

const loveRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "LOVE wordmark",
    description: "four letters, preserve reading order",
  },
]);
assert.equal(
  loveRepresentative[0]?.label,
  "Representative LOVE wordmark",
  "LOVE/letter detections should inject a reading-order wordmark template",
);

for (const word of ["ACME", "PACE", "NOVA"]) {
  const representative = addRepresentativeDesignDrafts([], [
    {
      label: `${word} Block Clean`,
      description: "block letters with loops, crossbars, and a letter leg",
      visualFeatures: ["letters", "block strokes", "loops", "leg"],
    },
  ]);
  assert(
    representative.some((d) => d.label === `Representative ${word} wordmark`),
    "named wordmarks should preserve the actual word instead of using a generic connected-letter draft",
  );
  assert(
    !representative.some((d) => d.label === "Representative block + loop icon"),
    "letter block/loop words must not inject object-logo block+loop templates",
  );
  assert(
    !representative.some((d) => d.label === "Representative block + figure icon"),
    "letter legs must not inject object-plus-figure templates",
  );
}

const recoveredNamedDrafts = recoverLooseVisionDesignDrafts(`{
  "label": "ACME wordmark",
  "drafts": [
    {
      "label": "Bold block letters",
      "description": "Each letter is a clean street-ready block; five block letters with R and P loops and an R leg",
      "visualFeatures": ["letters", "block strokes", "loops", "leg"],
      "points": [
        {"x": 0.04, "y": 0.2}, {"x": 0.04, "y": 0.8},
        {"x": 0.14, "y": 0.2}, {"x": 0.14, "y": 0.5},
        {"x": 0.04, "y": 0.5}, {"x": 0.14, "y": 0.8},
        {"x": 0.22, "y": 0.8}, {"x": 0.28, "y": 0.2},
        {"x": 0.34, "y": 0.8}, {"x": 0.42, "y": 0.8},
        {"x": 0.42, "y": 0.2}, {"x": 0.52, "y": 0.2},
        {"x": 0.52, "y": 0.8}, {"x": 0.62, "y": 0.2},
        {"x": 0.62, "y": 0.8}, {"x": 0.72, "y": 0.2},
        {"x": 0.72, "y": 0.8}
      ]
    }
  ],
  "unfinished":`);
assert.equal(
  recoveredNamedDrafts[0]?.label,
  "Representative ACME wordmark",
  "malformed vision-design responses should still recover the named wordmark representative",
);

const recoveredFeatureHeavyWordmark = addRepresentativeDesignDrafts([], [
  {
    label: "Clean block letters",
    description: "Each letter uses strong crossbars.",
    visualFeatures: ["crossbar", "verticalStroke", "crossbar"],
  },
  {
    label: "Aggressive simple PACE",
    description: "Simple word route.",
    visualFeatures: ["crossbar", "bowl", "stroke"],
  },
]);
assert.equal(
  recoveredFeatureHeavyWordmark[0]?.label,
  "Representative PACE wordmark",
  "wordmark naming should prefer labels/subjects over repeated visual feature words",
);

const topLevelNamedWordmark = cleanVisionDesignDrafts({
  label: "NOVA wordmark",
  description: "Five bold uppercase letters.",
  drafts: [
    {
      label: "Aggressive minimal",
      description: "Simple word route.",
      visualFeatures: ["letters", "crossbar"],
      points: [
        { x: 0.05, y: 0.2 },
        { x: 0.05, y: 0.8 },
        { x: 0.2, y: 0.2 },
        { x: 0.2, y: 0.8 },
        { x: 0.35, y: 0.2 },
        { x: 0.35, y: 0.8 },
        { x: 0.5, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ],
    },
  ],
});
assert.equal(
  topLevelNamedWordmark[0]?.label,
  "Representative NOVA wordmark",
  "top-level vision-design labels should feed representative wordmark naming",
);

for (const word of ["ACME", "PACE", "NOVA", "LAUREN"]) {
  const streetNativeWord = streetWordmarkCandidates(
    word,
    MANHATTAN_PRESET,
    9,
  );
  assert(
    streetNativeWord.length > 0,
    "wordmarks should get Manhattan street-native candidate routes",
  );
  assert(
    streetNativeWord.every((c) =>
      c.designIntent?.startsWith(`Street-native ${word} wordmark`),
    ),
    "street-native wordmark candidates should carry a clear route intent",
  );
  assert(
    streetNativeWord.some((c) => c.km >= 5 && c.km <= 14),
    "street-native wordmark candidates should still offer a shorter, runnable option",
  );
  // The old ceiling here was 16 km, which is why uploaded wordmarks always
  // came out cramped: block letters need to be several blocks thick to read
  // from map altitude. The set now spans modest to billboard scale, and the
  // hard cap lives in mapNativeDesigner (MAX_WORDMARK_ROUTE_KM).
  assert(
    streetNativeWord.every((c) => c.km <= 56),
    "wordmark candidates stay inside the billboard-scale ceiling",
  );
  assert(
    streetNativeWord.some((c) => c.km >= 20),
    "wordmark candidates must include genuinely large versions, not only small ones",
  );
}

const ralphMonogram = streetMonogramCandidates("RALPH", MANHATTAN_PRESET, 9);
assert(
  ralphMonogram.length > 0,
  "wordmark uploads should get a large first-letter monogram fallback",
);
assert(
  ralphMonogram.some((c) => c.designIntent.includes("monogram (R)")),
  "monogram fallback should preserve the actual initial",
);
assert(
  ralphMonogram.every((c) => c.km >= 4 && c.km <= 14),
  "monogram routes should stay in a runnable and inspectable distance band",
);

const laurenMapNative = generateMapNativeCandidates({
  drafts: [
    {
      label: "Representative LAUREN wordmark",
      description: "letter-like contour that should not be treated as a generic icon",
      visualFeatures: ["letters", "reading order", "baseline"],
      points: [
        { x: 0.05, y: 0.2 },
        { x: 0.05, y: 0.8 },
        { x: 0.25, y: 0.8 },
        { x: 0.35, y: 0.2 },
        { x: 0.45, y: 0.8 },
        { x: 0.65, y: 0.2 },
        { x: 0.65, y: 0.8 },
      ],
      designScore: 105,
    },
  ],
  preset: MANHATTAN_PRESET,
  targetDistanceKm: 10,
  wordmarkText: "LAUREN",
});
assert(
  laurenMapNative.length > 0,
  "known wordmarks should produce direct wordmark candidates",
);
assert(
  laurenMapNative.every((c) => c.kind === "street-wordmark"),
  "known wordmarks must not fall back to generic contour sketches that can stack letters into icon-like boxes",
);
assert(
  !laurenMapNative.some((c) => /\bmonogram\b/i.test(c.designIntent)),
  "known wordmarks should not pass by showing only a first-letter monogram",
);
assert(
  laurenMapNative.every((c) => c.designIntent.includes("LAUREN")),
  "wordmark candidates should preserve the actual detected word",
);

const genericStreetNativeSketch = cityGridSketchCandidates(
  [
    {
      label: "Representative star icon",
      description: "five-point icon reduced to strong connected strokes",
      visualFeatures: ["points", "crossing", "icon"],
      points: [
        { x: 0.5, y: 0.05 },
        { x: 0.62, y: 0.38 },
        { x: 0.96, y: 0.38 },
        { x: 0.68, y: 0.58 },
        { x: 0.8, y: 0.92 },
        { x: 0.5, y: 0.7 },
        { x: 0.2, y: 0.92 },
        { x: 0.32, y: 0.58 },
        { x: 0.04, y: 0.38 },
        { x: 0.38, y: 0.38 },
        { x: 0.5, y: 0.05 },
      ],
      designScore: 95,
    },
  ],
  MANHATTAN_PRESET,
  8,
);
assert(
  genericStreetNativeSketch.length > 0,
  "non-word representative sketches should also get city-grid native candidates",
);
assert(
  genericStreetNativeSketch.every((c) => c.kind === "street-design"),
  "generic city-grid candidates should not be wordmark-only logic",
);

const denseStreetNativeSketch = cityGridSketchCandidates(
  [
    {
      label: "Representative dense icon",
      description: "many small outline points around a simple subject",
      visualFeatures: ["icon", "outline", "turns"],
      points: Array.from({ length: 28 }, (_, i) => {
        const t = (i / 27) * Math.PI * 2;
        const wobble = i % 2 === 0 ? 0.08 : -0.04;
        return {
          x: 0.5 + Math.cos(t) * (0.38 + wobble),
          y: 0.5 + Math.sin(t) * (0.32 - wobble),
        };
      }),
      designScore: 90,
    },
  ],
  MANHATTAN_PRESET,
  8,
);
assert(
  denseStreetNativeSketch.some((c) =>
    c.designIntent?.startsWith("Street-native Bold Representative dense icon"),
  ),
  "dense representative sketches should produce bold long-stroke city-grid variants",
);

const animalRepresentative = addRepresentativeDesignDrafts([], [
  {
    label: "Lion mascot",
    description: "animal silhouette with mane and legs",
  },
]);
assert.equal(
  animalRepresentative[0]?.label,
  "Representative animal silhouette",
  "lion/tiger/animal detections should inject a mascot silhouette template",
);

const approvedSketchContour = [
  { x: 0.18, y: 0.82 },
  { x: 0.18, y: 0.18 },
  { x: 0.46, y: 0.18 },
  { x: 0.46, y: 0.56 },
  { x: 0.62, y: 0.56 },
  { x: 0.74, y: 0.42 },
  { x: 0.68, y: 0.24 },
  { x: 0.82, y: 0.18 },
];
const visionWithShieldMislabel = [
  {
    label: "Representative shield",
    description: "shield crest outline",
    visualFeatures: ["shield", "crest", "emblem"],
    points: [{ x: 0.1, y: 0.1 }],
    designScore: 95,
  },
  {
    label: "Nike swoosh",
    description: "curved check mark",
    visualFeatures: ["swoosh", "curve", "check mark"],
    points: [{ x: 0.2, y: 0.5 }],
    designScore: 80,
  },
];
const merged = mergeVisionDesignDrafts(approvedSketchContour, visionWithShieldMislabel);
assert.equal(
  merged[0]?.label,
  "Your approved street sketch",
  "approved Step 1 sketch should lead vision design drafts",
);
assert(
  isSketchLedPlacementSearch(approvedSketchContour),
  "readable approved sketches should enable sketch-led placement search",
);
assert(
  !merged[0]?.visualFeatures?.includes("shield"),
  "approved sketch features should not inherit wrong representative shield tags",
);
assert(
  merged[0]?.visualFeatures?.some((f) => /swoosh|curve|check/.test(f)),
  "approved sketch should inherit real vision features when available",
);

assert.equal(
  usableTargetDistanceKm({
    shapeClass: "geometric",
    rotationStrategy: "upright",
    scaleHint: "compact",
    reason: "star logo",
  }),
  14,
  "geometric brand logos should default to a mid-length run distance",
);

assert.equal(inferGasLogoFromSourceName("gas.png"), true);
assert.equal(inferGasLogoFromSourceName("pace-logo.png"), false);
const gasDrafts = injectGasRepresentativeDrafts([], "gas.png");
assert(
  gasDrafts.some((d) => d.label === "Representative gas pump + person logo"),
  "gas.png uploads should inject the dedicated pump+person template",
);
const gasNative = generateMapNativeCandidates({
  drafts: gasDrafts,
  preset: MANHATTAN_PRESET,
  targetDistanceKm: 14,
});
assert(
  gasNative.some((c) => c.designIntent.includes("Human-grade Manhattan gas logo")),
  "gas logo drafts should produce direct-grid Manhattan gas icon candidates",
);
assert(
  isGasLogoDraftSet(gasDrafts),
  "gas representative drafts should be recognized as gas logo art",
);

assert.equal(inferSwooshFromSourceName("nike.png"), true);
assert.equal(inferSwooshFromSourceName("pace-logo.png"), false);
const swooshDrafts = injectSwooshRepresentativeDrafts([], "nike.png");
assert(
  swooshDrafts.some((d) => d.label === "Representative swoosh mark"),
  "nike uploads should inject the dedicated swoosh template",
);
const swooshFeatures = deriveRequiredVisualFeatures(swooshDrafts);
assert(
  swooshFeatures.some((feature) => /swoosh/.test(feature)),
  "swoosh source-name fallback should require swoosh visual features",
);
const sourceOnlySwooshSketch = buildApprovedSketchDraft(
  approvedSketchContour,
  swooshDrafts,
);
assert(
  sourceOnlySwooshSketch?.visualFeatures?.some((feature) => /swoosh/.test(feature)),
  "approved sketch should inherit source-name swoosh features when vision is unavailable",
);
const swooshNative = generateMapNativeCandidates({
  drafts: swooshDrafts,
  preset: MANHATTAN_PRESET,
  targetDistanceKm: 8,
});
assert(
  swooshNative.some((c) => /swoosh|checkmark|rising tail/i.test(c.designIntent)),
  "swoosh drafts should produce Manhattan sweep/check candidates",
);
console.log("autoFindTop5 tests ok");
