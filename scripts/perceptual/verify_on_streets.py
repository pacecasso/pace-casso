"""Is this GPX actually on streets? Distance from every point to the nearest
NYC walk-graph node, and the longest hop between consecutive points."""
import sys, re, json, math
import numpy as np
from scipy.spatial import cKDTree
g = json.load(open(r"C:\users\ralph\desktop\pace-casso\lib\data\nyc-core-walk-graph.json"))
lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
KX = math.cos(math.radians(40.72)) * 111320; KY = 110540
tree = cKDTree(np.stack([lng * KX, lat * KY], 1))
for p in sys.argv[1:]:
    t = open(p, encoding="utf-8").read()
    pts = np.array([[float(b) * KX, float(a) * KY] for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', t)])
    d, _ = tree.query(pts)
    hops = np.hypot(*(pts[1:] - pts[:-1]).T)
    print(f"{p.split('/')[-1]:34s} {len(pts):5d} pts | off-street: median {np.median(d):5.1f} m, "
          f"p95 {np.percentile(d,95):5.1f} m, max {d.max():6.1f} m | longest hop {hops.max():6.1f} m | {hops.sum()/1000:.1f} km")
