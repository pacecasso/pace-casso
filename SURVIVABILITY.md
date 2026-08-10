# SURVIVABILITY — which subjects survive the street grid?

Read-only experiment, 2026-07-25. No pipeline code touched, no Mapbox, no
placement search — this isolates ONE variable: what a Manhattan-pitch
rectilinear grid does to clean line art.

**The three numbers:**

1. **Mean hit rate on A (clean line art): 77.8%** — our line art mostly reads.
2. **Mean hit rate on B (gridded): 63.3%** — most of it survives the grid.
3. **A − B = 14.4 points** — the cost of the street medium is real but modest;
   the big failures are subject-specific, not universal.

## Method

- 30 subjects as line-art contours. Provenance: **lion, tiger,
  gas-pump-person** are the production Step-1 tracer's output on the repo's
  own uploads (lion.webp, TIGER.webp, gas.png) — the app's actual line art;
  **martini glass** is the verbatim "outline-only" template from the
  tournament scripts; the other 26 are hand-authored icon-grade polylines
  (`tmp-funnel-measure/surv.ts`). One swap from the suggested list: **phone
  handset → WiFi symbol** (the handset could not be authored recognizably as
  a single stroke; WiFi is a fair "simple bold logo").
- **Image A**: contour rendered alone (red line, plain background), 4 km max
  extent.
- **Image B**: same contour densified at 40 m, each sample snapped to a
  **250 m × 80 m** lattice (Manhattan avenue/street pitch), consecutive nodes
  joined with **L-shaped (horizontal-first) connections**. No optimization of
  any kind. At 4 km extent that grid offers 16 columns × 50 rows.
- Judge: `scripts/blind-squint-test.mjs` **unmodified** (`claude-opus-4-8`,
  3 runs per image, zero context). 180/180 calls succeeded.
- HIT rules are generous same-family regexes (documented in `surv.ts`,
  e.g. "plus sign" counts for cross, "checkmark" for swoosh, "horse" for
  unicorn). Borderline calls are flagged under the table.
- Raw data: `tmp-funnel-measure/surv-results.json`, images in
  `tmp-funnel-measure/surv-img/`.

## Results

| Subject | Group | A | B | A guesses (verbatim ×3) | B guesses (verbatim ×3) |
|---|---|---|---|---|---|
| heart | banker | 3/3 | 3/3 | Heart / Heart / heart | Heart / Heart / Heart |
| star | banker | 3/3 | 3/3 | Five-pointed star ×3 | A star / A star / A star |
| crescent moon | banker | 0/3 | 3/3 | Letter "a" / Letter a / Letter a | Crescent moon ×3 |
| arrow | banker | 3/3 | 3/3 | Right arrow / Arrow (pointing right) / Arrow | Arrow (right) / Arrow (pointing right) / Arrow pointing right |
| lightning bolt | banker | 3/3 | 3/3 | Lightning bolt ×3 | Lightning bolt ×3 |
| letter A | banker | 3/3 | 0/3 | Letter A ×3 | **Christmas tree ×3** |
| cross | banker | 3/3 | 3/3 | Plus sign ×3 | Plus sign ×3 |
| house | banker | 3/3 | 3/3 | House / house / house | House ×3 |
| fish | banker | 3/3 | 3/3 | Fish / Fish / Fish | A fish / Fish / A fish |
| tree | banker | 3/3 | 3/3 | Christmas tree ×3 | Christmas tree ×3 |
| Nike swoosh | brand | 1/3 | 0/3 | Bird/seagull / Bird/checkmark / Bird / seagull | Smile/mouth ×3 |
| Apple logo | brand | 3/3 | 3/3 | Apple logo ×3 | Apple / apple / Apple |
| Twitter bird | brand | 3/3 | 3/3 | A bird ×3 | Bird ×3 |
| play button | brand | 3/3 | 3/3 | Play button ×3 | Play button ×3 |
| McDonald's arches | brand | 3/3 | 0/3 | Letter M ×3 | **City skyline ×3** |
| power symbol | brand | 0/3 | 0/3 | Balloon ×3 | Apple ×3 |
| WiFi symbol | brand | 3/3 | 0/3 | WiFi symbol ×3 | Tree/Mushroom / Tree / Tree |
| envelope | brand | 3/3 | 3/3 | Envelope ×3 | Envelope ×3 |
| music note | brand | 3/3 | 3/3 | Musical note ×3 | Musical note ×3 |
| peace sign | brand | 3/3 | 3/3 | Peace sign ×3 | Peace sign / Peace sign / Peace symbol |
| martini glass | hard | 3/3 | 3/3 | Martini glass ×3 | **Martini glass ×3** |
| lion | hard | 0/3 | 0/3 | Letter C ×3 | Letter C ×3 |
| unicorn | hard | 0/3 | 0/3 | Dog ×3 | A dog / A dog / A dog |
| gas-pump-person | hard | 3/3 | 3/3† | Person at gas pump ×3 | Person with sign / Person and door / person with dog |
| cat | hard | 3/3 | 3/3 | Cat / A cat / Cat | A cat / Sitting cat / A cat |
| dog | hard | 0/3 | 3/3 | Horse / A horse / Horse | A dog / A dog / A dog |
| tiger | hard | 0/3 | 0/3 | Letter Y ×3 | Letter U / Letter V / Letter V |
| witch | hard | 3/3 | 0/3 | Witch on broomstick ×3 | A key / A person/figure / A key |
| bicycle | hard | 3/3 | 0/3 | Bicycle ×3 | Tractor ×3 |
| guitar | hard | 3/3 | 0/3 | Guitar ×3 | A key / A key / A key |

† **Generosity flag**: gas-pump-person's B hits ride on the `/person/`
pattern — the judge saw a person ("Person with sign / Person and door /
person with dog") but never the gas pump. Half the subject survived. Under a
strict "pump" reading, B = 0/3 and the subject drops off the product list.

## The product — subjects that scored 3/3 on B (gridded)

**19 of 30** (18 with the strict gas reading):

heart · star · crescent moon · arrow · lightning bolt · cross · house · fish ·
tree · Apple logo · Twitter bird · play button · envelope · music note ·
peace sign · **martini glass** · gas-pump-person† · cat · dog

## What the data actually says

- **The grid is not the villain for bold silhouettes.** 19 subjects survive
  quantization at 100%, including curved shapes (heart, Apple logo, crescent,
  Twitter bird, cat). Twice the grid *helped* (crescent moon A 0/3 → B 3/3;
  dog A 0/3 → B 3/3).
- **Martini glass survives the abstract grid 3/3** — yet scored 0/136 in
  CALIBRATION.md on real streets. The tournament routes' failure is therefore
  NOT inherent to grid quantization of the martini template; it lives in what
  the real-street lattice compile does beyond clean L-quantization (real
  Manhattan geometry, detours, dropped pins, the placement itself).
- **What the grid kills, specifically**: shapes whose identity is a diagonal
  or fine curve at sub-cell scale — letter A (→"Christmas tree"), swoosh
  (→"smile"), McDonald's arches (→"city skyline"), WiFi arcs (→"tree"),
  bicycle (→"tractor"), guitar (→"key"), witch (→"key").
- **Three subjects fail before the grid ever sees them**: lion (→"Letter C"),
  tiger (→"Letter Y"), unicorn (→"Dog") were unrecognizable as clean line art
  (A = 0/3). For lion and tiger that clean line art is the production
  tracer's own output — consistent with every earlier lion result in
  FUNNEL.md. Their B failures carry no information about the grid.
- The witch/bicycle/guitar A-successes (3/3 each) show the authored art was
  fine; those are pure grid casualties.

## Caveats

- 26 of 30 contours are hand-authored for this experiment; A hit rates
  measure that authorship as much as any pipeline (deliberately — "clean line
  art, no streets, no routing" was the spec). The three traced subjects use
  the app's real tracer output.
- One lattice (250×80, L-connections, horizontal-first, 40 m sampling), one
  extent (4 km), one judge model, 3 runs per image. Real streets add curves,
  broken grid, parks, and rivers that this abstraction omits — CALIBRATION.md
  measures that layer.
- The `letter A` B-failure is partly an artifact of retrace strokes: its
  crossbar retrace staircased into a symmetric triangle. Different stroke
  order could grid differently; not tested (no optimization allowed by spec).
