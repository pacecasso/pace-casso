# PIPELINE-GAP — abstract-grid survivors vs the real production pipeline

Read-only measurement, 2026-07-25. The 19 subjects that scored 3/3 on gridded
line art in SURVIVABILITY.md were fed through the FULL production pipeline —
real `autoFindTop5` (unmodified import), real placement search and budgets,
real Mapbox snaps (~650 calls), real vision-hint / vision-design / vision-rank
(the actual `app/api/*` route handlers invoked with real Anthropic calls, same
models and prompts as production). Top-1 pick per subject, rendered on OSM,
judged by `scripts/blind-squint-test.mjs` unmodified, 3 runs each.

**The numbers:**

- **Mean hit rate on real streets: 21.1%** (4 of 19 subjects at 3/3; 15 at 0/3
  — every subject was all-or-nothing).
- **Drop from the abstract grid: −78.9 points** (these 19 were 100% by
  construction).
- **Survived BOTH — the product: heart · Apple logo · peace sign · dog.**

## Method notes

- Harness: `tmp-funnel-measure/gap.ts`. Full browser fidelity headless:
  node-canvas (installed `--no-save`, nothing in the repo manifest touched)
  provides the canvas + a URL-loading `Image`, so the vision ranker saw the
  same composite grid of real Mapbox Static map tiles it sees in production.
  The `/api/vision-*` and `/api/street-trace` fetches invoke the actual route
  handler modules — production shields passed, production models
  (`claude-sonnet-4-6` hint, vision-design, `claude-opus-4-7` rank) called for
  real. 19 hint + 19 design + 19 rank calls, 2 street-traces per run.
- Uploads: each subject's clean line-art image A from SURVIVABILITY, with the
  natural filename (`heart.png`, `apple.png`, …). This means production's
  filename inference legitimately fired for `apple.png`, `martini.png`
  (verified-route representative drafts) and `gas.png` (gas drafts +
  structural requirement) — the pipeline as a real user would hit it.
- "Columns" = the top-1 route's east-west extent ÷ 250 m (approximate: the
  Manhattan grid is ~29° rotated, so this slightly overstates true
  avenue-column count).
- One infrastructure note: the 18-subject batch was killed externally partway
  once and resumed idempotently (per-subject results are checkpointed); all 19
  completed. Raw data: `gap-results.json`, `gap-report.json`, images in
  `tmp-funnel-measure/gap-img/`.

## Per-subject results

| Subject | Abstract B | Real pipeline | km | Columns | Scorer (q/s) | Verbatim guesses (conf) |
|---|---|---|---|---|---|---|
| heart | 3/3 | **3/3** | 10.2 | 11.2 | 59/80 | Heart (10) / Heart (10) / Heart (10) |
| star | 3/3 | 0/3 | 12.8 | 11.9 | 51/88 | A dog (3) / A dog (4) / A dog (4) |
| crescent moon | 3/3 | 0/3 | 19.1 | 9.3 | 9/82 | Heart (5) / Heart (6) / Heart (6) |
| arrow | 3/3 | 0/3 | 13.3 | 11.0 | 54/89 | nothing recognizable (2) ×3 |
| lightning bolt | 3/3 | 0/3 | 13.4 | 10.4 | 38/92 | Running person (3) / A dog (3) / Running shoe (3) |
| cross | 3/3 | 0/3 | 13.8 | 10.8 | 45/80 | Bow tie (5) / A bow tie (5) / Bow tie (5) |
| house | 3/3 | 0/3 | 14.1 | 10.4 | 61/65 | A dog (3) / Dog head (3) / A dog (3) |
| fish | 3/3 | 0/3 | 10.6 | 10.5 | 11/82 | Dog head (3) / A dog (4) / A dog (3) |
| tree | 3/3 | 0/3 | 11.2 | 9.2 | 47/82 | nothing recognizable (2) ×2 / Running dog (3) |
| Apple logo | 3/3 | **3/3** | 12.8 | 10.8 | 54/89 | An apple (6) / An apple (7) / An apple (7) |
| Twitter bird | 3/3 | 0/3 | 9.1 | 9.8 | 39/80 | A dog (3) / A dog (3) / A dog (3) |
| play button | 3/3 | 0/3 | 19.3 | 11.4 | 16/78 | Apple (6) / Apple (6) / Apple (6) |
| envelope | 3/3 | 0/3 | 13.1 | 11.7 | 64/86 | A dog (3) / Dog head (3) / A dog (3) |
| music note | 3/3 | 0/3 | 13.3 | 7.6 | 12/81 | Letter P (6) / Balloon or key (4) / Balloon or key (4) |
| peace sign | 3/3 | **3/3** | 25.5 | 11.6 | 8/78 | Peace sign (8) / Peace sign (8) / Peace sign (8) |
| martini glass | 3/3 | 0/3 | 14.8 | 12.2 | 38/60 | Cat face (4) / Cat face (4) / cat face (4) |
| gas-pump-person | 3/3† | 0/3 | **41.9** | 12.7 | 6/86 | nothing recognizable (2) ×2 / A dog (3) |
| cat | 3/3 | 0/3 | 18.7 | 8.9 | 7/83 | nothing recognizable (2) ×3 |
| dog | 3/3 | **3/3** | 13.1 | 9.0 | 51/83 | Dog (4) / dog (4) / A dog (4) |

† already flagged in SURVIVABILITY as a person-only generous hit.

## Failure attribution (every top-1 render was inspected)

**Scale is not the killer.** Every route spans 7.6–12.7 avenue columns —
comparable to the 16-column abstract grid where all 19 read perfectly. Only
one failure looks scale-related.

**Placement (location) killed nothing.** No top-1 sits over water or in a
park; the vision ranker's geographic gate did its job. The failures are the
shape itself being destroyed between contour and route:

| Subject | Looks like | Evidence |
|---|---|---|
| star | routing (compile melt) | 11.9 columns, q=51 — points staircased into a wandering tangle; no star silhouette survives |
| crescent moon | routing (retrace fill) | q=9; the two arcs survive but the crescent's defining gap collapsed → concentric blob read as "Heart" |
| arrow | routing (feature absorption) | head merged into a big closed blob loop; shaft indistinct |
| lightning bolt | routing (doubling/stretch) | q=38; the zigzag stretched and doubled into limb-like strokes |
| cross | **rotation** (+ compile) | drawn ~diagonal; two merged lobes read as "Bow tie" — a plus sign rotated 45° stops being a plus sign |
| house | **rotation** (+ door stroke wander) | pentagon visible but tilted ~35°, door stroke wandered inside |
| fish | routing (spur wander) | tail stroke meandered across downtown; body loop kept, gestalt lost |
| tree | routing (tier melt) | the three tiers staircased into one generic lumpy polygon |
| Twitter bird | routing (feature melt) | all bird features rounded into a generic quadruped-ish blob |
| play button | routing (interior collapse) | outer circle survived; inner triangle collapsed → circle+stub read as "Apple" |
| envelope | **rotation, purest case** | q=64, s=86 — the geometry is clean; the rectangle was simply drawn ~40° rotated, becoming a diamond. Axis-aligned this route would very likely read |
| music note | scale/proportion | 7.6 columns; the note head shrank below legibility while the stem stayed long → "Letter P" |
| martini glass | routing (branch spurs) | the V and stem dissolved into branching spur strokes across Midtown |
| gas-pump-person | routing (+ an honesty failure) | **top-1 is a 41.9 km, quality-6 tangle** — the app's first recommendation for this upload is a route no runner could complete reading as nothing |
| cat | routing | q=7; ears/tail dissolved, large station-area spurs |

Rough split of the 15 drops: **~11 routing** (compile/trace distortion,
retraces, spur wander, feature melt), **~3 rotation** (cross, house, envelope
— shapes whose identity is axis-bound, drawn rotated), **~1 scale**
(music note).

## Observations the data forces

1. **The gap is the pipeline, not the medium.** SURVIVABILITY showed the grid
   costs only 14 points; the production pipeline costs 79 on the same
   subjects. The destruction happens in placement-rotation and in what the
   compile/trace/snap does to features — not in "streets are a grid".
2. **The numeric scorer cannot see any of this.** The 15 failures carry
   shapeMatchScores of 60–92 (mean ≈ 81). Lightning bolt scored s=92 and was
   guessed "Running shoe". Envelope scored q=64/s=86 and was guessed "A dog"
   three times. Consistent with CALIBRATION.md (r_pb = 0.142).
3. **Rotation is a silent recognizability tax the pipeline never accounts
   for.** The abstract test was axis-aligned; production freely rotates
   placements to fit the grid, and for orientation-bound shapes (cross,
   house, envelope, arrow) that alone is fatal even when the geometry
   survives cleanly.
4. **The four survivors share rotation-tolerance**: heart (judge confidence
   10/10 — the strongest blind result this repo has produced), apple, peace
   sign (recognizable even at q=8!), dog. Bold, curve-defined, orientation-
   forgiving silhouettes.
5. The gas top-1 at 41.9 km with quality 6 shipped as the first thing a user
   would see — the 35 km perimeter cap does not bind the street-trace
   candidate family.
6. All 19 runs used vision (visionUsed=true, real Claude ranking with real
   map-tile grids); the judged routes are exactly what the app would show.

## Caveats

- One run per subject; auto-find is stochastic only via external services
  (Mapbox variants, vision ranking), so a re-run could pick different top-1s.
- Top-1 only; some subjects may have a recognizable route at rank 2-5.
- "Columns" uses E-W extent, not true 29°-grid avenue count.
- The blind judge model (`claude-opus-4-8`) shows a strong "dog" prior on
  blobby tangles (also seen in CALIBRATION.md: 267 of 441 runs) — misses are
  robust (0/3), but the specific wrong labels shouldn't be over-read.
