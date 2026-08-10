# LIBRARY — first generated route library (Manhattan, 19 subjects)

Offline generator run, 2026-07-26. Recipe from the measurement series:
dumb tracer sweep (200 placements: 10 centers × 4 extents × 5 rotations
**including axis-aligned 0°**) → hard gates (zero teleports, every sample
within 150 m of a real intersection, Central Park overlap < 15%, 8–20 km) →
dedupe → primed judge (1 run) on every distinct survivor → top 10 per subject
→ blind judge (unmodified `blind-squint-test.mjs`, 3 runs) → **keep only
blind 3/3**.

**Hit rate: 8 of 19 subjects = 42.1%** with at least one blind-3/3 route —
vs 29.8% for dumb-at-fixed-placement and 21.1% for the production pipeline.
**37 keeper routes total.** Three subjects produced keepers that NOTHING in
any earlier experiment achieved on real streets: **house, fish, Twitter bird**.

Funnel: 3,800 placements tried → 307 gated+deduped survivors (gas: **0** — its
two-piece contour cannot route teleport-free anywhere; the zero-jump gate
rejected 168-198/200 placements per subject, mostly walk-graph islands) →
158 top-10 candidates blind-judged (474/474 calls clean) → 37 keepers.

## Browse & pick

- **Contact sheet (all 37, ranked): `tmp-library/KEEPERS-SHEET.png`**
- Per-keeper PNG + GPX: `tmp-library/keepers/<id>.png` / `<id>.gpx`
- Full data: `tmp-library/keepers.json`, survivors in `tmp-library/data/`

Ranking below: primed score, then mean blind confidence. `rot` in degrees
(0 = axis-aligned/north-up, ±29 = Manhattan grid).

### heart — 9 keepers (best: blind confidence 10/10)
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | heart-p7-s1-r1 | 9 | 10.0 | 13.5 | 15 |
| 2 | heart-p2-s1-r0 | 9 | 10.0 | 13.9 | 0 |
| 3 | heart-p2-s1-r2 | 9 | 10.0 | 16.5 | −15 |
| 4 | heart-p0-s0-r1 | 9 | 9.0 | 11.2 | 15 |
| 5 | heart-p0-s0-r3 | 9 | 8.0 | 10.8 | 29 |
| 6 | heart-p0-s1-r4 | 8 | 10.0 | 14.1 | −29 |
| 7 | heart-p0-s0-r2 | 8 | 9.0 | 12.0 | −15 |
| 8 | heart-p1-s0-r1 | 8 | 9.0 | 11.0 | 15 |
| 9 | heart-p0-s0-r4 | 8 | 8.7 | 11.0 | −29 |

### apple — 10 keepers (best: "An apple" conf 9)
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | apple-p3-s0-r0 | 6 | 9.0 | 14.9 | 0 |
| 2 | apple-p2-s0-r3 | 6 | 8.0 | 11.8 | 29 |
| 3 | apple-p2-s0-r2 | 6 | 8.0 | 13.6 | −15 |
| 4 | apple-p1-s0-r0 | 6 | 8.0 | 14.0 | 0 |
| 5 | apple-p5-s1-r2 | 6 | 8.0 | 18.7 | −15 |
| 6 | apple-p9-s0-r3 | 6 | 7.0 | 12.8 | 29 |
| 7 | apple-p2-s1-r4 | 6 | 7.0 | 14.2 | −29 |
| 8-10 | apple-p2-s0-r1 / p9-s0-r0 / p9-s0-r1 | 4 | 7.3-8.0 | 11.5-12.9 | 15/0/15 |

### dog — 7 keepers
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | dog-p2-s0-r4 | 7 | 8.0 | 13.4 | −29 |
| 2 | dog-p2-s1-r4 | 7 | 4.0 | 18.1 | −29 |
| 3 | dog-p2-s0-r0 | 6 | 6.0 | 13.5 | 0 |
| 4 | dog-p0-s0-r4 | 6 | 3.0 | 14.9 | −29 |
| 5-7 | dog-p9-s0-r0 / p1-s0-r3 / p2-s0-r1 | 3-4 | 3.0-5.0 | 13.6-18.7 | 0/29/15 |

### star — 4 keepers (first recognizable street stars, all "A star")
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | star-p2-s0-r3 | 8 | 6.0 | 12.5 | 29 |
| 2 | star-p2-s0-r4 | 8 | 6.0 | 12.6 | −29 |
| 3 | star-p0-s1-r4 | 8 | 4.7 | 16.0 | −29 |
| 4 | star-p5-s0-r1 | 7 | 4.3 | 15.7 | 15 |

### fish — 3 keepers (new — never achieved before)
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | fish-p5-s0-r3 | 6 | 7.0 | 10.7 | 29 |
| 2 | fish-p0-s0-r0 | 7 | 6.0 | 9.1 | 0 |
| 3 | fish-p0-s1-r2 | 6 | 6.0 | 10.9 | −15 |

### peace — 2 keepers
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | peace-p2-s0-r2 | 7 | 8.0 | 19.1 | −15 |
| 2 | peace-p2-s0-r4 | 7 | 8.0 | 19.6 | −29 |

### house — 1 keeper (new — "A house" conf 7, primed only 3!)
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | house-p2-s0-r4 | 3 | 6.7 | 14.6 | −29 |

### twitterbird — 1 keeper (new)
| # | id | primed | conf | km | rot |
|---|---|---|---|---|---|
| 1 | twitterbird-p5-s1-r0 | 4 | 5.7 | 13.3 | 0 |

## Subjects with no keeper (11)

crescent, arrow, bolt, cross, tree, play, envelope, note, martini, gas, cat —
plus notes: gas produced zero gate survivors at all; envelope and peace had
only 3 survivors each (the zero-teleport gate is the binding constraint —
walk-graph islands kill 80-95% of placements). Martini's best primed was 8
but went "Cat face"-family blind again. These need either a cleaned walk
graph (bridging the disconnected pockets would multiply survivors ~5×), a
different city, or a different source contour.

## Observations

- **Rotation matters and axis-aligned earns its seats**: keepers split
  roughly evenly across 0°, ±15°, ±29° — but house/fish/twitterbird's
  first-ever wins include 0° routes production would never have favored.
- **The primed judge is a good but imperfect ranker**: house's sole keeper
  scored primed 3 (rank 1 only because nothing else survived) yet went
  blind "A house" ×3 at conf ~7. Cheap primed screening + blind confirmation
  (exactly this pipeline) is the right two-stage filter.
- Distance distribution of keepers: 9.1-19.6 km, median ~13.5 km — inside
  the product's sweet spot without any distance targeting beyond the gate.

**Next action is yours: open `tmp-library/KEEPERS-SHEET.png`, pick the ones
you like; each has a ready GPX in `tmp-library/keepers/`.**
