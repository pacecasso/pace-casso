"""ink mask -> a street-grid DRAWING PLAN: blocky outlines for the solid mass,
plus centrelines for thin features the blocks would otherwise swallow.

Ralph, Sep 23: "the tongue is awful". A long thin feature inside a solid shape
(the Stones tongue, the gas hose, Chanel's interlock) is thinner than one block
cell, so blockifying deletes it. Here the mask is split:
  mass = opening(ink)        -> blockified, drawn as outlines
  thin = ink - mass          -> skeletonised, drawn as single centrelines
Thin strokes are kept only if they are long enough to read at street scale.

usage: blockplan.py ink.png out.json [cols] [--thin=3] [--minlen=0.12] [--preview=p.png]
"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw
from skimage import measure, morphology
from scipy import ndimage as nd

R = 224
src, out = sys.argv[1], sys.argv[2]
def opt(k, d):
    for a in sys.argv[3:]:
        if a.startswith(f"--{k}="): return a.split("=", 1)[1]
    return d
COLS = int(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else int(opt("cols", 28))
THIN = int(opt("thin", 3))            # erosion radius, in hi-res px, defining "thin"
MINLEN = float(opt("minlen", 0.08))   # min centreline length, fraction of the drawing
PREV = opt("preview", None)
ASPECT = 3.0                          # block cells ~270 m wide, ~80 m tall
ROWS = int(round(COLS * ASPECT))

im = Image.open(src).convert("L")
w, h = im.size; s = max(w, h)
sq = Image.new("L", (s, s), 255); sq.paste(im, ((s - w) // 2, (s - h) // 2))
HI = 560
a = np.asarray(sq.resize((HI, HI), Image.LANCZOS)) < 128

# mean ink thickness = area / skeleton length. An outline drawing (the cat)
# is a few px thick everywhere: draw its centrelines, never "blockify" it.
_sk0 = morphology.skeletonize(a)
THICK = a.sum() / max(_sk0.sum(), 1)
LINEART = THICK < 14
mass = np.zeros_like(a) if LINEART else nd.binary_opening(a, morphology.disk(THIN))
thin = a & ~nd.binary_dilation(mass, morphology.disk(1))
thin = morphology.remove_small_objects(thin, 40)

# thin NEGATIVE space inside the shape (the Stones tongue crease, the gap
# between Chanel's C's): a line drawn along the gap is how a person shows it
inside = nd.binary_fill_holes(a)
gap = inside & ~a
gap_thin = gap & ~nd.binary_opening(gap, morphology.disk(THIN + 2))
gap_thin = morphology.remove_small_objects(gap_thin, 60)
THIN_GAPS = gap_thin.copy()
thin = thin | gap_thin

def rect_outlines(cells, cols, rows):
    res = []
    for cnt in measure.find_contours(np.pad(cells.astype(float), 1), 0.5):
        rc = cnt - 1
        q = [(round(p[1] * 2) / 2, round(p[0] * 2) / 2) for p in rc]
        q = [p for i, p in enumerate(q) if i == 0 or p != q[i - 1]]
        m = [q[0]]
        for i in range(1, len(q) - 1):
            (ax, ay), (bx, by), (cx, cy) = m[-1], q[i], q[i + 1]
            if (bx - ax) * (cy - by) != (by - ay) * (cx - bx): m.append(q[i])
        m.append(q[-1])
        if len(m) > 2:
            res.append([[(x + 0.5) / cols * R, (y + 0.5) / rows * R] for x, y in m])
    return res

# --- mass -> blocky outlines, one per PART.
# A thin white gap (the Stones tongue against the lips, the space inside
# Chanel's C) separates two parts of one solid shape. Cutting the mass along
# those gaps and outlining each part keeps the gap visible on the map;
# merging them produced a blob.
def to_cells(m):
    c = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((COLS * 8, ROWS * 8), Image.LANCZOS), dtype=np.float32)
    c = (c.reshape(ROWS, 8, COLS, 8).mean((1, 3)) / 255) > 0.34
    c = nd.binary_closing(c, np.ones((2, 2)))
    lab, n = nd.label(c)
    for k in range(1, n + 1):
        if (lab == k).sum() < 2: c[lab == k] = False
    return c

cut = mass & ~nd.binary_dilation(gap_thin, morphology.disk(2))
plab, pn = nd.label(cut)
parts = [(plab == k) for k in range(1, pn + 1) if (plab == k).sum() > 0.04 * max(mass.sum(), 1)]
if len(parts) < 2:
    parts = [mass]
strokes = []
for part in parts:
    strokes += rect_outlines(to_cells(part), COLS, ROWS)

# --- thin -> centrelines, walked as polylines
sk = morphology.skeletonize(thin)
pts = {(int(y), int(x)) for y, x in zip(*np.nonzero(sk))}
def nbrs(p):
    y, x = p
    return [(y + dy, x + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            if (dy or dx) and (y + dy, x + dx) in pts]
deg = {p: len(nbrs(p)) for p in pts}
ends = [p for p in pts if deg[p] == 1] or ([next(iter(pts))] if pts else [])
used = set()
lines = []
for e in ends:
    if e in used: continue
    line = [e]; used.add(e); cur = e
    while True:
        nxt = [q for q in nbrs(cur) if q not in used]
        if not nxt: break
        nxt.sort(key=lambda q: (abs(q[0] - cur[0]) + abs(q[1] - cur[1])))
        cur = nxt[0]; used.add(cur); line.append(cur)
    if len(line) > 6: lines.append(line)

def rdp(p, eps=6.0):
    p = np.asarray(p, float)
    if len(p) < 3: return p
    u = p[-1] - p[0]; v = p[0] - p
    d = np.abs(u[0] * v[:, 1] - u[1] * v[:, 0]) / (np.linalg.norm(u) + 1e-9)
    i = int(d.argmax())
    if d[i] > eps: return np.vstack([rdp(p[:i + 1], eps)[:-1], rdp(p[i:], eps)])
    return np.array([p[0], p[-1]])

kept = 0
for line in lines:
    arr = np.array([[x, y] for y, x in line], float)
    length = float(np.hypot(*(arr[1:] - arr[:-1]).T).sum())
    if length < MINLEN * HI: continue
    q = rdp(arr) * (R / HI)
    strokes.append(q.tolist()); kept += 1

json.dump({"strokes": strokes}, open(out, "w"))
if PREV:
    p = Image.new("RGB", (R * 3, R * 3), "white"); d = ImageDraw.Draw(p)
    for st in strokes: d.line([(x * 3, y * 3) for x, y in st], fill=(0, 0, 0), width=4)
    p.save(PREV)
print(f"{len(strokes)} strokes ({len(strokes)-kept} blocky outlines + {kept} thin centrelines incl. gaps)")
