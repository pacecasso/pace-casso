# Catalog re-verification — Aug 11, 2026

## Why

A positive control (never previously run) validated the blind instrument:
the human-made reference pieces pass it cleanly — sneaker.jpg "Running
shoe" 8/8/8, LOVE.png "LOVE" 8/8/8. The same control caught a shipped
"verified" route (LES heart) reading "a dog" 0/3. Every shipped route was
therefore re-judged: OSM render, zero-context judge, 3 runs, two
independent rounds. Rule: pass BOTH rounds 3/3 or leave the public
catalog. Raw verdicts: tmp-gas-commission/reverify/results-round{1,2}.json
(plus a cropped-render tiebreak for the two split verdicts).

## Results

| Route | Round 1 | Round 2 | Verdict |
|---|---|---|---|
| Greenwich Village Heart | 3/3 (conf 9) | 3/3 (conf 9-10) | KEEP |
| Downtown Elephant | 3/3 (8) | 3/3 (8-9) | KEEP |
| Manhattan Runner | 3/3 (7-8) | 3/3 (8) | KEEP |
| The Big Apple | 3/3 (8) | 3/3 (7-8) | KEEP |
| Midtown Apple (bank) | 3/3 (6-7) | 3/3 (7) | KEEP |
| Downtown Grin (smiley) | 2/3 | 3/3 (conf 3) | PULLED (tiebreak: "Apple/Heart/face") |
| Uptown Giraffe | 0/3 "dog" | 0/3 "dog" | PULLED |
| Downtown Sneaker (bank) | 0/3 | 0/3 "nothing" | PULLED |
| Midtown Sailboat (bank) | 0/3 | 0/3 "dog" | PULLED |
| LES Heart (bank) | 0/3 "dog" | 0/3 "dog" | PULLED |
| Chelsea Turtle (bank) | 0/3 "dog" | 0/3 "dog" | PULLED |
| Flatiron Key (bank) | 2/3 | 3/3 (7) | PULLED (tiebreak: "dog" ×3) |
| Dupont Martini (bank) | 0/3 "dog" | 0/3 "dog" | PULLED |
| Midtown Umbrella (bank) | 0/3 "dog" | 0/3 "dog" | PULLED |
| Midtown Trophy (bank) | 0/3 | 0/3 | PULLED |

**5 of 15 kept.** The pulled routes' data and tests remain in the repo;
they are no longer displayed, exported under a "Verified" title, offered
by the refusal offramp, or injected as verified candidates.

## Standing rule

A route may be publicly called verified only while it passes the blind
instrument 3/3 in two independent rounds. Re-verification should re-run
whenever the judge model, render style, or route geometry changes.
