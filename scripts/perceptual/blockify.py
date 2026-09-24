"""ink mask -> BLOCKY rendition on the city's block grid -> outline strokes.

Why: on a street grid what reads is big rectilinear shapes with straight edges
(the July "JUST DO IT" lockup Ralph prefers). Thin smooth curves dissolve.
Blocks are anisotropic (NYC ~80 m between streets, ~250-270 m between
avenues), so cells are tall and thin; every outline edge then lands on a real
street run.

usage: blockify.py ink.png out.json [cols] [rows] [preview.png]
"""
import sys, json, numpy as np
from PIL import Image
from skimage import measure
from scipy import ndimage as nd

R = 224
src, out = sys.argv[1], sys.argv[2]
COLS = int(sys.argv[3]) if len(sys.argv) > 3 else 13
ROWS = int(sys.argv[4]) if len(sys.argv) > 4 else 40
im = Image.open(src).convert("L")
w, h = im.size; s = max(w, h)
c = Image.new("L", (s, s), 255); c.paste(im, ((s - w) // 2, (s - h) // 2))
a = np.asarray(c.resize((COLS * 8, ROWS * 8), Image.LANCZOS), dtype=np.float32) / 255
ink = (1 - a).reshape(ROWS, 8, COLS, 8).mean((1, 3))      # coverage per block cell
cells = ink > 0.34
cells = nd.binary_closing(cells, np.ones((2, 2)))
lab, n = nd.label(cells)
for k in range(1, n + 1):                                  # drop specks
    if (lab == k).sum() < 2: cells[lab == k] = False
strokes = []
pad = np.pad(cells, 1)
for cnt in measure.find_contours(pad.astype(float), 0.5):
    if len(cnt) < 4: continue
    rc = cnt - 1                                           # (row, col) at cell edges
    q = [(round(p[1] * 2) / 2, round(p[0] * 2) / 2) for p in rc]
    q = [p for i, p in enumerate(q) if i == 0 or p != q[i - 1]]
    m = [q[0]]                                             # keep only corners
    for i in range(1, len(q) - 1):
        (x0, y0), (x1, y1), (x2, y2) = m[-1], q[i], q[i + 1]
        if (x1 - x0) * (y2 - y1) != (y1 - y0) * (x2 - x1): m.append(q[i])
    m.append(q[-1])
    if len(m) < 3: continue
    strokes.append([[(x + 0.5) / COLS * R, (y + 0.5) / ROWS * R] for x, y in m])
json.dump({"strokes": strokes}, open(out, "w"))
if len(sys.argv) > 5:
    from PIL import ImageDraw
    p = Image.new("RGB", (R * 2, R * 2), "white"); d = ImageDraw.Draw(p)
    for st in strokes: d.line([(x * 2, y * 2) for x, y in st], fill=(0, 0, 0), width=3)
    p.save(sys.argv[5])
print(f"{len(strokes)} blocky outlines, {sum(len(s) for s in strokes)} corners")
