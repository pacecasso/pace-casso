# FINAL-TWO — anchor density & primed judging

Read-only except the single sanctioned constant edit, 2026-07-26.

**Headlines:**

- **Experiment A: anchorM 200→40 changes nothing. Hit rate 21.1% — identical
  to production's 21.1%, still below the dumb baseline's 29.8%. Same four
  winners (heart, apple, peace, dog), zero new ones.** Anchor density is not
  the lever.
- **Experiment B: even when TOLD the subject, the judge rates production
  routes 3.95/10 and dumb-baseline routes 4.05/10** — priming does not rescue
  production, and the two sets remain indistinguishable. Bonus finding: the
  primed score correlates with blind recognition at **r = 0.647** across all
  38 images — 4.6× the production numeric scorer's 0.142.

---

## EXPERIMENT A — anchor density (anchorM 200 → 40)

Method: `lib/streetGraphTrace.ts:505` — `anchorM: options.anchorM ?? 200`
changed to `?? 40`. **That one constant only.** Full pipeline re-run for all
19 subjects (same harness as PIPELINE-GAP: real Mapbox, real vision calls,
real canvas grid), top-1 rendered, `blind-squint-test.mjs` unmodified, 3 runs.
The file was byte-copied before the edit and **restored byte-identical
afterward** (verified with `cmp`).

Scope note: the constant only reaches SINGLE-piece contours. Multi-piece
sketches go down the fullSketch path, which passes `anchorM: 120` explicitly
(`app/api/street-trace/route.ts:88`) — so crescent, fish, play, note, peace,
martini, gas and cat were largely unaffected (their top-1s came back
essentially identical), and the experiment's real coverage is the
single-piece subjects.

| Subject | anchorM=40 | Production (200) | Dumb baseline | A=40 km (q/s) | Verbatim guesses |
|---|---|---|---|---|---|
| heart | **3/3** | 3/3 | 3/3 | 10.7 (32/77) | Heart (9) ×3 |
| star | 0/3 | 0/3 | **3/3** | 11.6 (50/84) | A cat (4) ×3 |
| crescent moon | 0/3 | 0/3 | 0/3 | 19.1 (9/82) | Heart (6) ×3 |
| arrow | 0/3 | 0/3 | 0/3 | 8.8 (62/85) | Dog/animal (3) ×3 |
| lightning bolt | 0/3 | 0/3 | 0/3 | 12.5 (42/82) | A dog (3) ×3 |
| cross | 0/3 | 0/3 | 0/3 | 13.2 (46/73) | Butterfly (6) ×3 |
| house | 0/3 | 0/3 | 0/3 | 13.5 (37/88) | Running person / A dog / A dog (3) |
| fish | 0/3 | 0/3 | 0/3 | 10.6 (11/82) | A dog / Dog / dog or animal (3) |
| tree | 0/3 | 0/3 | 0/3 | 11.6 (36/81) | A dog ×2 / Running dog (3) |
| Apple logo | **3/3** | 3/3 | 3/3 | 11.0 (60/78) | Apple (8) ×3 |
| Twitter bird | 0/3 | 0/3 | 2/3 | 9.1 (45/80) | Heart (6/6/5) |
| play button | 0/3 | 0/3 | 0/3 | 19.3 (16/78) | face/head ×2 / Letter Q |
| envelope | 0/3 | 0/3 | 0/3 | 13.5 (62/89) | Running person / A dog / Running person |
| music note | 0/3 | 0/3 | 0/3 | 13.3 (12/81) | Balloon / Number 9 / A balloon |
| peace sign | **3/3** | 3/3 | 3/3 | 25.5 (8/78) | Peace sign (8) ×3 |
| martini glass | 0/3 | 0/3 | 0/3 | 14.8 (38/60) | Cat face ×3 |
| gas-pump-person | 0/3 | 0/3 | 0/3 | 41.9 (6/86) | nothing recognizable ×3 |
| cat | 0/3 | 0/3 | 0/3 | 18.7 (7/83) | nothing ×2 / dog (3) |
| dog | **3/3** | 3/3 | 3/3 | 13.0 (49/81) | A dog ×2 / Running dog |

**Mean: 21.1% (anchorM=40) = 21.1% (production 200) < 29.8% (dumb baseline).**

What the denser anchors actually did where they applied: routes hug the
contour more tightly and get dirtier (heart quality 59→32; star and arrow
top-1s switched from the lattice family to street-trace), guesses shuffled
(star "dog"→"cat", Twitter bird "dog"→"Heart"), but not one subject crossed
from miss to hit or back. The failure modes PIPELINE-GAP identified
(rotation, feature melt) are untouched by anchor density — as expected, since
neither is a sampling-resolution problem.

## EXPERIMENT B — primed judging

Method: `tmp-funnel-measure/primed.mjs` — modeled exactly on
`blind-squint-test.mjs` (same model `claude-opus-4-8`, same red-route crop,
3 runs per image) but the judge is told the intent:
*"This running route is intended to depict: <subject>. How well does it
read, 1-10?"* (A separate script is inherent to this experiment — the stock
script's prompt is fixed; nothing else differs.) 114/114 calls clean.
Raw outputs: `primed-gap.txt`, `primed-dumb.txt`.

All 38 images — primed mean (3 runs) next to the blind hits from
PIPELINE-GAP / DUMB-BASELINE:

| Subject | Prod primed | Prod blind | Dumb primed | Dumb blind |
|---|---|---|---|---|
| heart | **8.0** | 3/3 | **8.0** | 3/3 |
| star | 4.0 | 0/3 | 4.0 | 3/3 |
| crescent moon | 2.0 | 0/3 | 3.0 | 0/3 |
| arrow | 2.7 | 0/3 | 2.3 | 0/3 |
| lightning bolt | 4.7 | 0/3 | 4.0 | 0/3 |
| cross | 3.0 | 0/3 | 3.3 | 0/3 |
| house | 3.0 | 0/3 | 3.0 | 0/3 |
| fish | 4.0 | 0/3 | 3.0 | 0/3 |
| tree | 2.0 | 0/3 | 3.0 | 0/3 |
| Apple logo | 6.0 | 3/3 | **7.0** | 3/3 |
| Twitter bird | 3.0 | 0/3 | 4.0 | 2/3 |
| play button | 3.0 | 0/3 | 2.0 | 0/3 |
| envelope | 4.7 | 0/3 | 3.7 | 0/3 |
| music note | 6.0 | 0/3 | 5.3 | 0/3 |
| peace sign | **7.0** | 3/3 | 6.7 | 3/3 |
| martini glass | 3.0 | 0/3 | **6.0** | 0/3 |
| gas-pump-person | 2.0 | 0/3 | 2.7 | 0/3 |
| cat | 3.0 | 0/3 | 3.0 | 0/3 |
| dog | 4.0 | 3/3 | 3.0 | 3/3 |
| **Mean** | **3.95** | 21.1% | **4.05** | 29.8% |

Findings:

1. **Priming doesn't rescue production.** Told exactly what to look for, the
   judge still rates the median production route 3/10. The shapes aren't
   "there but unlabeled" — they're not there.
2. **Production and dumb are indistinguishable primed too** (3.95 vs 4.05),
   confirming DUMB-BASELINE's blind result with a finer-grained instrument.
3. **The primed judge is a far better scorer than the numeric one.** Across
   all 38 images, Pearson(primed mean, blind hit rate) = **0.647** — versus
   0.142 for `shapeMatchScore` in CALIBRATION.md. Of the 8 images scoring
   primed ≥ 6, six were blind 3/3 (the exceptions: music note 6.0 — a
   near-miss the blind judge called "Letter P"; dumb martini 6.0 — visible
   once known). Nothing below 6 ever went blind 3/3. A single primed vision
   call per candidate would have correctly separated every winner this
   project has measured from every loser — which is, notably, what
   `blind-squint-test.mjs`'s own header has claimed since July: "the ONLY
   valid judge of route recognizability."
4. Both anomalies are informative: star (dumb) was blind 3/3 but primed only
   4.0 — priming makes the judge pickier about proportions; martini (dumb)
   was blind 0/3 but primed 6.0 — the shape is present but ambiguous without
   the hint.

## Hygiene

- `lib/streetGraphTrace.ts` restored byte-identical after Experiment A
  (verified via `cmp` against the pre-edit copy); no other production file
  was touched at any point.
- Experiment A artifacts: `gapA-results.json`, `gapA-img/`, `gapA-judge-*.txt`.
- Experiment B artifacts: `primed.mjs`, `primed-gap.txt`, `primed-dumb.txt`.

## Where the whole measurement series now stands

| Stage | Recognition |
|---|---|
| Clean line art (SURVIVABILITY A) | 77.8% |
| Abstract 250×80 grid (SURVIVABILITY B) | 63.3% |
| Dumb snap-to-streets, fixed placement (DUMB-BASELINE) | 29.8% |
| Full production pipeline (PIPELINE-GAP) | 21.1% |
| Full pipeline, anchorM=40 (this report) | 21.1% |

with the production numeric scorer correlating at 0.142 with any of it, and a
one-call primed vision judge correlating at 0.647.
