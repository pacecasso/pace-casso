# PaceCasso — independent product audit (2026-09-04)

Scope: live site https://www.pacecasso.com used as a first-time visitor in Chrome, plus a read of the repo code (not git history, not notes). Target user: an NYC runner with no drawing ability who wants a Strava trace that looks like their company logo or a chosen shape. Reference bar: `lion.webp`, `TIGER.webp`, `HEART.webp`, `sneaker.jpg` in the repo root — all four are instantly nameable subjects drawn on the Manhattan grid.

Everything below is what I observed. Where I could not verify something, I say so.

---

## 1. Using the live site

### Landing page (`/` → redirects to static `/landing.html`)

- Headline "Your City Is Your Canvas", sub "Upload a logo, a doodle, or any simple image. PaceCasso redraws it as a real running route on city streets — then you export the GPX and run the picture."
- Stat strip: **"5 Cities"**, "GPX watch-ready export", "Free / No account needed".
- Hero heart image captioned "12.3 km · every block verified walkable".
- Featured gallery: 5 routes, every one "Manhattan · N km".
- Community section says "share your line… help build the crew", then a card titled "What's ahead" admits profiles, saved routes and spotlights are "on the roadmap".
- Nav: Home, Gallery, How It Works, Community, Help; footer adds Privacy and Contact. No Pricing, no Sign in, no Terms.

### Gallery (`/gallery`)

- Copy claims: "Every route here passed the same test twice: independent judges… named the shape correctly three times out of three — and each is checked block by block against live walking directions. We pull anything that stops passing."
- Exactly **5 routes**, all Manhattan: Greenwich Village Heart 12.3 km, Downtown Elephant 23.1 km, Manhattan Runner 16.0 km, The Big Apple 14.6 km, Midtown Apple 12.6 km.
- Card thumbnails were blank white on first paint; they rendered after scrolling.
- Layout bug: on scroll a blank cream band ~100 px tall appears above the sticky nav, and the nav is pushed down over the card images. The third card is clipped at the right edge of a 1536 px viewport (horizontal overflow).
- "Preview on map" opened a modal with a real Leaflet map. The heart is a genuine, readable heart on real streets (lobes are spiky). "Download GPX" → `/api/curated-gpx/catalog-heart` returns `200 application/gpx+xml`, 11.5 KB, valid GPX (verified with curl).

### Community (`/community`)

Heading + the words "Coming soon" + a Start creating button. Nothing else. Verified live with curl.

### How It Works (`/how`)

Four steps. Step 01 says "Pick your city: Manhattan, Brooklyn, Chicago, San Francisco, or Washington DC." Step 02 honestly says "Fine detail and lettering get lost once the route follows real streets."

### Help (`/help`)

Out of sync with the live product: it describes two buttons on the placement step ("Auto-find placement" and "Refine around my placement") and "5 thumbnails in the sidebar"; the live Step 4 has one "Find my route" button and returned exactly one pick in both runs. It says the final step offers "three downloads"; the site offers four. It does honestly state: "Today everything is browser-local — no accounts, no cloud sync, no sharing built in. If you clear the browser draft, you lose the route."

### Create flow — run 1: simple heart (`Red-simple-heart-symbol-only.png`), Manhattan

Timings are from Unix timestamps I recorded around each action.

| Step | What happened | Time |
|---|---|---|
| 1 of 7 Pick city | Dropdown with 5 cities, subtitle "More cities soon!". Note under Manhattan: "letters and portraits shine here." | instant |
| 2 of 7 How you'll draw | "From a photo" / "Draw on the map", plus a "Ready-to-run artwork" shelf of 6 precompiled routes. The Sneaker thumbnail carries a leftover dev label "toe-panel 18.9 km" and looks nothing like the other cards. A "BEST CURR…" tag is clipped off the right edge. | instant |
| 3 of 7 Trace your shape | Raw `Choose file` input, a "Detail" slider, Draw/Erase/Undo/Brush tools, three empty panels. After upload: instant clean heart outline, message "Your drawing works as one continuous line — ready to place on the map." | ~2 s |
| 4 of 7 Place on map | Heart dropped by default over the Upper West Side / Central Park at "≈ 9.88 km". Sliders for Rotate and Scale, an optional "Email me when it's found (optional — you can close the page)" field, and "Find my route". | — |
| Search | First draft appeared at ~7 s: a 23.4 km / 2h 20m heart over Midtown labelled "FIRST DRAFT · Shape 75% · Looks like your art 70% · Clean route 75%". Status then read "Asking independent judges to name candidate route 1 of 3… (about 20 s each)". Final result at **~92 s**: 10.5 km / 1h 03m, "VERIFIED MAP-NATIVE… Everyone we showed the route to — with no hints — named it 'heart'. They saw: heart, heart, heart." | 92 s |
| 5 of 7 Snap to streets | Instant. Banner "READY TO TUNE — Verified runnable GPS art". Bars: Looks like your art 100%, Tight fit 100%, **Clean route 61%**. 10.52 km. | instant |
| 6 of 7 Tune your route | "READY TO RUN — Clean route, all on walkable streets." Waypoint editor (402 pts, Undo/Redo/Set start/Reverse). Distance now shown as "~10.2 km · 1h 01m" while the header still says 10.5 km. | instant |
| 7 of 7 Export & share | "ROUTE READY". 10.2 km, 1h 01m, 402 waypoints, pace field (6:00/km), "Some route clutter 59% — a little doubling back", "Artwork reads well 99%". Turn-by-turn: **70 steps**, including at least four "(short out-and-back, then return to …)" spurs and "Turn left onto 2nd Avenue / Turn sharp left onto 2nd Avenue" back-to-back. Export buttons: GPX, GeoJSON, Cues (.txt), Animation (.webm). Share = "Copy share text" (text + link to pacecasso.com only; the route itself is not shareable). | — |

**What the heart route looks like:** a lopsided heart spanning roughly W 28th St down to Houston St, between 11th Ave and Park Ave S. The left lobe is a chunky bump, the right side is close to a straight diagonal, the top notch is shallow. At city zoom a stranger would say "heart". It is clearly worse than the gallery heart (which is smoother and has two proper lobes) and has visible out-and-back spurs that would show on Strava as stubs.

Wall-clock from landing on Step 1 to the export screen: about 4.5 minutes, of which the search itself was ~1.5 min. (One click on "Find my route" by screen coordinate did not register; a second click via the element did. I attribute that to my tooling, not the site.)

I did not click the GPX download button (file download). The export code path was verified by reading `components/Step5RouteComplete.tsx` and `lib/routeExport.ts`.

### Create flow — run 2: company logo (`gas.png`: blue fuel pump + person with headphones on a yellow disc), Manhattan

| Step | What happened | Time |
|---|---|---|
| 3 of 7 Trace | Opaque PNG so the raster path ran. The "Touch up" panel showed a double-line outline of the pump and the figure (yellow disc dropped). The "Your route line" panel stayed **empty** with a small note "Tap Done first, then adjust." A first-time user would not know Done is required; the heart flow never needed it. | ~2 s |
| After Done | Message: "Your drawing is in three separate pieces. Connect them with the Draw tool, or erase the extras, for a cleaner route." Yellow dashes bridged the pieces. This asks the no-drawing-ability user to draw. I continued without editing, as that user would. | — |
| 4 of 7 Place | Default placement dropped the whole figure over the Central Park reservoir at "≈ 20.73 km". | — |
| Search | First draft at ~30 s: **41.4 km / 4h 08m**, "FIRST DRAFT · Shape 75% · Looks like your art 70% · Clean route 75%". Judges ran on "candidate route 1 of 3". Search ended at **~120 s** with: **"This is our first draft. Nobody we showed it to named it cold, so tweak it on the map in the next step, or run the search again."** The card still displayed "TOP PICK" and the same 75/70/75 numbers. The continue button's accessible label reads "Continue with the verified route shown on the map." | 120 s |
| 5 of 7 Snap | **"READY TO TUNE — Verified runnable GPS art. Blind judges recognized this route on real streets, so it keeps its exact block-by-block path."** Looks like your art **100%**, Tight fit 100%, Clean route **13%**. 41.38 km, "Run ~248 min". This directly contradicts the previous screen. | instant |
| 6 of 7 Tune | "CHECK THIS — Route doubles back. Some streets are retraced in reverse." 1103 points, "~39.1 km · 3h 55m". Still "Looks like your art 100%". | instant |
| 7 of 7 Export | "ROUTE READY". 39.1 km, 3h 55m, 1103 waypoints, "Heavy route clutter 13% — quite a bit of doubling back", and **"Artwork reads well 99% — Your art reads loud and clear from above."** Turn-by-turn: **210 steps**. The map panel was not centred on the route; after zooming out twice the route sat in the bottom-right corner with grey unloaded tiles above it. | — |

**What the gas route looks like:** a dense green/red tangle from about W 40th St to W 13th St, 11th Ave to 2nd Ave. With effort you can see a tall rectangle on the west (the pump body?) and a blob with a stub to the east (the figure?). No headphones, no hose, no disc. A stranger would not name it; I would not name it without having seen the input. It is nearly four hours of running with 210 turns, which is not a route this user will run.

### Confusing copy, dead ends, errors

- No server errors, no crashes, no blank screens in either run. Both flows complete.
- The "verified" language is applied to a route the product itself just said nobody could identify (run 2, steps 5–7). This is the single most damaging thing I saw.
- Percentages are inconsistent across steps: 75/70/75 → 100/100/13 → "99% reads well" for the same failed route; 10.5 km → 10.2 km for the heart.
- Step 3 for an opaque logo silently requires pressing "Done" before anything appears in the third panel.
- Step 3 hands non-artists a brush and says "connect them with the Draw tool".
- Default placement ignores water/parks (heart over Central Park, logo over the reservoir).
- Sticky-header/blank-band layout bug on Gallery and on the export page when scrolled; horizontal overflow on Gallery and on the Step 2 shelf.
- Dev artifact "toe-panel 18.9 km" visible on the Sneaker card.
- Help page documents a different UI than the one shipped.
- "Email me when it's found" is offered, but the code sends only via a Resend sandbox sender that "only delivers to the account owner's own address" (`lib/routeJobEmail.ts`). I did not test it; a stranger's email would almost certainly get nothing.

---

## 2. What is real (repo code only)

| Promise | Status | Evidence |
|---|---|---|
| Pricing / payment | **Does not exist.** No Stripe/Paddle/checkout/subscription code or copy, no `/pricing` route. | grep across `app/`, `components/`, `lib/`, `package.json`; `app/` route list |
| Accounts / auth | **Does not exist.** No NextAuth/Clerk/Supabase, no `middleware.ts`, no user table. | `app/help/page.tsx:186-190` says so |
| Saved routes | **localStorage only.** Draft under `pacecasso-create-draft-v1`; no "my routes" page; no database (no Postgres/KV/Redis/Blob for user data). Only server-side state is an encrypted, transient async-job record on Vercel Blob. | `lib/createDraftStorage.ts:38`, `lib/routeJobStore.ts:16-47` |
| Share a finished route by URL | **No.** Step 5's share copies text plus a link to pacecasso.com. `/create?job=<id>` rehydrates the *input contour*, not a finished route. | `components/Step5RouteComplete.tsx:327-361, 655-657`; `components/WorkflowController.tsx:238-279` |
| Community | **Stub.** Page is heading + "Coming soon". | `app/community/page.tsx:14-16` |
| Gallery | **5 hardcoded Manhattan routes**, coordinates as TS array literals; images are checked-in PNG map screenshots. Nothing user-generated. A manifest lists **20 rejected subjects** (sneaker, tiger, fish, robot…) whose GPX endpoints still resolve, and the rejected Sneaker is still promoted on Step 2 as "ready to run". | `app/gallery/page.tsx:32-40`, `lib/curatedManhattanRuns.ts`, `lib/verifiedRouteBankManifest.ts:29-52`, `lib/readyToRunRouteLibrary.ts:17-31` |
| "5 Cities" | **1 city works.** Non-Manhattan presets carry only a bbox + grid bearings. Road-graph data exists only for Manhattan (`lib/data/manhattan-*.json`). Every generative API (`studio-route`, `street-trace`, `wow-place`, `artist-loop`, `paint-route`, `route-job`) returns manhattan-only for other cities; the Step 2 auto-find button is disabled for them. Live check: POST `/api/studio-route` with `cityId:"brooklyn"` → `{"ok":false,"reason":"manhattan-only"}`. Other cities get manual drag-and-snap only. | `lib/cityPresets.ts:27-125`, `components/Step2MapAnchor.tsx:1034-1035, 1529`, six `app/api/*/route.ts` files, `lib/autoFindTop5.ts` |
| "Every block verified walkable" / "We pull anything that stops passing" | **One-time offline judging.** `lib/routeLegByLeg.ts` and `lib/streetRouteProof.ts` exist but no gallery or app code path calls them; verdict files live in a scratch directory. No cron/CI re-verification. | `lib/verifiedRouteBankManifest.ts:26-27` |
| Strava | **No integration.** No OAuth, no upload. Strava is mentioned only as import advice and in LLM prompt text. | grep; `app/help/page.tsx:135-140` |
| Export | **Real.** GPX, GeoJSON, cue sheet .txt, ~4 s WebM animation. No PNG/Strava-style preview image. | `components/Step5RouteComplete.tsx:191-260`, `lib/routeExport.ts` |
| "Free / No account needed" | **True** — there is literally nothing to pay for or sign into. | — |
| Runtime dependencies | `ANTHROPIC_API_KEY` (503 if missing on 7 routes) and a Mapbox token (throws; blocks all snapping). | `lib/mapboxClient.ts:47`, `app/api/interpret-sketch/route.ts:55-56` |
| Abuse controls | Same-origin check + per-instance in-memory daily budgets (60–600/day per route) and 60 s sliding windows for Mapbox proxies. The module's own comment says these are "not a real barrier" on Vercel. No WAF, no CAPTCHA. Four routes have `maxDuration = 300`. | `lib/apiShield.ts:6-11, 47-75` |
| Analytics / feedback / legal | Plausible pageviews only, no custom events; no feedback form; contact is `mailto:hello@pacecasso.com`; Privacy is a 3-sentence placeholder; **no Terms page**. | `components/PlausibleAnalytics.tsx`, `app/privacy/page.tsx`, `app/contact/page.tsx` |

Summary: the working product is a free, anonymous, Manhattan-only tool that traces an image, searches for a placement with an LLM judge, and exports GPX. Everything on the landing page that implies breadth (5 cities), community, saving, sharing, or ongoing verification is copy.

---

## 3. Verdict

**Would this user pay today? No.**

There is nothing to buy, and if there were, the thing they came for — their company logo as a runnable Strava trace — did not happen. The heart works; a heart is also the one shape every GPS-art hobbyist can already draw by eye on a map. The logo produced a 39 km, 210-turn, four-hour tangle that the product first admitted nobody could name and then, two screens later, certified as "verified" and "reads loud and clear 99%".

If the logo case worked as reliably as the heart case, the realistic price is a one-off **$5–15 per finished route** (or a ~$20–30/year pass for repeat art). Today the fair price is **$0**, and the free gallery heart GPX is the only artifact I would actually run.

### Top five blockers to anyone paying, most severe first

1. **The core job fails on a real logo.** `gas.png` → 41.4 km draft → "Nobody we showed it to named it cold" → 39.1 km / 3h 55m / 1103 waypoints / 210 turns / Clean route 13%. No pump, no figure, no headphones visible. Compare to the reference sneaker (11.25 mi, obviously a shoe). Screenshots 19–22, 25–26.
2. **The product lies about its own result.** After the failure message, Step 5 showed "READY TO TUNE — Verified runnable GPS art. Blind judges recognized this route" with "Looks like your art 100%", and Step 7 showed "Artwork reads well 99%". The continue button is labelled "Continue with the verified route". A user who trusts this will run four hours for nothing and never come back. Screenshots 21 vs 23, 25.
3. **Even the success case is below the bar the site sets for itself.** The custom heart (screenshots 12–15) is lopsided with out-and-back spurs, Clean route 59–61%, and 70 turn cues for 10 km; the gallery heart is visibly better. Distances disagree between steps (10.5 vs 10.2 km). Default placement drops shapes onto Central Park and the reservoir.
4. **Nothing beyond a GPX file exists to pay for.** No accounts, no saved routes (cleared with browser storage), no shareable route link, no Strava push, no preview image, "5 Cities" is one city (`{"ok":false,"reason":"manhattan-only"}`), Community is "Coming soon", Privacy is a placeholder, no Terms. The landing page's breadth claims are not backed by code.
5. **Rough edges that read as unfinished.** Blank band above the sticky nav and clipped cards on Gallery; "toe-panel 18.9 km" dev label on the Sneaker card; a rejected route still promoted as "ready to run"; Step 3 silently requires "Done" for opaque images and asks non-artists to fix the drawing with a brush; the Help page documents buttons that do not exist; the export map does not centre on the route.

### The single most valuable improvement

Make the logo path either produce a recognizable route or say so and stop. Concretely: when the judges cannot name the route, the product must not advance with "verified / 100% / 99%" banners — it should show the honest failure, offer a simplified interpretation (the pump alone, the figure alone, or the disc) capped at a runnable distance, and let the user pick. Until a company logo comes out nameable in under ~20 km, there is no product to charge for; until the confidence banners are truthful, there is no trust to build one on.

One good thing, said once: the heart flow is fast (search ~90 s), the tracer is instant, the waypoint editor and GPX/cue export are solid, and the gallery heart GPX is real and runnable.

---

## Screenshot log

All files are in `C:\Users\ralph\AppData\Local\Temp\claude-chrome-screenshots-pScKBe\`. Viewport 1536 px wide, captured at 1254 px.

| # | File | What it showed |
|---|---|---|
| 0 | `screenshot-1788552649622-0.jpg` | Landing hero: "Your City Is Your Canvas", heart map on the right, nav with Start Creating. |
| 1 | `screenshot-1788552672243-1.jpg` | Gallery top: verification claim paragraph; three cards with blank white thumbnails on first paint. |
| 2 | `screenshot-1788552702398-2.jpg` | Gallery "Greenwich Village Heart" modal: real map, readable heart between 7th Ave and 2nd Ave; blank band + displaced header visible behind. |
| 3 | `screenshot-1788552723100-3.jpg` | Create Step 1 of 7: city dropdown, "More cities soon!", "Continue with Manhattan". |
| 4 | `screenshot-1788552734716-4.jpg` | Step 2 of 7: "From a photo" / "Draw on the map", top of the "Ready-to-run artwork" shelf. |
| 5 | `screenshot-1788552752991-5.jpg` | Step 3 of 7 empty: file input, Detail slider, Draw/Erase/Brush, three blank panels. |
| 6 | `screenshot-1788552781168-6.jpg` | Step 3 with heart uploaded: clean outline in "Touch up", "Transparent PNG trace is ready". |
| 7 | `screenshot-1788552798119-7.jpg` | Step 4: green heart overlay on Upper West Side / Central Park, ≈9.88 km, "Find my route". |
| 8 | `screenshot-1788552825129-8.jpg` | Step 4 unchanged 25 s after a coordinate click (click did not register — tooling). |
| 9 | `screenshot-1788552842846-9.jpg` | Step 4 ~7 s after search start: FIRST DRAFT 23.4 km heart over Midtown, 75/70/75. |
| 10 | `screenshot-1788552881892-10.jpg` | Step 4 at ~46 s: "Asking independent judges… 1 of 3", same draft. |
| 11 | `screenshot-1788552928270-11.jpg` | Step 4 at ~92 s: route found, 10.5 km, VERIFIED MAP-NATIVE, partial heart over Chelsea. |
| 12 | `screenshot-1788552947251-12.jpg` | Step 4 zoomed out: full lopsided heart, W 28th to Houston. |
| 13 | `screenshot-1788552962781-13.jpg` | Step 5 heart: "READY TO TUNE", 100/100/61, red heart at city zoom. |
| 14 | `screenshot-1788552978034-14.jpg` | Step 6 heart: "READY TO RUN", editor tools, 402 pts, Clean 59%. |
| 15 | `screenshot-1788552990628-15.jpg` | Step 7 heart: 10.2 km, 1h 01m, pace field, "Some route clutter 59%". |
| — | (unsaved scroll capture) | Step 7 scrolled: GPX/GeoJSON/Cues/Animation buttons, share box, blank band at top. |
| 16 | `screenshot-1788553065029-16.jpg` | Step 3 gas.png: outline of pump + figure in Touch up, "Your route line" panel empty. |
| 17 | `screenshot-1788553085255-17.jpg` | Step 3 after Done: "three separate pieces", yellow bridging dashes. |
| 18 | `screenshot-1788553098344-18.jpg` | Step 4 gas: figure dropped over Central Park reservoir, ≈20.73 km. |
| 19 | `screenshot-1788553136314-19.jpg` | Step 4 ~30 s: FIRST DRAFT 41.4 km / 4h 08m dense scribble over Midtown West. |
| 20 | `screenshot-1788553179723-20.jpg` | Step 4 ~74 s: judges on candidate 1 of 3. |
| 21 | `screenshot-1788553225843-21.jpg` | Step 4 ~120 s: "Nobody we showed it to named it cold" beside a TOP PICK card still showing 75/70/75. |
| 22 | `screenshot-1788553238904-22.png` | Zoom on the gas route: tall rectangle west, tangled blob east; unnameable. |
| 23 | `screenshot-1788553267563-23.jpg` | Step 5 gas: "Verified runnable GPS art… Blind judges recognized this route", 100/100/13, 41.38 km. |
| 24 | `screenshot-1788553298576-24.jpg` | Step 6 gas: "CHECK THIS — Route doubles back", 1103 pts, ~39.1 km. |
| 25 | `screenshot-1788553319108-25.jpg` | Step 7 gas: ROUTE READY, 39.1 km, 3h 55m, "Heavy route clutter 13%", map not on route. |
| 26 | `screenshot-1788553350601-26.jpg` | Step 7 gas scrolled + zoomed out: "Artwork reads well 99%", 210 turn steps, route in bottom-right corner with grey tiles. |

Not verified: the GPX download click, the "Email me when it's found" delivery, the WebM animation, and the freehand "Draw on the map" path.
