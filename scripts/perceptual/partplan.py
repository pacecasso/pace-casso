"""ink mask -> drawing plan that KEEPS THE PARTS of a multi-part logo.

blockplan.py resamples the mass onto a 28-column block grid first. Anything
closer than a cell merges: gas's pump + figure became one blob, the hose and
head vanished, Chanel's C's became an H, the Stones mouth a potato. The plan
was lost before a single street was chosen.

Here the grid is left to the router (it already pays to turn, so edges land
on straight streets). The plan is:
  mass  = opening(ink, disk(T)), T ~ 1.3% of the drawing
          -> every outline of every part, holes kept, simplified
  thin  = ink minus mass -> skeleton centrelines (hose, headphone band)
Line art (thin everywhere, the cat) is all centrelines.

usage: partplan.py ink.png out.json [--preview=p.png]
"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw
from skimage import measure, morphology
from scipy import ndimage as nd

R = 224; HI = 560
src, out = sys.argv[1], sys.argv[2]
PREV = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--preview=")), None)
T = int(next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--thin=")), 7))

im = Image.open(src).convert("L")
w, h = im.size; s = max(w, h)
sq = Image.new("L", (s, s), 255); sq.paste(im, ((s - w) // 2, (s - h) // 2))
a = np.asarray(sq.resize((HI, HI), Image.LANCZOS)) < 128
a = morphology.remove_small_objects(a, 30)

sk0 = morphology.skeletonize(a)
LINEART = a.sum() / max(sk0.sum(), 1) < 14
mass = np.zeros_like(a) if LINEART else nd.binary_opening(a, morphology.disk(T))
mass = morphology.remove_small_objects(mass, 150)
thin = a & ~nd.binary_dilation(mass, morphology.disk(2))
thin = morphology.remove_small_objects(thin, 40)

def simplify(pts, tol):
    pts = np.asarray(pts)
    if len(pts) < 3: return pts
    return measure.approximate_polygon(pts, tol)

S = R / HI
strokes = []
# every boundary of every mass part (outer + holes), drawn at the part's own shape
for c in measure.find_contours(np.pad(mass.astype(float), 1), 0.5):
    c = simplify(c - 1, 3.0)
    if len(c) < 4: continue
    per = np.hypot(*np.diff(c, axis=0).T).sum()
    if per < 0.06 * HI: continue          # specks do not read at street scale
    strokes.append([[float(p[1] * S), float(p[0] * S)] for p in c])

# thin features -> centrelines, walked branch by branch
sk = morphology.skeletonize(thin)
nb = nd.convolve(sk.astype(int), np.ones((3, 3), int), mode="constant") - 1
seen = np.zeros_like(sk)
def walk(y, x):
    path = [(y, x)]; seen[y, x] = True
    while True:
        nxt = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yy, xx = y + dy, x + dx
                if (dy or dx) and 0 <= yy < HI and 0 <= xx < HI and sk[yy, xx] and not seen[yy, xx]:
                    nxt = (yy, xx); break
            if nxt: break
        if not nxt: return path
        y, x = nxt; seen[y, x] = True; path.append(nxt)
ends = list(zip(*np.nonzero(sk & (nb == 1))))
starts = ends + list(zip(*np.nonzero(sk)))
for y, x in starts:
    if seen[y, x]: continue
    p = walk(y, x)
    if len(p) < 0.05 * HI: continue
    p = simplify(np.array(p, float), 2.0)
    strokes.append([[float(q[1] * S), float(q[0] * S)] for q in p])

json.dump({"strokes": strokes}, open(out, "w"))
print(f"{len(strokes)} strokes ({'line art' if LINEART else 'solid'}; T={T})")
if PREV:
    pv = Image.new("RGB", (448, 448), "white"); d = ImageDraw.Draw(pv)
    for st in strokes: d.line([(x * 2, y * 2) for x, y in st], fill="black", width=2)
    pv.save(PREV)
