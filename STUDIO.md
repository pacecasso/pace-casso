# STUDIO — the patient commission lane (offline harness, Aug 20 2026)

`scripts/studio-commission.ts` — one command per uploaded image:

```
npx tsx scripts/studio-commission.ts <image> <outdir> [rounds]
```

Pipeline per round (every gate is an external zero-context API call —
nothing is ever judged by the session that authored it):

1. **Design.** claude-fable-5 sees ONLY the image (never the filename —
   the Aug 12 fabricated-text trap is structurally impossible) and draws a
   one-line interpretive sketch as JSON. The prompt encodes the accumulated
   grammar: interpret don't replicate, resolution law (two strokes closer
   than ~8% of span merge; features under ~6% vanish), thin features as
   retraced centerlines or chunky ribbons, no invented text, 2-3 interior
   details max.
2. **Stage-A gate.** The sketch itself is blind-judged 3× ("what does this
   line drawing depict?"). All 3 must name the subject correctly
   (synonym-checked by a text call). If the line art doesn't read, streets
   never will (WOW.md finding) — redesign with feedback.
3. **Trace.** `traceShapeOnStreets` (the codex-improved full-graph tracer:
   direction-aware anchors, edge-keyed bend-penalized A*, visual-similarity
   ranking) at hero scales 1300-4000 m half-size, zero-teleport gate.
4. **Render.** Thin 2.6px Strava-orange line on pale CARTO tiles — the
   honest presentation (July 16 finding).
5. **Blind name gate.** The map render is judged 3× zero-context ("what
   were they trying to draw?"). Keeper requires CORRECT NAME 3/3 —
   confidence alone is never trusted (a junk gas route once scored
   "Dog, confidence 6").
6. **Mapbox verify.** Walking directions over the whole chain in ≤24-pt
   legs; keeper requires 0 failed legs and walk length within 12% of the
   chain. Only then is a GPX written.

Failed rounds feed the wrong guesses AND the failed street render image
back to the designer (it must see what the city did to the composition).

## Judge calibration (claude-fable-5, this session)

| Image | Verdict |
|---|---|
| LOVE.webp reference | "LOVE in heart" 8/8/7 |
| sneaker.jpg reference (Cameron) | "a sneaker" 9/9/9 |
| badgaslogo.png (known junk) | scattered, conf 2-4 (correctly junked) |
| tmp-wow best elephant (opus-4-8 said 9) | "a hand" 3 / "octopus" 6 |

The old opus-4-8 judge (still live in production wowPlaceServer /
artistLoopServer / sketchInterpretServer) rated the junk gas route
"Dog, confidence 6" — confidently wrong. fable-5 separates real from junk
far better; production's judge model is a one-line upgrade candidate.

## Results (all gates enforced, nothing hand-tuned)

| Upload | Mode | Rounds | Outcome |
|---|---|---|---|
| Red-simple-heart | interpretive | 1 | **KEEPER round 1** — 11.2 km, cold-judged "heart" 9/9/9 (re-verified with the standalone judge), Mapbox walk 10.7 km, 0 failed legs. `tmp-studio/heart/round-1/route-0.gpx` |
| stones.webp (tongue) | interpretive | 6 + 8 | **No keeper.** Stage-A passes every round (6-8); on streets the composition collapses into a "heart" attractor (two lip lobes + hanging tongue mass) or spiral/sheep. Visual feedback changed the designs but not the outcome. |
| gas.png | interpretive | 6 + 8 | **No keeper.** Stage-A mostly passes; street results cold-read as animals at conf 2-4. One round-5 "keeper" was a GATE BUG (empty judge responses passed the substring name-match); caught, fixed, honestly re-judged "dog/dinosaur 2-3" and retracted. |
| strava.png | interpretive | 8 | **No keeper — structural.** The cold judge names the real upload "Strava logo" 9/9/9 but calls every REDRAWN chevron sketch "lightning bolt/zigzag": abstract-mark identity lives in exact proportions, which interpretation destroys. Led to `--exact` mode. |
| strava.png | `--exact` | 2 passes | **No keeper — near miss.** Extraction is lossless (stage-A likeness 10/10/10). Best street route: likeness 7/7/6 (gate is min ≥ 7), cold reads heart/bolt. Key finding: a sideways placement scored vis=86 but likeness 1/1/1 — orientation IS identity for marks, so the exact sweep is now near-upright only; the upright rerun peaked at 7/6/7. The inner chevron notches still partially merge at street scale. |

The false-keeper incident is the whole reason the gates exist: the route
walked (Mapbox 0 fails, 27.7 km) and the harness printed KEEPER — and it
was still junk. Every keeper claim must survive the standalone
`blind-squint-test.mjs` re-judge before being shown.

## First verified batch (Aug 20 evening — tmp-studio/KEEPERS/)

Five routes, each passing: blind correct-name 3/3 in BOTH framings (full
render + route-cropped), an independent standalone re-judge, and Mapbox
walking with 0 failed legs. Giraffe 28.3 km (first complex figure through
every gate), smiley 22.4 km (9/9/9), heart 11.2 km (9/9/9), star 15.1 km,
apple 15.9 km. Gallery artifact: claude.ai/code/artifact/94270f87-126e-4704-9b13-580e3329694c
Mechanics that mattered: wide-placement retry for proven-but-weak designs
(redesigning was wasting them), the full-body-animal rule, and the
dual-framing gate (a full-frame-only "giraffe 8/8/7" read "reindeer" when
cropped — framing disagreement means not obvious enough).
Still below bar: elephant (best avg 6.7), unicorn, bronto, runner,
sailboat, stones, gas, strava (best 7/7/6 in exact mode), nike.

## Logo lane (Aug 20 late evening)

| Upload | Result |
|---|---|
| strava.png | **KEEPER** — exact mode, anchorM 80, upright-only: likeness 7/7/7 (calibrated gate min≥7; wrong pairs score 1-2), 12.6 km, Mapbox 0 fails. `KEEPERS/strava.gpx` |
| swoosh (nike.png cropped to symbol) | **KEEPER** — likeness 8/8/8, 13.2 km, hook at the Battery, tip at the East River. First-ever pass for the "thin curved mark" class. Characterization: the upload was the solo symbol. `KEEPERS/swoosh-solo.gpx` |
| nike.png full lockup | Honest refuse at stage-A (5/6/5): a symbol-only sketch is not the lockup the user uploaded. Whether symbol-only is acceptable for lockup uploads is a PRODUCT decision (July 22 rule vs Aug flip) — not decided unilaterally. |
| chanel.webp | Letters auto-dropped (artSpec — its first production consumer), Cs traced at vis 88-89 but likeness 4-6: interlocked open round curves flatten on the grid. Named wall. |
| stones.webp | Exact lane refuses at stage-A 5/5/5 (outer ring = heart-blob; the teeth interior IS the identity). Interpretive lane 0/24 (heart attractor). Needs interior-mass rendering. |
| gas.png | Adaptive threshold (Otsu-lite, now in the lane) isolates the blue art, but extraction fragments it (hose ring survives, pump/figure drop). Boss-level subject; needs per-component handling. |

Exact-lane mechanics added tonight, each forced by a measured failure:
adaptive ink threshold (yellow disc flooded lum-210), wordmark-band drop
(shallow stroke with ink >3× width — "JUST DO IT" is 4.7×), band-cluster
drop (≥4 strokes in one shallow row), speck drop, span-based keep-guard
(ink/salience guards both wrongly protect wordmarks), thin-ribbon →
centerline collapse (the swoosh alone traces at coverage 1.000).

## Honest limits

- A keeper means: strangers name it correctly 3/3 and Mapbox walks it.
  It does NOT mean reference-grade. Against Cameron's work ours still
  wobble (sub-block jitter, lumpy limbs) and carry no landmark wit.
- The unresolved core, now precisely isolated: compositions that pass
  stage-A can still tangle at street resolution. Visual feedback of the
  street render to the designer is the current counter-measure.
- Cost ≈ $1-2 per commission run (design + judges); ~30-45 min wall time
  for 6 rounds, unattended.
