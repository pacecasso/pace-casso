# PaceCasso — acceptance tests (“good enough to tweak”)

Use these to decide if the product hits the bar: **recognizable + editable**, with **mobile** in scope. Run with real users when possible; you can pilot solo first.

---

## 1. Recognition at a glance

**Prompt:** Complete the flow with a **simple** uploaded shape (e.g. a block letter or a 4–5 segment doodle) in a **grid-like** area (e.g. midtown Manhattan if that city preset exists).

**Pass if:** Without telling them what it’s supposed to be, they say the snapped route **“basically looks like”** the idea, or they name it correctly within **~10 seconds** of looking at the map at a **normal share zoom** (pick one zoom level and use it every time).

**Fail if:** They’re confused what it was supposed to be, or say it looks like something else entirely.

---

## 2. Time-to-“good enough” with editing

**Prompt:** Same starting sketch; they may use **only** the shipped tuning tools (waypoints, route editor, etc.).

**Pass if:** They say they’d be **okay posting or running it** after **≤ 3 minutes** of edits (use a timer), or they stop earlier because they’re already happy.

**Fail if:** They’re still fighting the line after 3 minutes, or they abandon.

---

## 3. Predictability of snap

**Prompt:** Run **snap twice** from the **same** placement (same city, same sketch position, same inputs).

**Pass if:** The two results are **similar enough** that they don’t feel “random” (judge: same general path shape; small differences OK).

**Fail if:** Wildly different routes, or they say it feels random.

---

## 4. Emotional bar: “I’d tweak, not restart”

**Prompt:** After first snap, ask only: **“Would you rather tweak this or start over?”**

**Pass if:** **≥ 4 out of 5** sessions they say **tweak** (or equivalent).

**Fail if:** Majority want to **start over**.

---

## 5. End-to-end success (the “share” test)

**Prompt:** **One full path:** sketch → snap → minimal edit → **export** (GPX or screenshot of final route).

**Pass if:** They say they’d be **willing to use this output** for a real run or share (even if “not perfect”), **or** they rate **≥ 3/5** on “I’d use this” without pressure to inflate.

**Fail if:** They won’t commit to using it or rate **≤ 2/5**.

---

## 6. Mobile usability (touch + layout + map)

**Prompt:** On a **real phone** (Safari iOS and/or Chrome Android), go through at least: **landing → `/create` → city → one source path → a map step** (place or snap).

**Pass if:**

- No bad **horizontal scroll** on key screens.
- **Taps work reliably** on primary actions (Continue, Back, snap step actions).
- **Map + panel** is usable: read sidebar, pan/zoom map, reach Back / next.
- **Safe areas**: bottom actions aren’t permanently hidden by the browser chrome (use safe-area padding or keep actions reachable).
- No **hover-only** critical UI.

**Fail if:** You wouldn’t hand the phone to a friend for the create flow, or any critical action is unreachable.

**Optional:** Time the mini-flow vs desktop **within ~2×** (rough sanity check).

---

## How to start with Step 1

1. **Pick one “simple” asset** ahead of time: e.g. a high-contrast silhouette or block letter PNG (not a busy photo).
2. **Pick one city preset** that tends to have a regular grid (easier recognition).
3. **Open `/create`** locally or on production; run: city → image source → trace → place → snap (through whatever your current minimum path is).
4. **Set the map** to the zoom you’d use for a social post; **don’t** say what the shape is.
5. **Ask one question:** “What does this look like to you?” or “Does this remind you of anything?” Start a **10-second timer** after the map is visible.
6. **Record:** pass/fail + one sentence of feedback. Repeat with **2–3 different testers** if you can.

**You’re not tuning the algorithm yet** — you’re establishing whether the current pipeline can clear the **recognition** bar. If Step 1 fails often, prioritize contour/snap/editing before city-wide “suggestions.”
