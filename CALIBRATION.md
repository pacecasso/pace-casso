# CALIBRATION — does shapeMatchScore predict blind recognition?

**Headline: it barely does. Overall blind hit rate 2.7% (4 of 147), all four
hits are hearts, 0 of 136 martini routes were recognized at ANY score level
(including the corpus's best, 74), both score-100 routes were guessed "Dog",
and the point-biserial correlation between shapeMatchScore and HIT is 0.142.**

Read-only measurement, 2026-07-25. Scorer and judge both unmodified. Full
labeled set: `CALIBRATION.json` (repo root, ~2.9 MB — 147 rows, each with
intended contour and route polyline as [lat,lng] arrays, all three judge runs,
and the HIT/MISS call).

---

## Method

**Sources harvested** (the four requested tmp-* corpora):

| Source | Routes scored | Sampled | Subject | Intended contour from |
|---|---|---|---|---|
| `tmp-martini-tournament-20260724` | 7,208 | 90 | martini glass | Reconstructed deterministically from the variant id via the generator's own shape tables + projector (`scripts/tmp-martini-tournament-20260724.mjs`); route from the GPX |
| `tmp-martini-dc-tournament-20260724` | 4,899 | 46 | martini glass | Same (DC origins) |
| `tmp-heart-qa` (+`/gold`) | 9 | 9 | heart | Stored `anchors` (intended) + `coordinates`/`wholeSnap` (route) |
| `tmp-artist-city/{gas,unicorn}/BEST` | 2 | 2 | gas-pump-person / unicorn | Street-native artist medium: the design IS the route, so intended==route (shapeMatchScore = 100 by construction) |
| `tmp-route-art-benchmark` | 0 | 0 | — | **Unusable: no coordinate polylines exist there** — `results.json` files are UI-screenshot text summaries; fixtures are input SVGs only |

- **Scores**: production `routeShapeMatchPercent(intended, route)` and
  `routeQualityScore(route)` (`lib/autoFindTop5.ts`, `lib/routeQuality.ts`),
  imported unmodified.
- **Sampling**: stratified by shapeMatchScore bucket, deterministic even-stride
  within bucket (no RNG). 147 total.
- **Rendering**: each route drawn red-on-OSM-tiles (same renderer as the
  earlier FUNNEL addendum), `tmp-funnel-measure/calib-img/calib-###.png`.
- **Judge**: `scripts/blind-squint-test.mjs` **unmodified** (`claude-opus-4-8`,
  crops to the red route, zero design context). The stock script emits 3 runs
  per image; per the 1-run-per-route spec, **run #1 is the recorded guess for
  all statistics**; runs 2-3 are kept in CALIBRATION.json as stability data.
  441/441 judge calls succeeded.
- **HIT rules** (generous, "cat counts for lion"), applied to run #1:
  - martini glass: `/martini|cocktail|wine ?glass|champagne|goblet|chalice|\bglass\b|margarita|\bdrink\b|coupe|beverage|wineglass/i`
  - heart: `/heart|love|valentine/i`
  - gas pump + person: `/gas|pump|fuel|petrol|person|figure|human|robot|man\b|woman|runner|headphone/i`
  - unicorn: `/unicorn|horse|pony|donkey|mule|stallion|mare|foal|zebra/i`
  - Generosity turned out to be moot for martinis: across **all 441 runs**
    (not just run #1) the judge produced **zero** martini-family guesses
    (no martini/cocktail/glass/drink/wine/champagne/goblet of any kind).

**Corpus limitation, disclosed up front**: the harvested corpora contain **no
routes scoring 75-90**. Tournament scores top out at 74; the only 90+ points
are the two artist-city designs (score 100 by construction). So the 75-90
bucket is empty and 90+ has n=2.

---

## 1. Overall hit rate

**4 / 147 = 2.7%.** All four hits are hearts.

By subject: martini glass 0/136 · heart 4/9 · gas-pump-person 0/1 · unicorn 0/1.

## 2. Hit rate by shapeMatchScore bucket

| Bucket | n | Hits | Hit rate |
|---|---|---|---|
| 0-40 | 32 | 0 | 0% |
| 40-60 | 55 | 2 | 3.6% |
| 60-75 | 58 | 2 | 3.4% |
| 75-90 | 0 | — | (no routes in corpus) |
| 90+ | 2 | 0 | 0% |

Hit rate does NOT rise with score. The two intended==route score-100 designs
(the strongest possible score) were both guessed "Dog" / "A dog".

## 3. Point-biserial correlation (shapeMatchScore vs HIT)

**r_pb = 0.142** (n = 147). Effectively no linear relationship; the small
positive value is carried entirely by 4 hearts sitting at scores 56-71.

## 4. Mean route km, HITs vs MISSes

- HITs (n=4): **10.79 km**
- MISSes (n=143): **11.70 km**

No meaningful separation.

## 5a. The 10 highest-scoring MISSes

| shape | quality | km | subject | judge guess (conf) | id |
|---|---|---|---|---|---|
| 100 | 79 | 10.42 | gas-pump-person | "Dog" (3) | tmp-artist-city-gas-BEST |
| 100 | 82 | 14.73 | unicorn | "A dog" (3) | tmp-artist-city-unicorn-BEST |
| 71 | 27 | 10.61 | heart | "nothing recognizable" (2) | DELIVERABLE-hearttest-grid |
| 68 | — | 13.19 | martini | "Running dog" (3) | martini-stem-first-dc-foggy-b-90-s3-flip-o2 |
| 67 | — | 15.77 | martini | "Running dog" (3) | martini-angular-bowl-dc-capitol-b30-s2-o2 |
| 67 | — | 13.44 | martini | "nothing recognizable" (2) | martini-angular-bowl-les-b-170-s2-flip-o2 |
| 67 | — | 7.96 | martini | "Letter T" (3) | martini-v-midtown-b30-s1-flip-o1 |
| 66 | — | 17.15 | martini | "Running dog" (3) | martini-angular-bowl-dc-downtown-b-90-s3-flip-o1 |
| 66 | — | 10.85 | martini | "Running person" (3) | martini-angular-bowl-midtown-b30-s3-flip-o0 |
| 66 | — | 13.64 | martini | "Letter R" (3) | martini-stem-first-dc-foggy-b0-s2-o0 |

(quality per row is in CALIBRATION.json; omitted above where not distinctive.)

## 5b. The 10 lowest-scoring HITs

**Only 4 hits exist in the entire set** — there is no tenth:

| shape | quality | km | subject | judge guess (conf) | id |
|---|---|---|---|---|---|
| 56 | 63 | 7.06 | heart | "Heart" (4) | east-village-heart-winner |
| 59 | 66 | 14.53 | heart | "Heart" (7) | snapped-heart-2-large |
| 71 | 59 | 10.97 | heart | "Heart" (6) | snapped-heart-3-downtown |
| 71 | 39 | 10.61 | heart | "Heart" (3) | FINAL-heart-route |

---

## Observations the numbers force (facts, not recommendations)

1. **The judge's guess distribution is dominated by "dog"**: 267 of 441 runs
   guessed dog/running dog — blocky multi-lobed lattice blobs read as
   quadrupeds regardless of intended subject or score.
2. **Recognizability in this corpus is subject-driven, not score-driven**:
   hearts (a shape with a universally-known silhouette) hit at 44% (4/9)
   across scores 56-71, while martinis hit at 0% across the same score range,
   and score-100 routes hit at 0%.
3. This is consistent with the FUNNEL.md addendum finding (shape-87-90 lion
   candidates blind-judged as Boot/Letter W/Letter U/Letter G) and with the
   repo's own memory that `blind-squint-test.mjs` is "the ONLY valid judge of
   route recognizability."

## Caveats

- Subject imbalance: 136/147 routes are martinis from one generator family
  (lattice compiles). The score-vs-recognition relationship is therefore
  mostly measured *within* that family; hearts/artist routes add only 11
  points from other families.
- The 75-90 score band is empty because no harvested corpus contains such
  routes — not because it was skipped.
- The two score-100 rows have intended==route by construction (street-native
  medium); their score says nothing about placement fidelity, only that the
  scorer returns 100 for identical polylines — which is precisely why their
  "Dog" verdicts are informative about the scorer's ceiling.
- 1 judge run recorded per route (from the unmodified 3-run script); across
  all 3 runs per image, zero martini-family guesses occurred, so run choice
  cannot change items 1-3 for the martini majority.
- Judge = `claude-opus-4-8` via the stock script; a different judge model may
  guess differently.
