"""Colour-aware drawing plan: segment the upload into its flat colour regions
and give each region its own blocky outline.

A one-colour "ink" mask destroys the inside of a colour logo - the Stones
tongue, teeth and lips all become one blob. Real logos are flat colour areas,
so segmenting by colour and outlining each area keeps the parts a person
actually recognises.

usage: colorplan.py logo.png out.json [cols] [--k=4] [--minarea=0.02] [--preview=p.png]
"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw
from skimage import measure
from scipy import ndimage as nd

R = 224
src, out = sys.argv[1], sys.argv[2]
def opt(k, d):
    for a in sys.argv[3:]:
        if a.startswith(f"--{k}="): return a.split("=", 1)[1]
    return d
COLS = int(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else int(opt("cols", 34))
K = int(opt("k", 4)); MINA = float(opt("minarea", 0.02)); PREV = opt("preview", None)
ASPECT = 3.0
ROWS = int(round(COLS * ASPECT))

im = Image.open(src)
if im.mode in ("RGBA", "LA", "P"):
    im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im)
im = im.convert("RGB")
w, h = im.size; s = max(w, h)
sq = Image.new("RGB", (s, s), "white"); sq.paste(im, ((s - w) // 2, (s - h) // 2))
HI = 560
q = sq.resize((HI, HI), Image.LANCZOS).quantize(colors=K, method=Image.MEDIANCUT).convert("RGB")
arr = np.asarray(q)
cols, counts = np.unique(arr.reshape(-1, 3), axis=0, return_counts=True)
# background = the colour touching the border most
border = np.concatenate([arr[0], arr[-1], arr[:, 0], arr[:, -1]])
bcols, bcounts = np.unique(border, axis=0, return_counts=True)
bg_col = bcols[bcounts.argmax()]

def rect_outlines(cells):
    res = []
    for cnt in measure.find_contours(np.pad(cells.astype(float), 1), 0.5):
        rc = cnt - 1
        p = [(round(x[1] * 2) / 2, round(x[0] * 2) / 2) for x in rc]
        p = [v for i, v in enumerate(p) if i == 0 or v != p[i - 1]]
        m = [p[0]]
        for i in range(1, len(p) - 1):
            (ax, ay), (bx, by), (cx, cy) = m[-1], p[i], p[i + 1]
            if (bx - ax) * (cy - by) != (by - ay) * (cx - bx): m.append(p[i])
        m.append(p[-1])
        if len(m) > 2:
            res.append([[(x + 0.5) / COLS * R, (y + 0.5) / ROWS * R] for x, y in m])
    return res

def to_cells(mask):
    c = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).resize((COLS * 8, ROWS * 8), Image.LANCZOS), dtype=np.float32)
    c = (c.reshape(ROWS, 8, COLS, 8).mean((1, 3)) / 255) > 0.38
    c = nd.binary_closing(c, np.ones((2, 2)))
    lab, n = nd.label(c)
    for k in range(1, n + 1):
        if (lab == k).sum() < 2: c[lab == k] = False
    return c

strokes = []
kept = []
for col, cnt in sorted(zip(cols.tolist(), counts.tolist()), key=lambda t: -t[1]):
    if np.array_equal(np.array(col), bg_col): continue
    if cnt < MINA * HI * HI: continue
    mask = np.all(arr == np.array(col), -1)
    lab, n = nd.label(mask)
    for k in range(1, n + 1):
        part = lab == k
        if part.sum() < MINA * HI * HI: continue
        st = rect_outlines(to_cells(part))
        strokes += st
        kept.append((tuple(col), len(st)))
json.dump({"strokes": strokes}, open(out, "w"))
if PREV:
    p = Image.new("RGB", (R * 3, R * 3), "white"); d = ImageDraw.Draw(p)
    for st in strokes: d.line([(x * 3, y * 3) for x, y in st], fill=(0, 0, 0), width=4)
    p.save(PREV)
print(f"{len(strokes)} outlines from {len(kept)} colour regions {kept}")
