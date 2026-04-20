# pace-casso — Claude Code conventions

Next.js GPS-art app. User uploads a photo / SVG or draws freehand, picks a
city, and the app auto-places the shape on real streets, snaps to a
walkable route, lets the user edit waypoints, then exports GPX / GeoJSON /
cues. Target persona: a runner with no artistic talent who wants to draw
his company logo across a city.

Solo repo — commits go direct to `main`; Vercel auto-deploys on push.

---

## CI gate order — run before every push

```bash
npm run lint                    # ESLint — zero warnings
npx tsc --noEmit                # strict TypeScript
for f in lib/*.test.ts; do npx tsx "$f"; done   # run each test, one-by-one
rm -rf .next && npm run build   # full Next.js build (rm prevents Windows EPERM)
```

Never skip a gate. If lint/tsc/tests/build fail, fix the cause — don't
bypass with `--no-verify`.

---

## Commit style

- Commit messages tell the whole story (root cause, what changed, why it's
  safe, follow-ups). Multi-paragraph is fine — Ralph reads them post-deploy
  to understand what went live.
- Pass multi-line messages via HEREDOC:

  ```bash
  git commit -m "$(cat <<'EOF'
  One-line summary

  Paragraph explaining cause + change...

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```
- One fix per commit, one push per fix — Ralph tests each change on the
  live site after Vercel deploys.

---

## Architecture — 6-step pipeline

| Step | Component | What it does |
|---|---|---|
| 0 | `StepCityGate` | City picker — Manhattan, Brooklyn, Chicago, SF, DC |
| 1 | `StepSourceChoice` + `Step1ImageUpload` / `StepFreehandMapDraw` | Photo / SVG upload (SVG + transparent-PNG skip tracing) or freehand draw |
| 2 | `Step2MapAnchor` | Claude vision ranks 5 candidate placements on city streets |
| 3 | `Step3StreetSnap` | Chunked Mapbox Directions snap to walkable streets |
| 4 | `Step4RouteEditor` | Polyline-first waypoint editing — near-line edits are local, far-line go through Mapbox |
| 5 | `Step5RouteComplete` | Export GPX / GeoJSON / cues; runner profile + pace ETA live here |

**Key principles:**

- **Polyline-first editing** in Step 4: double-tap within 60 m of the red
  line inserts locally (no Mapbox). Drag within 60 m snaps to the line.
  Delete preserves adjacent leg geometry via merge. Only far-line edits
  call Mapbox.
- **City-aware everything:** `cityLabel` is threaded through the vision
  prompts (`app/api/vision-rank`, `vision-hint`). Don't hardcode
  "Manhattan" anywhere.
- **Fast-paths in Step 1:** SVG (`lib/svgToContour.ts`) and transparent
  PNGs (alpha-channel mask) skip the threshold + brush UI entirely.
  Raster threshold flow is the fallback.
- **Runner profile** (`lib/runnerProfile.ts`): pace in seconds per km
  (canonical), unit preference (km/mi), persisted in localStorage. Every
  distance label renders as "X km/mi · Yh Zm".
- **READY-TO-RUN verdict** in Step 4 is the primary confidence signal.
  Raw interpretation % lives behind the "View options" collapsible.

---

## Testing

- Unit tests in `lib/*.test.ts` — use `assert` from `node:assert`, no test
  framework. Run via `npx tsx lib/<name>.test.ts`. Every new lib file with
  pure logic should have a test.
- Browser-only code (uses DOM, canvas, `getPointAtLength`, Leaflet) is not
  unit-testable here — test via the live Vercel site.
- E2E in `e2e/` via Playwright; runs in CI (`.github/workflows/ci.yml`).

---

## Files Ralph frequently drops in the repo root

When Ralph flags a bug, he often drops a screenshot (`.png` or `.webp`) in
the repo root and mentions the filename. Examples so far: `FISH.png`,
`LOVE.png`, `HEART.webp`, `stray.png`, `ways.png`, `waymess.png`. These
are screenshots of the bug — open them with `Read` and reason about what's
visible to infer the code path responsible.

The gitignore already excludes root-level image files, so these don't
pollute the repo.

---

## Current phase

Pre-demo polish for the "Dan the runner" persona (see
`~/.claude/projects/<hash>/memory/user.md`). Pending queue (ranked by
impact per hour):

1. **LOVE centerline fix** — multi-component skeleton extraction. Unlocks
   wordmark / letter routes. ~4–6 h.
2. **Strava-style preview mock on Step 5** — 320×240 grayscale tile with
   route + stats overlay + download-as-PNG. ~4–6 h.
3. **Otsu auto-threshold** — for opaque raster uploads. Lower priority
   since SVG + alpha paths cover most logos. ~3 h.

Don't ship these without Ralph's green light — they involve design
decisions (LOVE multi-letter ordering, Strava preview styling) that need
his input.
