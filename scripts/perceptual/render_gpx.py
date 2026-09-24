"""Render a GPX on the street background, north-up (same style as connect.py)."""
import sys, re, math, json
import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree
from collections import defaultdict
g = json.load(open(r"C:\users\ralph\desktop\pace-casso\lib\data\nyc-core-walk-graph.json"))
lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
KX = math.cos(math.radians(40.72)) * 111320; KY = 110540
X = lng * KX; Y = lat * KY
nbr = defaultdict(list)
for a, b in np.array(g["edges"]).reshape(-1, 2).tolist():
    if a != b: nbr[a].append(b); nbr[b].append(a)
tree = cKDTree(np.stack([X, Y], 1))
for path in sys.argv[1:]:
    t = open(path, encoding="utf-8").read()
    pts = np.array([[float(b) * KX, float(a) * KY] for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', t)])
    km = float(np.hypot(*(pts[1:] - pts[:-1]).T).sum()) / 1000
    cx, cy = (pts[:, 0].min() + pts[:, 0].max()) / 2, (pts[:, 1].min() + pts[:, 1].max()) / 2
    H = max(pts[:, 0].max() - pts[:, 0].min(), pts[:, 1].max() - pts[:, 1].min()) / 2 * 1.12
    S = 900
    im = Image.new("RGB", (S, S), (246, 246, 244)); d = ImageDraw.Draw(im)
    P = lambda x, y: ((x - cx) / H * S / 2 + S / 2, S / 2 - (y - cy) / H * S / 2)
    near = tree.query_ball_point([cx, cy], H * 1.45); ns = set(near)
    for a in near:
        for b in nbr[a]:
            if b > a and b in ns: d.line([P(X[a], Y[a]), P(X[b], Y[b])], fill=(220, 220, 220), width=1)
    d.line([P(x, y) for x, y in pts], fill=(235, 80, 20), width=4, joint="curve")
    d.text((12, 12), f"{path.split('/')[-1]}  {km:.1f} km", fill=(40, 40, 40))
    out = path.replace(".gpx", "_map.png")
    im.save(out); print(out, f"{km:.1f} km")
