# Emoji user test — 2026-09-07 (phone, iPhone 13 viewport, headless Chromium)

Tester: first-time visitor, recreational runner, no design background. Test image: the 🐟 fish emoji at ~600 px on white (`tmp-inkline/emoji-test/emoji.png`). City: Manhattan. Screenshots in `tmp-inkline/emoji-test/`.

## Verdict

The flow works end to end on a phone and a valid GPX arrives, but the route does not look like a fish. It is a jagged 14 km blob over the Lower East Side with a bump on top. The site says so itself ("NOT YET RECOGNIZED") and two screens later says the opposite ("Artwork reads well — 98%"). I would not pay $5/month today. Likeness 3/10, happiness 3/10, pay likelihood ~15%.

## Step-by-step log

1. **Pick city** — `01-city-gate.png`. ~1.5–4.5 s load. Kept Manhattan.
2. **How you'll draw** — `02-source-choice.png`. "From a photo" / "Draw on the map", plus gallery routes and starter shapes; 3500 px tall for a two-button decision. The "Loop" starter showed "Checking map…" permanently.
3. **Trace your shape** — `03-upload-screen.png`, `04-trace-after-upload.png`. Upload → outline in ~2 s; a decent fish (body, top fin, tail). Copy: "Looking good — this can be run as one continuous line." Typo: "The yellow dashesare short hops".
4. **Place on map** — `05-place-on-map.png`, `05b-find-my-route-button.png`. First thing visible is "PLACE IT MYSELF →"; "FIND MY ROUTE" is below the fold of an inner scroll panel. Easy to tap the wrong one.
5. **Search** — `06-search-01-5s.png` … `06-search-21-407s.png`, polled every 20 s. Messages: "Reading your image as a filled shape… Working on it…" (0–45 s); "Tracing your shape onto real streets (close fit)…" (65 s, draft appears); "Tracing again with longer, cleaner street runs…" (85 s); "Asking independent judges to name candidate route 1 of 2… (about 20 s each)" (106 s), "2 of 2" (126 s); done by 146 s: "This is our first draft — not yet recognized by strangers. Tap 'Continue with this draft' to tweak it on the map, or run the search again." **First draft at 65 s, finished at ~2 min 26 s.** Only one candidate ever shown. Card (`07-draft-card.png`, `07d-draft-thumbnail.png`, `07e-draft-status.png`): "1 · FIRST DRAFT · 14.9 km · 1h 29m · NOT YET RECOGNIZED · CLEAN ROUTE 48%". The card is taller than the phone panel, so the thumbnail cannot be seen whole.
6. **Snap to streets** — `08-snap-step.png`, `08c-snap-map-only.png`. ~3 s. Banner: "CHECK THIS — First draft — not yet recognized … no stranger named it at a glance." Directly beneath: "Looks like your art 100%", "Tight fit 100%", "Clean route 48%". 14.85 km, "Walk ~178 min · Run ~89 min".
7. **Tune your route** — `09-editor.png`, `09e-editor-view-options.png`. ~3 s. Banner "Route doubles back". The map is ~250 px tall and a "Quick tips" popover covers half of it, advising "Shift+click selects more than one point" — on a phone. View options: Clean route now 36%. 562 pts, ~14.2 km · 1h 25m. No edits made; tapped "Looks good".
8. **Export & share** — `10b-export-full.png`, `11-after-gpx-click.png`, `12b-export-final-full.png`, `12-export-map-final.png`. ~4 s. "ROUTE READY — PREVIEW & EXPORT". **Distance 14.2 km, Est. time 1h 25m** (6:00/km), 562 waypoints. Cards: "HEAVY ROUTE CLUTTER 36% — Quite a bit of doubling back" and "ARTWORK READS WELL 98% — Your art reads loud and clear from above." "Cues (.txt)" was disabled ("Building turn-by-turn cues…") for about a minute, then enabled: 209 steps, the first four being "Turn left onto Delancey Street (short out-and-back, then return to Orchard Street)" ping-ponging with Orchard Street.
9. **GPX download** — `download` event fired on first tap; toast "Saved pacecasso-route.gpx to your downloads folder." **pacecasso-route.gpx, 34,937 bytes**, valid GPX 1.1, 227 `<trkpt>` plus named `<wpt>` cues.

## Ratings

**Looks like the emoji: 3/10.** `12-export-map-final.png` is a lumpy loop from Hudson St to Avenue C with a spike at top and a notch at right. Knowing it is a fish, I can squint the notch into a tail. A stranger would say "a cloud", "a bird", or "Australia". The Step 3 trace was a clear fish; the street version lost it.

**Happiness: 3/10.** Nothing crashed, waits were short and narrated, the GPX is real. But the promise is a picture on a map, and I would not post this or run 14 km for it.

**Likelihood to pay $5/month: 15%.** Drivers: (1) the result is not recognizable, which is the only thing I would pay for; (2) the site contradicts itself about quality, so I do not trust the 98%; (3) doubling back and out-and-back openers make the route feel unfinished. To reach 80%: a route a friend can name unprompted from a Strava thumbnail, at least two candidates to choose from, and consistent honest scoring.

## Broken, unpolished, or dishonest

- **Contradictory quality claims** for the same route: "NOT YET RECOGNIZED / no stranger named it" (Steps 4–5) vs "Looks like your art 100%" (Step 5) vs "ARTWORK READS WELL 98%" (Step 7). The 98% is what a paying user sees last, and the experience does not support it.
- Clean route 48% → 36% and distance 14.9 → 14.2 km with no edits.
- "Find my route" hidden below the fold on phone; "Place it myself" reads as the primary action.
- Draft thumbnail clipped inside a ~230 px panel; you cannot see the draft you are asked to accept.
- "Quick tips" popover covers the tiny editor map with desktop advice ("Shift+click").
- "Checking map…" stuck on the Loop starter; typo "dashesare".
- "Top picks" and "candidate 1 of 2 / 2 of 2" messaging, but only one draft offered.
- Cues open with four consecutive "short out-and-back" instructions.
