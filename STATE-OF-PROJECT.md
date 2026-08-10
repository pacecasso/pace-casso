# State of PaceCasso — handoff notes for an independent review

Written July 23, 2026, by the AI (Claude) that worked this project, at the
owner's decision to seek a second opinion. Everything below is checkable
from artifacts in this repo — verify it, don't trust it.

## What the product was supposed to do
Upload a logo/image → get a runnable city route that a stranger would
recognize as that image ("GPS art"), automatically, comparable to
human-made reference pieces (see `sneaker.jpg`, `LOVE.png`, `nikegood.jpeg`).

## The measured state (verify these first)
- `AUDIT-SCORECARD.png` (repo root): 12 diverse test images through the
  full production pipeline (live vision + Mapbox + street tracing),
  pick #1 blind-judged by 3 independent model judges with no context.
  **Result: 1/12 recognized** (a simple heart). Raw data:
  `tmp-lockup-probe/audit/rows.json`, rig: `tmp-lockup-probe/audit.ts`.
- `AUDIT2-SCORECARD.png`: same 12 images through the iterative artist
  loop (design → compile to streets → blind-judge → redraw, up to 12
  rounds/image). **Result: 3 delivered, 1 verified by independent
  judges** (pacelogo → "running person"). Two deliveries failed
  independent verification (wrong subject / judges saw "dog"). Raw:
  `tmp-lockup-probe/audit-loop/rows.json`.
- A third formulation (streets-as-ink: select street segments matching
  the sketch, traverse with free doubling-back — matches how human GPS
  artists actually work per the owner's direct conversations with them)
  was probed and falsified July 23: even re-drawing a human artist's own
  proven composition (extracted from `sneaker.jpg`) produced routes
  judges called "nothing recognizable". Probes:
  `tmp-lockup-probe/probe-segment-paint.ts`, renders `paint-*.png`.

## Key technical findings a reviewer should know
1. **The internal quality scores are misleading.** The pipeline's
   "shape match" (86-91 on failed routes) measures fidelity to the
   traced sketch, not recognizability. This is why progress looked
   real internally for months while blind judges saw mush.
2. **The blind-squint test is the only signal that ever predicted
   human judgment**: `scripts/blind-squint-test.mjs` (3 judges, no
   context, crop-to-route). All numbers above use it.
3. **The bottleneck is not prompting.** Dozens of prompt variants moved
   failure modes around without moving the ceiling. The models cannot
   emit precise coordinate art (hand-drawn letter coordinates were
   measured at 15 consecutive drafts, zero recognized), and street
   quantization destroys detail below ~200 m regardless of method.
4. **What genuinely works** (all verified): bold single closed shapes
   (heart at 100%); organic single figures occasionally (one unicorn at
   3/3 conf 8, one runner logo at 3/3 conf 6 — each after ~11-12 judge
   rounds); street-true single-line text via the lattice typesetter
   (`lib/latticeText.ts`, JUST/DO IT judged 3/3 at 7-8). Words-only
   routes were removed from the product because they replace the user's
   art.
5. **Measured impossibilities** (each tested multiple ways): readable
   multi-letter outlines as one street route; two-object scenes (never
   once recognized); the full symbol+slogan lockup at island-fitting
   scale.

## Current site state (commit 64d1f892)
Honest manual flow only: upload/draw → trace → touch-up → approve →
place → snap to real streets (Mapbox) → edit (zoomable editor) → export
GPX. All AI-generates-the-art UI removed at the owner's direction.
Server endpoints `/api/vision-design` and `/api/artist-loop` still exist
but are not user-reachable.

## Where the history lives
- Commit messages on `main` narrate every change and its verification.
- `tmp-lockup-probe/` holds ~40 probe scripts and renders from the
  final investigation days.
- `CLAUDE.md` documents conventions, gates, and the pipeline map.

## For the reviewing AI
The owner has spent months and real money. Before proposing anything:
1. Reproduce the audit (`tmp-lockup-probe/audit.ts`, needs the dev
   server on :3000 and API keys in `.env.local`; ~$3).
2. If you believe you can beat 1/12, demonstrate it on the same 12
   images with the same blind-judge protocol BEFORE building product
   features. The rigs are ready to run.
3. Be direct with him about capability limits versus prompting. He has
   paid too much for optimism already.
