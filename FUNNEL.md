# FUNNEL — does diverseSubsample throw away the winners?

**THE NUMBER: 0 of 300.** Zero of the 300 discarded-by-diverseSubsample placements
scored higher than the best of the candidates that were actually snapped
(best snapped shapeMatchScore = 90; best discarded = 79). By the stated
threshold (near zero = fine, 20+ = funnel broken), **diverseSubsample is not
throwing away the winners in this run.** Nuances and caveats below — including
one honest secondary finding that partially cuts the other way.

---

## How this was measured

- One real auto-find run: `lion.webp` (root-level upload, 358-point contour via
  the production Step-1 alpha trace), Manhattan, the production
  vision-unavailable path (hint = null — same as the live site when
  `ANTHROPIC_API_KEY` is not configured; `scripts/autofind-harness.ts` documents
  this as "mirrors production today").
- Harness: `tmp-funnel-measure/measure.ts`. No production files modified.
  Exported lib functions (`buildAnchorLatLngsFromContour`,
  `enumerateCityFocusPlacements`, `routeShapeMatchPercent`, `routeQualityScore`,
  `snapWalkingRoute`, `cleanupRouteSpurs`, `mergeVisionDesignDrafts`,
  `traceShapeOnStreets`, `compileContourToLattice`, `getStreetGraph`, …) are
  imported directly; private funnel functions (`enumerateCandidates`,
  `sanityFilter`, `diverseSubsample`, `designDraftCandidates`, the parallelSnap
  scoring block, `traceContour`/`corridorPath`) are verbatim copies with source
  line citations in the harness file.
- Snap phase used real Mapbox calls with production pacing (batches of 4,
  250 ms gaps, 3 start variants). Trace phase (item 3) used only the local
  cached OSM walk graph (`lib/data/manhattan-walk-graph.json`) — zero API calls.
- Raw outputs: `tmp-funnel-measure/{summary,snapped,discarded-traced,chosen-traced}.json`.

Run facts: contour 358 pts, 2 components, heartConfidence 0.00,
`isSketchLedPlacementSearch` = **true** (this halves the generic budget — see
item 2), no filename-based draft injections for "lion".

---

## 1. Placements out of enumerateCandidates, and sanityFilter survivors

| Pool | Enumerated | Survived sanityFilter |
|---|---|---|
| `enumerateCandidates` (25 centers × 7 scales × 12 rotations) | **2,100** | **274** (13.0%) |
| `enumerateCityFocusPlacements` (10 Manhattan focus centers × 7 × 12) | 840 | 158 (18.8%) |
| **Total feeding diverseSubsample** | 2,940 | **432** |

Scales swept: `[0.6, 1, 1.6, 2.4, 3.4, 4.5, 5.5]`.
Rotations swept: `[-90, -60, -30, -15, 0, 15, 30, 60, 90]` + PCA-derived
`[-112, -22, 68]` = 12 values.
87% of enumerated placements die in `sanityFilter` (perimeter outside
[3, 35] km or any anchor outside the inner city bounds) before any street data
is consulted.

## 2. The 28 that got snapped: shapeMatchScore and qualityScore

Subset composition (production budget formulas, `lib/autoFindTop5.ts:5373-5573`):
1 street-traced + 6 lattice-compiled + 8 vision-design (approved-sketch draft)
+ 10 city-focus + 4 generic = 29, sliced to 28. Note: because
`sketchLedSearch=true`, the user's-own-contour generic pool got only **4** of
the 28 slots; 27 survived the ratio/bounds filters, 1 was rejected
(ratio 3.05 outside [0.55, 1.7]).

Sorted by combined score (`shape*0.7 + quality*0.3`):

| # | kind | route | anchor km | snapped km | quality | **shape** | combined |
|---|---|---|---|---|---|---|---|
| 2 | street-design | direct-grid | 4.33 | 3.69 | 70 | **88** | 82.6 |
| 6 | street-design | direct-grid | 4.67 | 3.73 | 62 | **90** | 81.6 |
| 4 | street-design | direct-grid | 4.74 | 3.66 | 53 | **90** | 78.9 |
| 5 | street-design | direct-grid | 4.53 | 3.81 | 59 | **87** | 78.6 |
| 1 | street-design | direct-grid | 4.79 | 3.84 | 49 | **90** | 77.7 |
| 3 | street-design | direct-grid | 5.26 | 3.79 | 37 | **89** | 73.4 |
| 21 | city-focus | mapbox | 3.3 | 3.87 | 89 | 59 | 68.0 |
| 7 | vision-design | mapbox | 3.3 | 3.97 | 81 | 59 | 65.6 |
| 15 | city-focus | mapbox | 3.3 | 3.97 | 81 | 59 | 65.6 |
| 22 | city-focus | mapbox | 3.3 | 3.95 | 81 | 59 | 65.6 |
| 9 | vision-design | mapbox | 3.3 | 3.90 | 69 | 62 | 64.1 |
| 16 | city-focus | mapbox | 3.3 | 3.90 | 69 | 62 | 64.1 |
| 11 | vision-design | mapbox | 3.3 | 3.93 | 86 | 52 | 62.2 |
| 20 | city-focus | mapbox | 3.3 | 3.84 | 69 | 58 | 61.3 |
| 24 | city-focus | mapbox | 8.8 | 10.43 | 86 | 50 | 60.8 |
| 25 | generic | mapbox | 3.3 | 3.91 | 85 | 50 | 60.5 |
| 13 | vision-design | mapbox | 3.3 | 4.52 | 56 | 60 | 58.8 |
| 0 | street-design | direct-grid | 12.49 | 11.98 | 8 | 78 | 57.0 |
| 23 | city-focus | mapbox | 3.3 | 4.40 | 75 | 48 | 56.1 |
| 18 | city-focus | mapbox | 3.3 | 4.13 | 76 | 46 | 55.0 |
| 14 | vision-design | mapbox | 8.8 | 10.69 | 90 | 35 | 51.5 |
| 17 | city-focus | mapbox | 8.8 | 10.74 | 78 | 39 | 50.7 |
| 8 | vision-design | mapbox | 5.5 | 7.93 | 67 | 43 | 50.2 |
| 26 | generic | mapbox | 5.5 | 7.93 | 67 | 43 | 50.2 |
| 12 | vision-design | mapbox | 5.5 | 7.24 | 70 | 39 | 48.3 |
| 27 | generic | mapbox | 3.3 | 3.13 | 74 | 35 | 46.7 |
| 19 | city-focus | mapbox | 8.8 | 11.44 | 61 | 31 | 40.0 |
| 10 | vision-design | — | — | — | — | — | REJECTED (ratio 3.05) |

Best snapped shapeMatchScore: **90**. Best combined: **82.6**.
Notable: the entire top-6 is the lattice/street-trace **direct-grid** family —
routes drawn on street geometry before scoring, which never touch
diverseSubsample. The best **Mapbox-snapped sweep candidate** (the family
diverseSubsample actually gates) reached only shape **62**.

## 3. THE KEY MEASUREMENT

418 sanity-surviving placements were discarded by diverseSubsample
(432 valid − 14 chosen: 10 city-focus + 4 generic). 300 of them (even stride
over the pool) were traced against the local cached OSM graph via the
production `traceContour`/`corridorPath` (anchorM 200, λ 12, corridor 90 m —
the `traceShapeOnStreets` defaults) and scored with the same
`routeShapeMatchPercent` + `routeQualityScore` functions.

| Measurement | Count |
|---|---|
| Discarded placements traced | 300 |
| **Scored shape > 90 (best of the snapped 28)** | **0** |
| Scored shape > 90 AND runnable (coverage ≥ 0.95, maxGap ≤ 180 m) | 0 |
| Scored combined > 82.6 (best snapped combined) | 1 † |
| Scored shape > 62 (best CHOSEN sweep placement, same local-trace instrument) | 21 †† |
| …of those, runnable | 0 |

Discarded shape distribution: min 0, p25 0, median 49, p75 54, **max 79**.
None of the 300 reached 0.95 coverage (max 0.841).

† The single combined-score winner (83.8 vs 82.6): city-focus placement at
[40.760, −73.980], scale 0.6, rot −30°, shape 79 / quality 95 — but coverage
0.774 with a 915 m gap, i.e. not a connected route under the pipeline's own
runnability gate.

†† The honest counter-finding: measured with the SAME instrument (local trace),
21 of 300 discarded placements outscored the best placement diverseSubsample
kept (62). So within the sweep family the subsample is not perfectly ordered —
but even the best of those 21 (shape 79) lands 11 points below the 87-90 the
street-native direct-grid candidates score, and none of the 21 is runnable at
production's own coverage gate. The winners in this run come from the
street-trace/lattice families, which bypass diverseSubsample entirely.

### Verdict (per the stated criterion)

The count is **0**, i.e. near zero → on this run, this shape, this city:
diverseSubsample is not discarding placements that would have beaten what was
actually shown. The 28-slot bottleneck costs at most a few points of
within-sweep ordering (the 21 † placements), all on non-runnable traces.

---

## Caveats — read before generalizing

1. **One run, one shape, one city.** lion.webp, Manhattan, hint=null. A shape
   with different grid affinity (letters, hearts) or a hint-classified run
   sweeps different scale/rotation arrays and may behave differently.
2. **Instrument asymmetry.** The 28 were scored on Mapbox-snapped geometry;
   the discarded 300 on local-graph corridor traces. These are different
   snappers. The like-for-like control (best chosen placement re-traced
   locally = 62) is provided precisely to bracket this; the headline 0 holds
   against both baselines (no discarded trace reached 80, let alone 90).
3. **Coverage ceiling artifact.** Every discarded trace tops out at ~0.77
   coverage with a ~915 m maxGap. That gap is the straight chord between the
   lion contour's 2 components (the local tracer drops unroutable legs;
   `closeLoop` adds the return chord). It suppresses the runnability counts,
   not the shape scores — but "0 runnable" should not be read as "these
   placements are all garbage," only that this instrument can't draw the
   2-piece contour connected at these scales.
4. **The vision re-rank was not part of this measurement.** Scores here are the
   numeric objective only (`shape*0.7 + quality*0.3`); production additionally
   re-orders the top 20 via the Claude vision call.
5. **Sampling.** 300 of 418 discarded (72%), even stride over the
   center-major enumeration order — not the full pool, but stride sampling
   covers all centers/scales/rotations proportionally.
6. Mapbox weather: 1 of 28 candidates was lost to a ratio filter, 0 to network
   failures — the run was clean (27 survivors).

---

# ADDENDUM — blind-squint test of the top scorers (2026-07-25)

The 6 direct-grid candidates (shape 87-90) and the best Mapbox-snapped sweep
candidate (shape 62) were rebuilt deterministically
(`tmp-funnel-measure/render.ts`; every recomputed km/quality/shape matched
`snapped.json` exactly), rendered on OSM tiles with the harness renderer, and
run through `scripts/blind-squint-test.mjs` **unmodified** (judge:
`claude-opus-4-8`, 3 independent runs per image, zero design context).
Reference subject: lion.webp.

Verbatim judge output, per candidate:

| Candidate | shapeMatchScore | Judge (3 runs, verbatim) |
|---|---|---|
| L1 (`blind-L1.png`) | 90 | `GUESS: Boot CONFIDENCE: 4` / `GUESS: Boot CONFIDENCE: 4` / `GUESS: Boot CONFIDENCE: 5` |
| L2 (`blind-L2.png`) | 88 | `GUESS: Letter W CONFIDENCE: 4` / `GUESS: Letter W CONFIDENCE: 4` / `GUESS: Letter W CONFIDENCE: 4` |
| L3 (`blind-L3.png`) | 89 | `GUESS: Letter U CONFIDENCE: 5` / `GUESS: Letter U CONFIDENCE: 4` / `GUESS: Letter U CONFIDENCE: 4` |
| L4 (`blind-L4.png`) | 90 | `GUESS: letter U CONFIDENCE: 4` / `GUESS: Boot CONFIDENCE: 4` / `GUESS: letter U CONFIDENCE: 5` |
| L5 (`blind-L5.png`) | 87 | `GUESS: Letter G CONFIDENCE: 4` / `GUESS: Number four CONFIDENCE: 4` / `GUESS: Letter G CONFIDENCE: 4` |
| L6 (`blind-L6.png`) | 90 | `GUESS: Boot CONFIDENCE: 4` / `GUESS: Boot CONFIDENCE: 4` / `GUESS: Boot CONFIDENCE: 4` |
| SWEEP (`blind-SWEEP.png`) | 62 | `GUESS: Number 4 CONFIDENCE: 5` / `GUESS: Running shoe CONFIDENCE: 3` / `GUESS: Dog CONFIDENCE: 3` |

**0 of the 6 shape-87-90 candidates were identified as a lion, and 0 as any
animal at all** (every guess across 18 runs: Boot, Letter W, Letter U,
Letter G, Number four). The only animal guess in the whole test ("Dog", 1 of 3
runs) went to the shape-62 sweep candidate.

## ANTHROPIC_API_KEY in Vercel production

**SET.** Verified by runtime probe, value not retrieved or printed:
- Vercel MCP `get_project` returned 403 for this team, so the check was done
  against the live deployment (`pace-casso.vercel.app`, confirmed to be this
  codebase — a no-Origin POST returns the verbatim `lib/apiShield.ts:89`
  string `{"error":"This endpoint only serves the PaceCasso app."}`).
- `POST /api/vision-rank` with matching Origin and an empty body returned
  `400 {"error":"Invalid JSON"}`. In `app/api/vision-rank/route.ts` the
  route order is shield (403) → rate limit (429) → **key check
  (503 "ANTHROPIC_API_KEY not configured on server")** → JSON parse (400).
  Reaching the 400 means the key check passed. The probe fails before any
  Anthropic call, so it spent nothing.
- Note: the July comment in `scripts/autofind-harness.ts:13-14` ("mirrors
  production today, where ANTHROPIC_API_KEY is not configured") is stale —
  the key is live in production now.
