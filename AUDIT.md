# AUDIT — PaceCasso auto-find / snap / vision pipeline

Read-only audit, 2026-07-25. All quotes are verbatim from the working tree at commit
`64d1f892` (plus uncommitted modifications). Line numbers are from the current files
on disk. No code was modified.

There are **two** distinct "auto-find" systems in production:

- **A. `autoFindTop5`** (`lib/autoFindTop5.ts`, 5,703 lines) — the main top-5
  placement search: enumerate placements → sanity cull → diverse subsample →
  Mapbox-snap ~28 → composite image → one Claude vision call → ranked picks.
- **B. `traceShapeOnStreets`** (`lib/streetGraphTrace.ts`, 552 lines) — the
  "organic street trace" server path (`/api/street-trace`), which sweeps
  placements over a cached OSM street graph and traces the shape with A*.
  Its candidates are injected into A's pool via `requestStreetTraceCandidates`
  (`lib/autoFindTop5.ts:5255-5278`).

Both are covered below where relevant.

---

## 1. SEARCH BREADTH

### A. `autoFindTop5` — enumeration

Primary sweep, `lib/autoFindTop5.ts:414-454`:

```ts
function enumerateCandidates(
  contour: ContourPoint[],
  preset: CityPreset,
  hint: ShapeHint | null,
  anchorAround?: AutoFindTop5Options["anchorAround"],
  targetDistanceKm?: number,
): PlacementTransform[] {
  if (anchorAround) {
    return enumerateAroundAnchor(preset, anchorAround);
  }

  const b = preset.searchBounds;
  const latSpan = b.north - b.south - 2 * MARGIN;
  const lngSpan = b.east - b.west - 2 * MARGIN;
  const GRID = 5;
  ...
  const out: PlacementTransform[] = [];
  for (let li = 0; li < GRID; li++) {
    for (let gi = 0; gi < GRID; gi++) {
      const lat = b.south + MARGIN + (latSpan * (li + 0.5)) / GRID;
      const lng = b.west + MARGIN + (lngSpan * (gi + 0.5)) / GRID;
      for (const scale of scales) {
        for (const rotationDeg of rotations) {
          out.push({ center: [lat, lng], rotationDeg, scale });
        }
      }
    }
  }
  return out;
}
```

**Formula: 25 centers (5×5 grid) × |scales| × |rotations|.**

- `scales` (`scalesFromHint`, lines 182-195): 6 values for `compact`/`medium`/`sprawling`
  hints, **7** for no hint (`[0.6, 1.0, 1.6, 2.4, 3.4, 4.5, 5.5]`); or **5** values when a
  target distance is set (`scalesFromTargetDistance`, lines 241-243:
  `[0.85, 0.93, 1.0, 1.08, 1.15].map((m) => targetScale * m)`).
- `rotations` (`rotationsFromHint`, lines 361-412): 9+ values (see item 4).

Example concrete counts:
- No hint (flexible): 25 × 7 × 9 = **1,575** placements (more if PCA-aligned seeds add
  rotations).
- Letter hint on Manhattan (upright): 25 × 6 × ~12 = **~1,800**.

On top of that, the orchestrator (lines 5302-5330) adds parallel enumerations feeding
the same pool: `enumerateCityFocusPlacements` (≤ ~10-15 focus centers × scales ×
rotations, lines 536-573), `enumerateCityFirstHeartPlacements` (heart-only, Manhattan
only), `designDraftCandidates` (vision-drafted shapes, re-run through both
enumerators per draft, lines 906-952), lattice candidates, street-trace candidates,
and curated routes.

**Refine mode** (user already placed an anchor), `enumerateAroundAnchor`,
lines 809-850: 5×5 centers × 5 scales × 7 rotations = **875**:

```ts
  const latStep = 0.009;
  const lngStep = 0.011;
  const offsets = [-2, -1, 0, 1, 2];

  const scales = [0.7, 0.85, 1.0, 1.15, 1.3]
    .map((m) => anchor.scale * m)
    .map((s) => Math.max(0.3, Math.min(3.5, s)));

  const rotations = [-20, -10, -5, 0, 5, 10, 20].map(
    (d) => anchor.rotationDeg + d,
  );
```

### A. `autoFindTop5` — how many are actually EVALUATED

The thousands of enumerated placements are only checked geometrically
(`sanityFilter`, lines 877-904: perimeter within [3, 35] km and all anchor points
inside city bounds — no street data touched). The expensive evaluation (Mapbox
snap) is capped, `lib/autoFindTop5.ts:60-71`:

```ts
/**
 * Call budget: each snapped candidate costs roughly startVariantCount x
 * chunk-count Mapbox Directions calls plus one map-matching pass. 48
 * candidates x 4 variants blew straight past the 180/min API window and the
 * resulting 429s silently dropped candidates. 28 x 3 with wider batch gaps
 * fits the window; failures are now counted and surfaced to the user.
 */
const CANDIDATES_TO_SNAP = 28;
const SNAP_BATCH_SIZE = 4;
const SNAP_BATCH_GAP_MS = 250;
const SNAP_START_VARIANTS = 3;
```

Selection down to that budget is greedy farthest-point sampling
(`diverseSubsample`, lines 960-1007) split across per-class budgets
(lines 5373-5522), then sliced (lines 5553-5573):

```ts
  ].slice(
    0,
    Math.max(
      snapCount,
      lockupSubset.length +
        streetTracedSubset.length +
        latticeSubset.length +
        streetWordmarkSubset.length,
    ),
  );
```

so the snapped count is **28, or more if the pinned classes (lockup + street-traced
+ lattice + wordmark) alone exceed 28**.

Finally, only the first **20** snapped survivors are shown to the vision ranker
(lines 5618-5620):

```ts
  const rankableSnapped = needsSweepDesign
    ? prioritizeSweepRankable(snapped).slice(0, Math.min(snapped.length, 20))
    : snapped.slice(0, Math.min(snapped.length, 20));
```

**Net: ~1,500-2,000 placements enumerated → geometric cull → ~28 street-snapped →
20 vision-ranked → top 5 shown.**

### B. `traceShapeOnStreets` — sweep

`lib/streetGraphTrace.ts:460-481`:

```ts
  const scales = options.scales ?? [1400, 2000, 2700];
  const rots = options.rots ?? [0, 15, -15, 29];
  const cands: { center: LatLng; scale: number; rot: number; score: number }[] = [];
  const latMin = options.bounds?.latMin ?? 40.71;
  const latMax = options.bounds?.latMax ?? 40.792;
  const lngMin = options.bounds?.lngMin ?? -74.012;
  const lngMax = options.bounds?.lngMax ?? -73.938;
  for (let lat = latMin; lat <= latMax; lat += 0.008) {
    for (let lng = lngMin; lng <= lngMax; lng += 0.008) {
      for (const scale of scales) {
        for (const rot of rots) {
          const outline = place(unit, [lat, lng], scale, rot);
          const { score, miss } = coarseScore(g, outline);
          ...
          if (miss <= 2) cands.push({ center: [lat, lng], scale, rot, score });
        }
      }
    }
  }
```

With the defaults: 11 lat values × 10 lng values × 3 scales × 4 rotations =
**1,320 coarse placements**, of which only `topK + 2` (topK is clamped to ≤ 4, so
at most **6**) get the full A* trace (lines 484-495). Note the default bounds are
**hardcoded Manhattan coordinates** regardless of which city preset is active.

---

## 2. OBJECTIVE FUNCTION

There are two numeric ranking layers (plus the vision call, item 5). Neither
rasterizes anything — all numeric scoring is polyline geometry.

### Top-level combiner — `lib/autoFindTop5.ts:1342-1381`, quoted in full:

```ts
export function scoreAutoPlacementCandidate(
  qualityScore: number,
  shapeMatchScore: number,
): number {
  const clean = Math.max(0, Math.min(100, qualityScore));
  const shape = Math.max(0, Math.min(100, shapeMatchScore));
  return shape * 0.7 + clean * 0.3;
}

function candidateDistancePenalty(distanceKm: number | undefined): number {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return 0;
  // Runners target ~10–25 km for readable brand art; don't punish until past 25.
  if (distanceKm <= 25) return 0;
  if (distanceKm <= 32) return (distanceKm - 25) * 0.65;
  return 4.55 + (distanceKm - 32) * 1.5;
}

function candidateSelectionScore(
  candidate: AutoFindPickSelectionCandidate,
  preferredRank: number | undefined,
  preferredCount: number,
  preferredWeight: number,
): number {
  const base = scoreAutoPlacementCandidate(
    candidate.qualityScore,
    candidate.shapeMatchScore,
  );
  const clean = Math.max(0, Math.min(100, candidate.qualityScore));
  const cleanPenalty = clean < 30 ? (30 - clean) * 1.15 : 0;
  const visionBonus =
    preferredRank == null
      ? 0
      : preferredWeight * (1 - preferredRank / Math.max(1, preferredCount));
  return (
    base +
    visionBonus -
    cleanPenalty -
    candidateDistancePenalty(candidate.distanceKm)
  );
}
```

### `shapeMatchScore` — what it actually measures

Assigned per snapped candidate in `parallelSnap` (`lib/autoFindTop5.ts:2406-2428`)
via `blendedCandidateShapeMatch` → `routeShapeMatchPercent`
(`lib/autoFindTop5.ts:1202-1212`):

```ts
export function routeShapeMatchPercent(
  intended: [number, number][],
  actual: [number, number][],
): number {
  const proximity = interpretationMatchPercent(intended, actual);
  const structure = visualStructureMatchPercent(intended, actual);
  // Etch-a-sketch GPS art: gestalt and coarse silhouette beat pixel-tight fit.
  const blended = proximity * 0.42 + structure * 0.58;
  const cap = structure < 32 ? Math.min(blended, structure + 48) : blended;
  return Math.round(Math.max(0, Math.min(100, cap)));
}
```

**Component 1 — geometric distance.** `interpretationMatchPercent`
(`lib/shapeMatchScore.ts:136-166`) is a **mean bidirectional point-to-polyline
distance** (each anchor point → nearest point on route, and a ≤48-sample
subsampling of route points → nearest point on anchor, averaged;
`meanBidirectionalErrorMeters`, `lib/shapeMatchScore.ts:24-65`), evaluated at 8
Douglas-Peucker simplification levels, taking the best, mapped to 0-100 via
`100 * exp(-meanM / sensitivityM)` with sensitivities 94 m (multi-scale) / 68 m
(original). It is **not** Hausdorff, not Fréchet, not sum of squared error.

**Component 2 — scalar shape signature.** `visualStructureMatchPercent`
(`lib/autoFindTop5.ts:1169-1200`) compares six scalar features of each polyline —
log aspect ratio, closedness, path/chord ratio, significant-turn count,
turn strength, and an 8-bin edge-direction histogram — with fixed weights:

```ts
  const score =
    aspect * 0.16 +
    closed * 0.18 +
    pathRatio * 0.18 +
    turnCount * 0.17 +
    turnStrength * 0.13 +
    direction * 0.18;
```

**`qualityScore`** is `routeQualityScore` (`lib/routeQuality.ts:209-217`):

```ts
export function routeQualityScore(route: Waypoint[]): number {
  if (buildSegments(route).length < 1) return 0;
  const backtrack = doublingBackRatio(route);
  const jagged = jaggedTurnRatio(route);
  const protruding = protrudingDetourRatio(route);
  return Math.round(
    100 * Math.exp(-2.4 * backtrack - 1.6 * jagged - 2.1 * protruding),
  );
}
```

**Rasterization/image comparison in the numeric objective: NOT FOUND.** Routes
ARE rendered to images, but only for the Claude vision rank (item 5), which
produces an ordinal ranking folded in as `visionBonus` — not a similarity metric.

### B-path coarse score

`coarseScore` (`lib/streetGraphTrace.ts:349-387`) is also geometric: 72
curvature-weighted outline samples, each scored by distance to the nearest street
graph node (`acc += w[i] * Math.min(d, 300) + bendPenalty`, plus `miss * 40` for
samples with no street within 130 m). Final B-path ranking is
`meanDeviationM` — mean distance of traced chain points to the target outline
(lines 524-533, sorted at line 550).

---

## 3. SCALE

**One uniform scale factor. X and Y are never varied independently.**

`PlacementTransform` carries a single `scale: number`
(`lib/placementFromContour.ts:7`). It is applied identically to both axes,
`lib/placementFromContour.ts:87-111`:

```ts
  const baseSpanMeters = 2000;
  const maxDim = Math.max(width, height);
  const metersPerUnit = (baseSpanMeters * scale) / maxDim;
  ...
    const localX = dxNorm * metersPerUnit;
    const localY = -dyNorm * metersPerUnit;
```

Same in the B path, `lib/streetGraphTrace.ts:295-304` — a single `scaleM`
multiplies both rotated components:

```ts
function place(unit: UnitPoint[], center: LatLng, scaleM: number, rotDeg: number): LatLng[] {
  const r = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return unit.map(([x, y]) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return [center[0] + (ry * scaleM) / M_PER_LAT, center[1] + (rx * scaleM) / mPerLng(center[0])] as LatLng;
  });
}
```

Anisotropic (x/y-independent) scale sweep: **NOT FOUND** anywhere in either
search.

---

## 4. ROTATION

There is no continuous range/step sweep; rotations come from fixed arrays.
`rotationsFromHint`, `lib/autoFindTop5.ts:361-412`:

```ts
  if (hint?.rotationStrategy === "upright") {
    // Two "islands" of rotation: true-upright (±15° of 0°) AND the city grid
    // bearing closest to 0° (±10°). ...
    const set = new Set<number>([-15, -10, -5, 0, 5, 10, 15]);
    for (const g of bearings) {
      const gn = normalize(g);
      if (Math.abs(gn) > 45) continue; // skip perpendicular-to-upright
      set.add(normalize(gn - 10));
      set.add(normalize(gn - 5));
      set.add(gn);
      set.add(normalize(gn + 5));
      set.add(normalize(gn + 10));
    }
    return [...set].sort((a, b) => a - b);
  }

  if (hint?.rotationStrategy === "grid-aligned") {
    const set = new Set<number>([-5, 0, 5]);
    for (const g of bearings) {
      const gn = normalize(g);
      const perp = normalize(g + 90);
      for (const r of [gn, perp]) {
        set.add(normalize(r - 10));
        set.add(normalize(r - 5));
        set.add(r);
        set.add(normalize(r + 5));
        set.add(normalize(r + 10));
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  // flexible (or no hint): existing wide sweep + PCA-aligned seeds.
  const pca = principalAxisAngleDeg(contour);
  const pcaAligned =
    pca != null ? bearings.flatMap((g) => [g - pca, g - pca + 90]) : [];
  const base = [-90, -60, -30, -15, 0, 15, 30, 60, 90];
  return [...new Set([...base, ...pcaAligned.map(normalize)])];
```

So:
- **flexible / no hint**: `[-90, -60, -30, -15, 0, 15, 30, 60, 90]` — a ±90° range
  at 15-30° steps, plus PCA-derived seeds. **Rotations beyond ±90° (e.g. 135°,
  180°/upside-down) are never tried.**
- **upright**: −15°…+15° at 5° steps, plus grid-bearing ±10° at 5° steps.
- **grid-aligned**: each grid bearing and its perpendicular ±10° at 5° steps,
  plus {−5, 0, 5}.
- **refine mode** (line 826-828): `[-20, -10, -5, 0, 5, 10, 20]` around the user's
  rotation.
- **B path** (`streetGraphTrace.ts:461`): `[0, 15, -15, 29]` — four values, 29°
  being Manhattan's grid skew, applied to every city unless the caller overrides.

---

## 5. VISION LOOP

**FOUND — this is the production ranking mechanism**, not an experiment.

1. Each snapped candidate is rendered onto a real map tile via the Mapbox Static
   Images API (`loadRouteStaticMapImage`, called at `lib/autoFindTop5.ts:5622-5624`,
   built in `lib/mapboxStaticMap.ts`), falling back to a canvas outline render
   (`lib/renderRouteImage.ts`).
2. Up to 20 tiles are composited into one numbered PNG grid on a canvas —
   `buildCompositeGridDataUrl`, `lib/compositeRouteGrid.ts:35-95` (`canvas.toDataURL("image/png")`
   at line 87, number badges drawn at lines 74-82).
3. The grid plus the user's original upload are POSTed to `/api/vision-rank`
   (`visionRank`, `lib/autoFindTop5.ts:4605-4660`).
4. The server sends both images to Claude — `app/api/vision-rank/route.ts:209-251`:

```ts
    const message = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: grid } },
            { type: "image", source: { type: "base64", media_type: origType as ..., data: orig } },
            { type: "text", text: buildPrompt(...) },
          ],
        },
      ],
    });
```

   The prompt (lines 74-96) asks for geographic plausibility first, then "shape
   recognizability", returning `[{"id": N, "reason": "short phrase"}]`.
5. The returned ranking becomes `visionBonus` in `candidateSelectionScore`
   (item 2). It runs **once per auto-find invocation** ("single composite vision
   call to Claude", file header `lib/autoFindTop5.ts:1-8`) — it is a one-shot
   re-rank, not an iterative optimize-against-vision loop.

Other vision/LLM image judges in the repo:
- `/api/vision-hint` (`app/api/vision-hint/route.ts`) — classifies the upload
  (shape class / rotation strategy / scale hint) before enumeration.
- `/api/vision-design` (`app/api/vision-design/route.ts`) — generates design-draft
  contours from the upload.
- `/api/artist-loop` (`app/api/artist-loop/route.ts:43-45`: "Server-side artist
  loop: interpret the uploaded image → place at legible..."; comment at line 52:
  "Each run is many Anthropic calls") — the iterative draft/judge loop.
- `scripts/blind-squint-test.mjs` (offline harness): "Blind squint test — the ONLY
  valid judge of route recognizability. ... This shows a route to a different
  model with zero design context and asks what it depicts." Crops the render to
  the red route's bounding box (lines 24-40) and sends it to
  `claude-opus-4-8` by default.

---

## 6. ROUTING BACKEND

**Mapbox Directions v5, walking profile**, chunked, with an optional **Mapbox Map
Matching v5** refinement pass. No OSRM, no Valhalla (NOT FOUND — the only other
"routing" is the in-repo A* over a cached OSM graph in `lib/streetGraphTrace.ts`,
used by the street-trace path, and the lattice compiler).

Directions call — `lib/mapboxClient.ts:51-67`:

```ts
  const coordString = input.coordinates
    .map(([lat, lng]) => `${lng},${lat}`)
    .join(";");
  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordString}`,
  );
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", overview);
  url.searchParams.set("steps", input.steps ? "true" : "false");
  url.searchParams.set("alternatives", "false");
  if (input.language)
    url.searchParams.set("language", input.language);
  url.searchParams.set("access_token", token);
```

The server proxy (`app/api/mapbox/walking-directions/route.ts:88-97`) sets the
identical parameters. **`radiuses`, `approaches`, `bearings`, `exclude`,
`walking_speed`: NOT FOUND on any Directions call — there is no search-radius or
tolerance control on the snap.** The snap tolerance is whatever Mapbox's default
waypoint-snapping does.

Chunking — `lib/snapWalkingRoute.ts:466-478`:

```ts
export const SNAP_WALKING_CHUNK_SIZE = 20;
...
export const SNAP_WALKING_CHUNK_OVERLAP = 3;

const CHUNK_STRIDE = Math.max(
  2,
  CHUNK_SIZE - 1 - SNAP_WALKING_CHUNK_OVERLAP,
);
```

with gap-bridging between chunks (`CHUNK_JOIN_GAP_BRIDGE_M = 28`, line 481) via a
2-point Directions request (`fetchWalkingBridge`, lines 552-575).

Map Matching pass — the only place a radius exists,
`lib/snapWalkingRoute.ts:773-779` and `lib/mapboxClient.ts:99-109`:

```ts
    data = await fetchMapboxWalkingMatchingJson({
      coordinates: trace,
      tidy: false,
      radiusMeters: 30,
    });
```
```ts
  const radiusM = input.radiusMeters ?? 28;
  const url = new URL(
    `https://api.mapbox.com/matching/v5/mapbox/walking/${coordString}`,
  );
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "false");
  url.searchParams.set("tidy", input.tidy ? "true" : "false");
  url.searchParams.set(
    "radiuses",
    input.coordinates.map(() => String(radiusM)).join(";"),
  );
```

The matched route is adopted only if it beats the Directions result on
`interpretationMatchPercent` or has sufficient confidence
(`lib/snapWalkingRoute.ts:811-816`):

```ts
  const adopt =
    interpMatch >= interpDir + 2 ||
    (interpMatch >= interpDir - 1 && conf >= 0.38) ||
    (conf >= 0.55 && interpMatch >= 42);
```

Each auto-find candidate is snapped with up to `SNAP_START_VARIANTS = 3`
start/direction variants, the best kept by `match * 0.62 + clean * 0.38`
(`scoreSnappedVariant`, `lib/snapWalkingRoute.ts:887-895`).

The Step-4 editor uses its own single-leg 2-point Directions call
(`mapboxWalkingPolyline`, `components/Step4RouteEditor.tsx:39-53`, `steps: false,
overview: "full"`).

---

## 7. RETRACING

**A hard constraint forbidding street-segment reuse: NOT FOUND.** Out-and-backs
are not blocked anywhere. What exists is a *soft scoring penalty* and two
*post-hoc splicers*:

Soft penalty — `doublingBackRatio`, `lib/routeQuality.ts:79-114` (note the comment
saying it is deliberately soft):

```ts
/**
 * Estimates how much of a route retraces a nearby corridor in the opposite
 * direction. This is intentionally soft: out-and-back may be valid GPS art,
 * but auto-placement should prefer cleaner one-line interpretations when the
 * shape can read without retracing.
 */
export function doublingBackRatio(
  route: Waypoint[],
  options: { corridorMeters?: number; oppositeDot?: number } = {},
): number {
  ...
  const corridorMeters = options.corridorMeters ?? 28;
  const oppositeDot = options.oppositeDot ?? -0.72;
  ...
```

It feeds `routeQualityScore` as `exp(-2.4 * backtrack ...)` (lib/routeQuality.ts:215),
i.e. a fully doubled route still scores ~9/100 rather than being rejected.

Post-hoc splicers:
- `trimNubs` (`lib/streetGraphTrace.ts:268-288`): "Splice out short out-and-back
  excursions (dead-end spurs) that read as errors" — removes loops shorter than
  380 m that return within 34 m; explicitly disabled (`trimSpikes === false`) for
  full-sketch traces to preserve deliberate spikes (lines 258-262).
- `cleanupRouteSpurs` (`lib/routeSpurCleanup.ts`, applied at
  `lib/autoFindTop5.ts:2398-2400`) — same idea on snapped candidates.

Nothing in the Mapbox Directions requests (item 6) or the A* `corridorPath`
(`lib/streetGraphTrace.ts:110-166` — plain A* with a contour-distance cost term,
no visited-edge memory across legs) prevents a leg from traversing a street the
route already used.

---

## 8. EDIT RE-SNAP (Step 4)

All handlers in `components/Step4RouteEditor.tsx`. The gate is
`NEAR_LINE_SNAP_METERS = 60` (line 119).

**Single delete (`removeAt`, lines 1060-1128) — nothing re-snaps.** The two legs
around the deleted waypoint are merged locally:

```ts
      /**
       * Preserve the VISIBLE red line across a delete. If you're removing a
       * middle waypoint, legs (index-1) and (index) merge into one override
       * so the route doesn't snap back to a stale sequentialStreetLegs slice
       * (and doesn't need a Mapbox reroute that could produce a detour). If
       * you're removing the first or last waypoint, the tail simply drops.
       */
      ...
      if (index > 0 && index < wp.length - 1) {
        const leftLeg = legs[index - 1];
        const rightLeg = legs[index];
        if (leftLeg && rightLeg && leftLeg.length >= 2 && rightLeg.length >= 2) {
          newOv[index - 1] = {
            coords: mergeLegs(leftLeg, rightLeg),
            ...
```

**Bulk delete (`deleteSelectedWaypoints`, lines 1310-1351) — EVERY remaining leg
is re-fetched from Mapbox**, serially:

```ts
      const nL = ordered.length - 1;
      const ovs: (LegOverride | null)[] = [];
      for (let i = 0; i < nL; i++) {
        ovs.push(
          await mapboxWalkingPolylineWithRetry(ordered[i], ordered[i + 1]),
        );
      }
```

(single-item selections take the no-resnap path: `if (!bulk || ordered.length < 2)
{ commitWaypoints(ordered); ... return; }`, lines 1327-1332).

**Drag (`handleWaypointDragEnd`, lines 1353-1497):**
- Drop ≤ 60 m from an *adjacent* leg: waypoint snaps onto the line; the two
  adjacent legs are split/merged locally — no Mapbox (lines 1396-1460).
- Drop > 60 m: only the two adjacent legs are re-routed via Mapbox; "All
  non-adjacent legs are preserved from the previous overrides" (lines 1462-1494):

```ts
        if (index > 0) {
          const from = wp[index - 1];
          const to = wp[index];
          nextOv[index - 1] = await mapboxWalkingPolylineWithRetry(from, to);
        }
        if (index < wp.length - 1) {
          const from = wp[index];
          const to = wp[index + 1];
          nextOv[index] = await mapboxWalkingPolylineWithRetry(from, to);
        }
```

**Double-click insert (`handleMapDoubleClick`, lines 1130-1233):** ≤ 60 m from the
line → local leg split, no Mapbox; farther → the nearest waypoint's leg(s) are
re-routed through the click via Mapbox (lines 1218-1221).

**Failure mode:** if all 3 Mapbox retries fail, the leg becomes a straight
`greatCircleSpur` marked `isSpur: true` (lines 78-101) — i.e. an edited leg can
silently be a non-street straight line, surfaced via the spur warning and the
`resnapSpurLegs` button (line 1533).

---

## 9. REPO SIZE

Measured with `du -sk` on 2026-07-25 (Windows, Git Bash).

**Ten largest directories:**

| Directory | Size |
|---|---|
| `.git/` | 1,800,042 KB (~1.72 GB) |
| `node_modules/` | 562,384 KB (~537 MB) |
| `tmp-heart-qa/` | 333,500 KB |
| `tmp-route-art-benchmark/` | 304,719 KB |
| `tmp-semantic-exact-sneaker/` | 297,052 KB |
| `.next/` | 249,873 KB |
| `tmp-artist-city/` | 187,752 KB |
| `tmp-martini-tournament-20260724/` | 184,296 KB |
| `tmp-martini-dc-tournament-20260724/` | 167,192 KB |
| `tmp-lockup-probe/` | 115,909 KB |

**Source-only size** (excluding `node_modules`, `.next`, `.git`, `public/` (images),
all `tmp-*` experiment-artifact directories, and root-level screenshots):

| Component | Size |
|---|---|
| `scripts/` | 15,208 KB |
| `lib/` | 4,916 KB |
| `app/` | 2,033 KB |
| `components/` | 433 KB |
| `.codex/` | 276 KB |
| `e2e/`, `docs/`, `workers/`, `.github/`, `.claude/`, `.vercel/`, `test-results/` | ~39 KB |
| Root source/config files (`*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.json`, `*.md`, `*.txt`, `*.yml`; includes `package-lock.json` 320 KB and `tsconfig.tsbuildinfo` 232 KB) | 371 KB |
| **Total source** | **≈ 23.3 MB** |

Context the size question surfaces:
- **`tmp-*` directories total ≈ 3.06 GB** — more than 130× the source tree —
  sitting untracked in the working tree (60+ directories of experiment outputs:
  PNGs, OSM extracts, harness runs).
- Root of the repo holds ~35 MB of loose screenshots (`PIC1-3.png`, `TIGER.webp`,
  `AUDIT-SCORECARD.png`, `Ranks.png`, `FISH.png`, etc.).
- `.git` at 1.72 GB vs 23 MB of source means large binaries have been committed
  historically (UNCERTAIN which ones without `git rev-list --objects` analysis —
  not run, read-only time budget).

---

## THINGS I EXPECTED TO FIND AND DID NOT

1. **Any hard no-retrace / edge-reuse constraint** (item 7). Retracing is only a
   soft exponential penalty; the A* tracer has no cross-leg visited-edge memory.
2. **Independent x/y scaling or any affine/shear search.** One scalar `scale`
   everywhere. A shape that fits Manhattan's aspect only when stretched
   vertically can never be found by this sweep.
3. **Rotations beyond ±90° in the flexible sweep.** `base = [-90 … 90]` — 180°
   (upside-down-then-rejected-by-vision) placements are unreachable except via
   PCA seeds.
4. **A `radiuses`/tolerance parameter on the Directions snap.** Only the Map
   Matching refinement has a radius (28-30 m). The primary snap has no snapping
   tolerance control at all.
5. **A true optimization loop against the vision judge.** The Claude vision call
   is a one-shot re-rank of ≤ 20 pre-snapped candidates. Nothing iterates
   place → render → judge → adjust in production (the closest thing,
   `/api/artist-loop`, is a separate button-triggered flow; `blind-squint-test.mjs`
   is an offline harness).
6. **An image-based (rasterized) similarity metric in the numeric objective.**
   All numeric scoring is polyline geometry + scalar shape signatures. No IoU,
   no pixel overlap, no Hausdorff, no Fréchet.
7. **City-agnostic bounds in the street tracer.** `traceShapeOnStreets` defaults
   its placement window to hardcoded Manhattan coordinates
   (`lat 40.71-40.792, lng -74.012 … -73.938`, `lib/streetGraphTrace.ts:463-466`)
   even though the app offers five cities. Callers can override via
   `options.bounds`; whether every non-Manhattan call site does: UNCERTAIN (would
   need to trace all callers of `/api/street-trace`).
8. **Tests for the Step-4 edit handlers.** `components/*.tsx` has no unit tests
   (consistent with the repo's stated browser-only testing policy in CLAUDE.md,
   but the polyline split/merge math in Step4RouteEditor is pure geometry that
   could be tested and is not — `splitLegAt` / `mergeLegs` live inside the
   component).
9. **Cleanup or gitignore hygiene for the ~3 GB of `tmp-*` output and 35 MB of
   root screenshots** in the working tree; `git status` shows them untracked but
   present, and `.git` itself is 1.72 GB against a 23 MB source tree.
10. **Any cap on `enumerateCandidates` output before `sanityFilter`** — the
    enumeration size is purely emergent from the scale/rotation arrays; nothing
    asserts or logs the pre-cull candidate count.
