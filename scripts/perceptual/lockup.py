"""Compose a logo lockup for the street grid: mark on top, wordmark below.

Ralph, Sep 23 (comparing my scaffolding letters to July's nikegood.jpeg):
"how much better that just do it is... your letters are terrible". The
difference is stroke WEIGHT - his letters have stems a couple of blocks thick
with real counters, mine were 1-block wireframes - so the words are set in a
heavy typeface and blockified onto the block grid, which keeps thick stems and
holes. The mark keeps its own outline (he preferred the outline swoosh to the
blockified one).

usage: lockup.py "JUST DO IT" out.json [--mark=ink.png] [--cols=30] [--perline=5]
                 [--font=impact] [--preview=p.png] [--markfrac=0.34]
"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from skimage import measure
from scipy import ndimage as nd

R = 224
text = sys.argv[1].upper()
out = sys.argv[2]
def opt(k, d=None):
    for a in sys.argv[3:]:
        if a.startswith(f"--{k}="): return a.split("=", 1)[1]
    return d
COLS = int(opt("cols", 30)); PERLINE = int(opt("perline", 5))
MARK = opt("mark"); PREV = opt("preview"); MARKF = float(opt("markfrac", 0.34))
FONTS = {"impact": "impact.ttf", "black": "ariblk.ttf", "bold": "arialbd.ttf"}
FONT = r"C:\Windows\Fonts\\" + FONTS.get(opt("font", "black"), "ariblk.ttf")
ASPECT = 3.0  # block cells: ~270 m wide, ~80 m tall

def corners(mask, w_cells, h_cells, x0, y0, w_px, h_px):
    """rectilinear outlines of a cell mask -> strokes in 224 space"""
    res = []
    for cnt in measure.find_contours(np.pad(mask.astype(float), 1), 0.5):
        rc = cnt - 1
        q = [(round(p[1] * 2) / 2, round(p[0] * 2) / 2) for p in rc]
        q = [p for i, p in enumerate(q) if i == 0 or p != q[i - 1]]
        m = [q[0]]
        for i in range(1, len(q) - 1):
            (ax, ay), (bx, by), (cx, cy) = m[-1], q[i], q[i + 1]
            if (bx - ax) * (cy - by) != (by - ay) * (cx - bx): m.append(q[i])
        m.append(q[-1])
        if len(m) > 2:
            res.append([[x0 + x / w_cells * w_px, y0 + y / h_cells * h_px] for x, y in m])
    return res

def blockify_img(img, cols, rows):
    a = np.asarray(img.resize((cols * 8, rows * 8), Image.LANCZOS), dtype=np.float32) / 255
    cells = (1 - a).reshape(rows, 8, cols, 8).mean((1, 3)) > 0.34
    cells = nd.binary_closing(cells, np.ones((2, 2)))
    lab, n = nd.label(cells)
    for k in range(1, n + 1):
        if (lab == k).sum() < 2: cells[lab == k] = False
    return cells

# ---- wordmark: heavy type, one line at a time, letters on a shared baseline
words = text.split(); lines, cur = [], ""
for w in words:
    t = (cur + " " + w).strip()
    if len(t) <= PERLINE: cur = t
    else:
        if cur: lines.append(cur)
        cur = w
if cur: lines.append(cur)

strokes = []
y = 0.0
if MARK:
    mi = Image.open(MARK).convert("L")
    w0, h0 = mi.size
    mcols = COLS; mrows = max(4, int(round(COLS * (h0 / w0) * ASPECT)))
    cells = blockify_img(mi, mcols, mrows)
    hpx = R * 0.92 * (h0 / w0)
    strokes += corners(cells, mcols, mrows, R * 0.04, 0.0, R * 0.92, hpx)
    y = hpx + R * 0.04

for line in lines:
    # render the line as heavy type, tight crop
    f = ImageFont.truetype(FONT, 200)
    tmp = Image.new("L", (2400, 400), 255)
    ImageDraw.Draw(tmp).text((20, 20), line, font=f, fill=0)
    bb = Image.eval(tmp, lambda v: 255 - v).getbbox()
    li = tmp.crop(bb)
    lw, lh = li.size
    cols = COLS
    rows = max(3, int(round(cols * (lh / lw) * ASPECT)))
    cells = blockify_img(li, cols, rows)
    hpx = R * 0.92 * (lh / lw)                   # physical height on the ground
    strokes += corners(cells, cols, rows, R * 0.04, y, R * 0.92, hpx)
    y += hpx + R * 0.03

# scale the whole lockup to fit the square
ys = [p[1] for s in strokes for p in s]
if ys and max(ys) > R * 0.98:
    k = R * 0.98 / max(ys)
    strokes = [[[R / 2 + (p[0] - R / 2) * k, p[1] * k] for p in s] for s in strokes]
json.dump({"strokes": strokes}, open(out, "w"))
if PREV:
    im = Image.new("RGB", (R * 3, R * 3), "white"); d = ImageDraw.Draw(im)
    for s in strokes: d.line([(x * 3, yy * 3) for x, yy in s], fill=(0, 0, 0), width=4)
    im.save(PREV)
print(f"lines {lines}, {len(strokes)} outlines, {sum(len(s) for s in strokes)} corners")
