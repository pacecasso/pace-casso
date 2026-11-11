"""Drop-in for the /draw worker: one upload -> routes.json in the exact shape
worker.ts posts ({ routes: [{km, points:[[lat,lng],...], label, score}], note, words, ranked }).

  python draw_job.py <upload> <jobdir> [--text=keep|drop] [--lineart]

Lanes: five sizes from ~10 to ~38 km, delivered best match first with a 0..1
score each (match()), so the page can sort them by best or by distance. The
scale budget can refuse a lane: if the picture's main parts cannot stay
readable at a lane's length the lane is grown to the smallest readable size,
and if that lands over MAX_KM it is dropped with a note. Nothing calls a paid
API or the GPU.

Lettering (--text=keep, Oct 30): the logo's words are read offline
(readtext.py), lifted out of the picture, and set back under the mark as
block letters (blocktext.py) that the fit squares up with the street grid.
A logo's own type is too tight for streets: Nike's touching letters came out
as a row of boxes. Lettering needs ~35-50 km, so word logos get their own lanes.

--lineart (Oct 31): the upload is already the simple line drawing that
simplify.py made and the person touched up. Its lines are drawn as they are
(one centre line each), so there is no reading, lifting or readability floor.
"""
import sys, os, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fit as F
import plan as P
import blocktext as B
import readtext as R
import simplify as Z

MAX_KM = 65.0
# the page shows up to MAX_ROUTES versions and lets the runner sort them by best
# match or by distance (Ralph, Nov 9), so every size is delivered with its score
MAX_ROUTES = 5
LANES = [("s10", 10.0), ("s15", 15.0), ("s20", 20.0), ("s28", 28.0), ("s38", 38.0)]
# word logos: lettering needs ~25+ km, so their sizes start there; the fifth
# version is the mark on its own (mark_lane). One try per size swung between
# readable and not on Chanel (Oct 30), which is what the score sorts out.
WORD_LANES = [("a", 24.0), ("b", 28.0), ("c", 33.0), ("d", 38.0)]

MARK_KM = 20.0
MARK_MAX = 24.0       # the page shows it as "Under 25 km"
MARK_MIN = 0.15       # the mark must be this share of the drawing's ink, else it is just a frame or a dot


def mark_lane(mask, words_mask):
    """the touched-up drawing without its blue letters, fitted at ~MARK_KM
    (under MARK_MAX); None when there is too little mark"""
    from PIL import Image
    from scipy import ndimage as nd
    mark = mask & ~nd.binary_dilation(words_mask, iterations=4)
    if mark.sum() < MARK_MIN * mask.sum(): return None
    # the drawing the customer approved, minus its letters, re-centred to fill
    # the canvas (simplifying it a second time mangled it: New Holland's oval
    # with an X became a tree, Oct 31)
    tmp = os.path.join(sys.argv[2], "mark_lineart.png")
    Image.fromarray(np.where(mark, 0, 255).astype(np.uint8)).save(tmp)
    m, _ = Z.masks_of(tmp)
    # the joins and the size the parts need push a 20 km target past 25 (Oct 31
    # review: 26.5 and 35.5 km, so the page hid them): aim lower until it fits
    target, res = MARK_KM, None
    for _ in range(4):
        res = F.fit_lane(m, target, "keep", words_mask=None)
        if res is None or res["km"] <= MARK_MAX: return res
        target *= 0.9 * MARK_MAX / res["km"]
    return res


SHORT_MIN = 21.0      # a short version smaller than this is fitted once more, larger
SHORT_CHARS = 4       # letters that still read under 25 km: beside a mark, this many at most
SHORT_WORD = 5        # ... and a name with no mark, this many
SHORT_COLS = 12       # the short letters are at least 1/12 of the mark's width a cell
# a block letter is 5 cells wide and 7 tall; on the Nov 11 set letters with
# cells of 120+ m read (L, H, D, YUBA, ZETEO) and under 95 m did not (TW, NH,
# CS, CHEF beside busy marks, whose own lines use up the 25 km)
LETTER_CELL_M = 110.0


def fit_under(m, words_mask):
    """the largest fit of this drawing that comes out under MARK_MAX, or None.
    The joins make a route longer than its target by a share that differs per
    drawing (a 20 km target came out 26 to 32 km on the Nov 11 logos), so the
    target is moved by the miss, then halved in between, until the route
    lands between SHORT_MIN and MARK_MAX (or five tries are up)."""
    target, best, lo, hi = MARK_KM, None, None, None
    for _ in range(5):
        res = F.fit_lane(m, target, "keep", words_mask=words_mask)
        if res is None: break
        if res["km"] > MARK_MAX:
            hi = target
        else:
            lo = target
            if best is None or res["km"] > best["km"]: best = res
            if res["km"] >= SHORT_MIN: break
        # between a target that fitted and one that did not, else by the miss
        target = (lo + hi) / 2 if lo and hi else target * (MARK_MAX - 1.5) / res["km"]
    return best


def short_text(words):
    """what is lettered beside the mark on the short version: the name when it
    is SHORT_CHARS or less, else its initials (Nov 11: under 25 km the knot
    with THREE under it was a scribble, the knot with a large TW read)"""
    ws = ["".join(c for c in w if c != " " and c in B.FONT) for w in (words or "").upper().split()]
    ws = [w for w in ws if w]
    if not ws: return ""
    name = " ".join(ws)
    return name if len(name) <= SHORT_CHARS else "".join(w[0] for w in ws)[:SHORT_CHARS]


def letter_count(words_mask):
    """how many block letters the drawing's one row of lettering holds (each
    is 5 cells wide and 7 tall, a cell apart)"""
    ys, xs = np.nonzero(words_mask)
    if not len(ys): return 0
    h, w = ys.max() - ys.min() + 1, xs.max() - xs.min() + 1
    return int(round((w / h * 7 + 1) / 6))


def cell_m(words_mask, res):
    """the size on the street, in metres, of one cell of the block letters"""
    ys, _ = np.nonzero(words_mask)
    return (ys.max() - ys.min() + 1) / 7 * 2 * res["placement"][2] / P.HI


def short_lane(m, words_mask):
    """fit_under, kept only when its letters come out large enough to read"""
    res = fit_under(m, words_mask)
    if res is None: return None
    c = cell_m(words_mask, res)
    print(f"  short version: {res['km']} km, letter cells {c:.0f} m" + ("" if c >= LETTER_CELL_M else " - too small, left out"))
    return res if c >= LETTER_CELL_M else None


def initials_lane(mask, words_mask, text):
    """the mark with `text` in large block letters under it, under MARK_MAX;
    None when there is too little mark, it does not fit, or the letters
    would be too small to read"""
    from PIL import Image, ImageDraw
    from scipy import ndimage as nd
    mark = mask & ~nd.binary_dilation(words_mask, iterations=4)
    if not text or mark.sum() < MARK_MIN * mask.sum(): return None
    ys, xs = np.nonzero(mark)
    mark = mark[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    mh, mw = mark.shape
    g = Z.row_grid(text)
    rows, cols = g.shape
    cell = mw / max(cols, SHORT_COLS)
    th, tw, gap = rows * cell, cols * cell, 2 * cell
    pad = 12
    W, H = int(max(mw, tw)) + 2 * pad, int(mh + gap + th) + 2 * pad
    im = Image.new("RGB", (W, H), "white")
    ox = (W - mw) // 2
    a = np.asarray(im).copy()
    a[pad:pad + mh, ox:ox + mw][mark] = 0
    im = Image.fromarray(a)
    d = ImageDraw.Draw(im)
    for s in Z._letters(g, cell, pad + mh + gap, (W - tw) / 2):
        d.line([(float(x), float(y)) for y, x in s], fill=Z.LETTER_RGB, width=7, joint="curve")
    tmp = os.path.join(sys.argv[2], "short_lineart.png")
    im.save(tmp)
    return short_lane(*Z.masks_of(tmp))


def match(res):
    """how much the route looks like the drawing, on one 0..1 scale for every
    version: the likeness of the whole drawing (less the tilt and broken-line
    charges) and, where there is lettering, how much of it the streets cover,
    half and half (the same order as the fit's own score among word versions;
    the mark on its own has no letters to cover and is judged as a picture)"""
    tcov = res["text_cov"]
    if tcov is None: return float(res["score"])
    return 0.5 * float(res["score"] - tcov) + 0.5 * float(tcov)


def main():
    src, out = sys.argv[1], sys.argv[2]
    text_mode = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--text=")), "drop")
    lineart = "--lineart" in sys.argv[3:]
    # the name read off the upload at the drawing step, for the short version's letters
    name = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--words=")), "")
    if lineart:
        text_mode = "keep"              # the letters are already lines in the drawing
        F.STYLE, F.OUTLINE_W = "line", 1e9   # every line is one centre line, no size floor
    os.makedirs(out, exist_ok=True)
    words, words_mask = "", None
    if text_mode == "keep" and not lineart:
        try:
            words, boxes = R.read_words(src)
        except Exception as e:          # no OCR available: draw the picture as it is
            print(f"reading text failed: {e}")
    if words:
        try:
            mark, _ = P.ink_parts(R.lift(src, boxes, os.path.join(out, "lifted.png")))
        except ValueError:              # nothing but words: a pure wordmark
            mark = np.zeros((P.HI, P.HI), bool)
        mask, words_mask, _ = B.compose(mark, words)
        F.PARTS = None                  # the canvas was re-laid; colour parts no longer line up
        lanes = WORD_LANES
        print(f"words: {words!r}")
    elif lineart:
        mask, words_mask = Z.masks_of(src)
        F.PARTS = None
        lanes = LANES
        if words_mask.sum() > 0.05 * mask.sum():
            lanes = WORD_LANES
            words = "(letters)"         # rank by how well the letters read, as for word logos
    else:
        mask, F.PARTS = P.ink_parts(src)
        lanes = LANES
    results, notes, seen = [], [], set()
    for label, km in lanes:
        res = F.fit_lane(mask, km, text_mode, words_mask=words_mask)
        if res is None: continue
        if res["km"] > MAX_KM:
            print(f"  {label}: target {km} km came out {res['km']} km, over {MAX_KM:.0f}")
            notes.append(f"No readable version under {MAX_KM:.0f} km."); continue
        key = round(res["km"])
        if key in seen: continue          # a bumped lane can duplicate another
        seen.add(key)
        results.append((label, res))
    if lineart and words:
        # a run under 25 km: lettering needs 30+ km, so the short version is the
        # mark alone, redrawn coarser so its parts stay a few blocks wide
        # (Oct 31 blind customer review: "$10-20 for a recognisable sub-25 km
        # route of my logo"; at 24 blocks across the inside detail blurred)
        short = []
        res = mark_lane(mask, words_mask)
        if res is not None and res["km"] <= MAX_KM:
            short.append(("mark", res))
        # ... and the mark with the name's initials, or the name itself when it
        # is very short (Nov 11 blind review: "mark + name under ~25 km" was the
        # one ask; whole names need 40+ km, two to four large letters do not)
        text = short_text(name)
        res = initials_lane(mask, words_mask, text)
        if res is not None:
            res["text"] = text
            short.append(("initials", res))
        if res is None and not short and 0 < letter_count(words_mask) <= SHORT_WORD:
            # no mark, a short name: the whole drawing fits under 25 km (YUBA, 22 km)
            res = short_lane(mask, words_mask)
            if res is not None and round(res["km"]) not in seen:
                short.append(("word", res))
        # the short versions are always shown; the longer ones fill the rest
        results = sorted(results, key=lambda r: -match(r[1]))[:MAX_ROUTES - len(short)] + short
    # best match first (for word logos that is best letters first: the largest
    # Nike, 59 km, had the messiest "IT"); the page can re-sort by distance
    results = sorted(results, key=lambda r: -match(r[1]))[:MAX_ROUTES]
    routes = []
    for label, res in results:
        F.save(res, out, label, label)
        routes.append({"km": res["km"], "label": label, "score": round(match(res), 3),
                       "points": [[float(F.C.lat[n]), float(F.C.lng[n])] for n in res["route"]]})
        if res.get("text"): routes[-1]["text"] = res["text"]
    if routes:
        # one size coming out too long says nothing when another size is on the page
        # (Oct 31 review: "No readable version under 65 km" beside a 46.5 km route)
        notes = [n for n in notes if not n.startswith("No readable version")]
    if not words and not lineart and P.find_text(mask).any() and text_mode == "drop":
        notes.append("The lettering was left out: text needs roughly 40+ km to read on streets.")
    if lineart and words: words = ""       # the worker reads "words" as typed text
    json.dump({"routes": routes, "note": " ".join(dict.fromkeys(notes)) or None, "words": words or None,
               "ranked": True},
              open(os.path.join(out, "routes.json"), "w"))
    print(f"{len(routes)} routes: " + ", ".join(f"{r['label']} {r['km']} km ({r['score']})" for r in routes))

if __name__ == "__main__":
    main()
