"""Drop-in for the /draw worker: one upload -> routes.json in the exact shape
worker.ts posts ({ routes: [{km, points:[[lat,lng],...], label}], note, words, ranked }).

  python draw_job.py <upload> <jobdir> [--text=keep|drop] [--lineart]

Lanes: 'pick' (~20 km), 'short' (~10 km), 'alt' (~35 km). The scale budget can
refuse a lane: if the picture's main parts cannot stay readable at a lane's
length the lane is grown to the smallest readable size, and if that lands
over MAX_KM it is dropped with a note. Nothing calls a paid API or the GPU.

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
LANES = [("pick", 20.0), ("short", 10.0), ("alt", 35.0)]
# word logos: three sizes, keep the two whose letters the streets cover best
# (one try per size swung between readable and not on Chanel, Oct 30)
WORD_LANES = [("a", 24.0), ("b", 30.0), ("c", 38.0)]
WORD_KEEP = 2

def main():
    src, out = sys.argv[1], sys.argv[2]
    text_mode = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--text=")), "drop")
    lineart = "--lineart" in sys.argv[3:]
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
    if words:
        # best letters first: the largest Nike (59 km) had the messiest "IT"
        results = sorted(results, key=lambda r: -r[1]["score"])[:WORD_KEEP]
        results = [(lab, r) for lab, (_, r) in zip(("pick", "alt"), results)]
    routes = []
    for label, res in results:
        F.save(res, out, label, label)
        routes.append({"km": res["km"], "label": label,
                       "points": [[float(F.C.lat[n]), float(F.C.lng[n])] for n in res["route"]]})
    if not words and not lineart and P.find_text(mask).any() and text_mode == "drop":
        notes.append("The lettering was left out: text needs roughly 40+ km to read on streets.")
    ranked = bool(words)                    # routes are best-letters-first; the worker keeps that order
    if lineart and words: words = ""       # the worker reads "words" as typed text
    json.dump({"routes": routes, "note": " ".join(dict.fromkeys(notes)) or None, "words": words or None,
               "ranked": ranked},
              open(os.path.join(out, "routes.json"), "w"))
    print(f"{len(routes)} routes: " + ", ".join(f"{r['label']} {r['km']} km" for r in routes))

if __name__ == "__main__":
    main()
