"""Use an existing (approved) route as the DESIGN: gpx -> normalised sketch
strokes, so streetfit.py can redraw that same design bigger / on straighter
streets somewhere else in the city.

usage: gpx2sketch.py route.gpx out.json [rdp_px] [preview.png]
"""
import sys, re, json, math
import numpy as np
R = 224
txt = open(sys.argv[1], encoding="utf-8").read()
pts = [(float(a), float(b)) for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', txt)]
lat0 = sum(p[0] for p in pts) / len(pts)
xy = np.array([[(lo) * math.cos(math.radians(lat0)) * 111320, la * 110540] for la, lo in pts])
xy -= xy.min(0)
sc = (R * 0.92) / xy.max()
xy = xy * sc
xy[:, 1] = xy[:, 1].max() - xy[:, 1]          # y down, like an image
xy += (R - np.array([xy[:, 0].max(), xy[:, 1].max()])) / 2
eps = float(sys.argv[3]) if len(sys.argv) > 3 else 1.2
def rdp(p):
    if len(p) < 3: return p
    u = p[-1] - p[0]; v = p[0] - p
    d = np.abs(u[0] * v[:, 1] - u[1] * v[:, 0]) / (np.linalg.norm(u) + 1e-9)
    i = int(d.argmax())
    if d[i] > eps: return np.vstack([rdp(p[:i + 1])[:-1], rdp(p[i:])])
    return np.array([p[0], p[-1]])
q = rdp(xy)
json.dump({"strokes": [q.tolist()]}, open(sys.argv[2], "w"))
if len(sys.argv) > 4:
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (R * 2, R * 2), "white")
    ImageDraw.Draw(im).line([(x * 2, y * 2) for x, y in q], fill=(0, 0, 0), width=3)
    im.save(sys.argv[4])
print(f"{len(pts)} points -> {len(q)} design corners")
