"""ink mask -> its outlines (outer boundaries AND holes, e.g. the pump window)
as simplified strokes in 224-px sketch space, for streetfit.py."""
import sys, json, numpy as np
from PIL import Image
from skimage import measure
R = 224
im = Image.open(sys.argv[1]).convert("L"); w, h = im.size; s = max(w, h)
c = Image.new("L", (s, s), 255); c.paste(im, ((s - w) // 2, (s - h) // 2))
a = np.asarray(c.resize((R, R), Image.LANCZOS)) < 128
a = np.pad(a, 2)
def rdp(p, eps):
    if len(p) < 3: return p
    u = p[-1] - p[0]; v = p[0] - p
    d = np.abs(u[0] * v[:, 1] - u[1] * v[:, 0]) / (np.linalg.norm(u) + 1e-9)
    i = int(d.argmax())
    if d[i] > eps: return np.vstack([rdp(p[:i + 1], eps)[:-1], rdp(p[i:], eps)])
    return np.array([p[0], p[-1]])
out = []
for cnt in measure.find_contours(a.astype(float), 0.5):
    if len(cnt) < 12: continue
    xy = cnt[:, ::-1] - 2
    if np.ptp(xy[:, 0]) + np.ptp(xy[:, 1]) < 10: continue
    # split closed ring in two halves so rdp keeps both sides
    m = len(xy) // 2
    q = np.vstack([rdp(xy[:m + 1], 1.5)[:-1], rdp(xy[m:], 1.5)])
    out.append(q.tolist())
json.dump({"strokes": out}, open(sys.argv[2], "w"))
print(len(out), "outline strokes,", sum(len(s) for s in out), "points")
