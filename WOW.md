# WOW — first gallery-grade route batch (Manhattan, 9 subjects)

Offline run, 2026-07-26. Builds directly on LIBRARY.md's 42.1% recipe with
three upgrades the measurement series pointed at but never tested. Rig:
`tmp-wow/wow.ts`. Judges unmodified (`scripts/blind-squint-test.mjs`,
`tmp-funnel-measure/primed.mjs`).

**Headline: 7 of 9 subjects produced at least one blind-3/3 route = 77.8%,
vs 42.1% (LIBRARY), 29.8% (dumb baseline), 21.1% (production pipeline).
30 keeper routes total. Includes an ELEPHANT judged "Elephant" at
confidence 9 three times — the strongest non-heart blind result this repo
has ever measured — and a MARTINI keeper after 0-of-136 in CALIBRATION.**

Browse: **`tmp-wow/BEST-SHEET.png`** — the consolidated library across all
four runs: **52 verified routes, 38 of them single continuous runs** (green
label) and 14 multi-activity art projects (amber label). PNG + GPX per route
in `tmp-wow/best/`. Per-run archives in `tmp-wow/run1..run3/`.

## The three changes vs LIBRARY

1. **Giant-component snapping.** The walk graph is 103,592 nodes in 414
   components; the giant component holds 88.8%. LIBRARY snapped contour
   samples to the nearest node of ANY component, so ~11% of nodes poisoned
   placements with teleports, killing 80-95% of the sweep. Restricting
   nearest-node search to the giant component (real streets only, no fake
   edges) took gate survival from ~8% to ~34% and zeroed jump failures
   across all 5,040 traces.
2. **Pen lifts (start/stop runs).** Subjects may be several strokes. Each
   stroke is traced separately; nothing connects them (GPX = multiple
   `<trkseg>`; in practice: end the run/activity, walk to the next start,
   start a new one — standard multi-activity GPS art). This is what killed
   every multi-piece subject in every earlier experiment. The smiley (eyes!),
   the martini (bowl / stem+base / olive), and the whale's spout use it.
3. **Stage-A gate + authored wow subjects.** SURVIVABILITY showed some
   subjects die before streets (lion/tiger line art was never recognizable).
   So each subject's clean line art was blind-judged FIRST and iterated
   until 3/3 (giraffe 8, elephant 9, rabbit 8, runner 9, bronto 8-9,
   sailboat 9, smiley 10, martini 9; whale settled at "Fish" — kept with a
   marine-family hit rule). Mirroring was added to the sweep (14 centers ×
   4 extents × 5 rotations × 2 mirrors = 560 placements/subject).

## Funnel numbers

560 placements/subject → 1,064 gated survivors (9 subjects; zero teleport
failures — the binding gate is now snap-distance ≤150 m, i.e. water/park
overhang) → 372 primed-screened (capped 44/subject, 1 call each) → 72
blind-judged (top 8/subject × 3 runs, 216 calls) → **30 keepers at 3/3**.

## Keepers by subject (best per subject)

| Subject | Keepers | Best blind verdict | km | Placement |
|---|---|---|---|---|
| elephant | 8/8 judged | "Elephant" conf **9** ×3 | 22.3 | Village/Flatiron, axis-aligned |
| smiley | 8/8 | "Smiley face" conf **9** ×3 | 18.6 | Downtown, rot 15° |
| runner | 6/8 | "Running person" conf 8 ×3 | 13.0 | NoHo/LES, axis-aligned |
| giraffe | 1/8 | "Giraffe" conf 8 ×3 | 25.5 | Midtown, axis-aligned |
| sailboat | 4/8 | "Sailboat" conf 6 ×3 | 20.6–23.7 | various |
| bronto | 1/8 | "Dinosaur (brontosaurus)" conf 7 ×3 | 18.2 | mirrored, axis-aligned |
| martini | 2/8 | "Martini glass" conf 7-8 | 20.5 | rot -15°, mirrored |
| rabbit | 0 | best guesses drifted (streets melted the ears) | — | — |
| whale | 0 | fluke dissolved; fish-family reads didn't survive 3/3 | — | — |

Distances: 13.0–25.5 km. Nothing under 13 km made the wow tier — big art
needs big canvas, exactly the "look GREAT vs passable" trade. The runner at
13.0 km is the most runnable wow; the elephant at 22.3 km is a marathon-
training-day piece (or a bike ride).

## What the failures say

- **rabbit/whale**: both survived stage A but died on streets — long thin
  paired features (ears) and smooth tapering curves (fluke) are still the
  quantization casualties PIPELINE-GAP identified. Not fixed by placement
  volume. Next lever for these: finer-grid neighborhoods only (LES/Village
  at small extent) or pen-lift decomposition.
- The primed screen remains a good-not-perfect ranker: elephant keepers
  included a primed-5; sailboat's primed-8s judged only conf 6.

## Honest caveats

- Judge is `claude-opus-4-8`, not a human panel; same model family as prior
  reports so the comparison to 21.1%/29.8%/42.1% is apples-to-apples.
  Human validation (Ralph's squint, friends) is the real bar.
- Pen-lift routes require the runner to record 2–4 separate activities (or
  accept connector lines in a single activity). The GPX encodes strokes as
  separate `<trkseg>`s; Strava draws one activity per file cleanly.
- Routes are giant-component street paths with zero teleports, but not yet
  checked for one-way/crossing/park-hours practicalities beyond the gates.
- 216 + 372 + ~35 stage-A judge calls ≈ $6–8 of API spend for the batch.

## Follow-up experiments (same day)

- **Spur cleanup (v2/v3)**: two-stage cleanup (drop off-contour anchors
  >110 m; excise node-loops <380 m) plus chamfer-deviation ranking of the
  primed screen. v2's 450 m threshold silently amputated the runner's back
  forearm (440 m retrace) and cost all runner keepers — caught by the
  regression re-run, fixed in v3. Cleanup removed the one-block stubs,
  raised gate survivors 1,064 → 1,367, and unlocked **rabbit** (first-ever
  keepers), but did not systematically raise blind confidence. Verdict:
  keep (cleaner lines, more candidates, one new subject), and treat
  single-run results as samples — the judges wobble ±1 subject per run,
  so the product keeps the UNION of independently verified keepers.
- **Single-line variants (v4)**: a fully-connected smiley (smile tips on
  the rim, eyes on a glasses-bar, invisible travel along already-drawn
  streets) **verified 3/3 "Smiley face" conf 7 as ONE run**. A single-line
  martini (olive against the bowl wall) read 9/9/9 as line art but
  dissolved to "dog" on streets — the pen-lift martini remains the only
  verified martini.
- **Strava physics, stated plainly**: one activity = one continuous line
  (pauses draw straight connectors). Multi-run pieces (smiley with floating
  eyes, martini with separate olive, whale spout) require 2-4 separate
  recorded activities and compose on the personal heatmap or an app-side
  render — they are labeled as such everywhere.

## What this means for the product (the 40% → 70% path)

The recipe is now proven end-to-end and is cheap per subject (~560 offline
traces + ~50 vision calls ≈ $1/subject). Productization order:

1. **Wire this funnel behind Step 2/3 for uploads**: dumb-trace sweep with
   giant-component snapping replaces the current compile/rank stack (which
   DUMB-BASELINE showed subtracts value); primed screen (1 call/candidate)
   replaces the numeric scorer (r 0.647 vs 0.142); show the user only
   blind-passed picks, with an honest "no strong route found" fallback.
2. **Ship the keeper gallery** ("run an elephant in the Village today") —
   30 GPX-ready routes, zero marginal cost, immediate demo value.
3. **Pen-lift toggle** in Step 4/5 ("multi-run art") + GPX-per-stroke export.
4. Later: extend the sweep to Brooklyn/Chicago/SF/DC graphs (same rig,
   different walk graph + park boxes).
