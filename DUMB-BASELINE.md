# DUMB-BASELINE — SURVIVABILITY's algorithm on real streets, nothing else

Read-only measurement, 2026-07-25. No production code modified.

**Headline: the dumb baseline's hit rate is 29.8% — HIGHER than the full
production pipeline's 21.1% on the same 19 subjects. It matched production on
all four of production's wins and beat it outright on two more (star,
Twitter bird). It lost to production on nothing.**

## The algorithm (all of it)

`tmp-funnel-measure/dumb.ts`:

1. Densify the contour at 40 m.
2. Snap each sample to the nearest real intersection in the cached OSM walk
   graph (`lib/data/manhattan-walk-graph.json`, via the exported
   `getStreetGraph`).
3. Connect consecutive intersections by plain shortest street path (A*,
   meters).

No placement search. No scoring. No vision. No spur cleanup. No retries.
One fixed placement for all 19 subjects: **axis-aligned (0° rotation),
2,750 m max extent (~11 avenue columns), centered on Chelsea/Flatiron
(40.745, −73.990)** — picked once, before any results were seen, as "a
sensible solid-grid location," and never adjusted.

Judge: `scripts/blind-squint-test.mjs` unmodified, 3 runs per image
(57/57 calls clean). Same generous HIT rules as SURVIVABILITY/PIPELINE-GAP.
Images: `tmp-funnel-measure/dumb-img/`, data: `dumb-report.json`,
route polylines: `dumb-img/dumb-<key>.json`.

## Per-subject: dumb baseline vs the production top-1 (PIPELINE-GAP)

| Subject | Dumb | Production | Dumb km | Prod km | Dumb verbatim guesses (conf) |
|---|---|---|---|---|---|
| heart | **3/3** | 3/3 | 17.7 | 10.2 | Heart (10) / Heart (10) / Heart (10) |
| star | **3/3** | 0/3 | 24.0 | 12.8 | A star (6) / A star (6) / A star (6) |
| crescent moon | 0/3 | 0/3 | 22.0 | 19.1 | number zero (3) / number 6 (4) / number zero (3) |
| arrow | 0/3 | 0/3 | 20.3 | 13.3 | Dog (3) / Dog (3) / Dog (4) |
| lightning bolt | 0/3 | 0/3 | 14.6 | 13.4 | A dog (3) / Christmas stocking (3) / Running person (3) |
| cross | 0/3 | 0/3 | 26.4 | 13.8 | Airplane (6) / Airplane (5) / Airplane (6) |
| house | 0/3 | 0/3 | 22.5 | 14.1 | heart (6) / heart (6) / Heart (6) |
| fish | 0/3 | 0/3 | 18.0 | 10.6 | dog/animal head (3) / A dog (3) / dog (3) |
| tree | 0/3 | 0/3 | 19.0 | 11.2 | Dog (3) / Dog / animal head (3) / Dog (4) |
| Apple logo | **3/3** | 3/3 | 17.0 | 12.8 | An apple (8) / An apple (8) / An apple (8) |
| Twitter bird | **2/3** | 0/3 | 15.2 | 9.1 | A cat (3) / A bird (4) / A bird (3) |
| play button | 0/3 | 0/3 | 30.4 | 19.3 | Number 6 (4) / Ghost (4) / A face (3) |
| envelope | 0/3 | 0/3 | 37.3 | 13.1 | nothing recognizable (2/2/1) |
| music note | 0/3 | 0/3 | 11.7 | 13.3 | Key (6) / Key (5) / Key (6) |
| peace sign | **3/3** | 3/3 | 35.9 | 25.5 | Peace sign (8) / Peace sign (8) / Peace sign (8) |
| martini glass | 0/3 | 0/3 | 20.5 | 14.8 | Running shoe (3) / Running person (3) / Dog head (3) |
| gas-pump-person | 0/3 | 0/3 | 65.7 | 41.9 | nothing recognizable ×3 |
| cat | 0/3 | 0/3 | 20.1 | 18.7 | A dog (3) / A dog (3) / Running person (3) |
| dog | **3/3** | 3/3 | 24.1 | 13.1 | Dog (3) / dog (3) / Dog (3) |

**Mean hit rate: dumb baseline 29.8% vs production 21.1%.** Per subject the
dumb baseline is ≥ production on 19 of 19, strictly better on 2.

## What this measures

The production pipeline spends, per subject: a placement sweep over ~2,000
placements, ~28 Mapbox-snapped candidates (~130-650 Directions/Matching
calls), lattice compiles, street traces, three Claude calls (hint, design,
composite-grid rank) — and the result is *less* recognizable than 40 m
densify → nearest intersection → shortest path at one arbitrary fixed
axis-aligned spot.

Where the dumb baseline's wins came from:

- **star**: production's lattice compile melted the points (judged "A dog");
  the dumb star kept all five points at 0° rotation and was judged "A star"
  three times — the first recognizable star this repo's measurements have
  produced on real streets.
- **Twitter bird**: production's trace melted it into a quadruped blob; the
  dumb version stayed a bird 2 of 3 runs.
- Both wins are exactly the failure modes PIPELINE-GAP attributed: rotation
  and compile/trace melt. Removing them (axis-aligned, shortest-path-only)
  recovered the shapes.

Shared losses (both 0/3): the same diagonal/fine-feature shapes the abstract
grid already killed in SURVIVABILITY (bolt, WiFi-class curves), plus shapes
where the dumb method's own weaknesses bite — the envelope's doubled west
edge and wandering flap ("nothing recognizable" — it survived the abstract
grid but not real-street double-strokes), house's door melting into the
silhouette ("heart"), martini's V dissolving on the 29° grid.

## Caveats

- One fixed location and scale, chosen a priori; no attempt to tune it. Some
  0/3s might read elsewhere or bigger — untested by design.
- Dumb routes are longer than production's (median ~20 km vs ~13 km; the
  2-component gas contour produced an absurd 65.7 km — the dumb algorithm has
  no honesty gates at all, which production would rightly refuse to ship).
- 12 of 19 dumb routes contain 2-21 short straight jumps where the walk graph
  was locally disconnected (counts in `dumb-manifest.json`); none visually
  dominant.
- One judge model, 3 runs; same "dog" prior noted in earlier reports.
- This does NOT say "ship the dumb algorithm" — it has no water/park
  awareness, no distance control, no placement quality. It says the
  *recognizability* value added by the current search/compile/rank stack is
  negative on these subjects, and the losses are concentrated in rotation
  and shape-melt, which the dumb path avoids.
