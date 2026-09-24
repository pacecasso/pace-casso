"""Every consecutive pair of GPX points: is there a real walkable path between
them, and how much longer is it than the straight line? (detour > 1.3x means
the drawn line cuts across blocks)."""
import sys, re, json, math, heapq
import numpy as np
from collections import defaultdict
from scipy.spatial import cKDTree
g = json.load(open(r"C:\users\ralph\desktop\pace-casso\lib\data\nyc-core-walk-graph.json"))
lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
KX = math.cos(math.radians(40.72)) * 111320; KY = 110540
X = lng * KX; Y = lat * KY
nbr = defaultdict(list)
for a, b in np.array(g["edges"]).reshape(-1, 2).tolist():
    if a != b: nbr[a].append(b); nbr[b].append(a)
tree = cKDTree(np.stack([X, Y], 1))
def path_len(s, t, cap=4000):
    if s == t: return 0.0
    D = {s: 0.0}; pq = [(0.0, s)]; seen = 0
    while pq and seen < 60000:
        d, u = heapq.heappop(pq); seen += 1
        if u == t: return d
        if d > D.get(u, 1e18): continue
        for v in nbr[u]:
            w = d + math.hypot(X[v] - X[u], Y[v] - Y[u])
            if w < D.get(v, 1e18) and w < cap: D[v] = w; heapq.heappush(pq, (w, v))
    return None
for p in sys.argv[1:]:
    t = open(p, encoding="utf-8").read()
    pts = np.array([[float(b) * KX, float(a) * KY] for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', t)])
    _, idx = tree.query(pts)
    bad = 0; worst = 0.0; miss = 0; n = 0
    for u, v in zip(idx[:-1], idx[1:]):
        if u == v: continue
        n += 1
        straight = math.hypot(X[v] - X[u], Y[v] - Y[u])
        L = path_len(int(u), int(v))
        if L is None: miss += 1; continue
        r = L / max(straight, 1e-6)
        worst = max(worst, r)
        if r > 1.3: bad += 1
    print(f"{p.split('/')[-1]:34s} legs {n:5d} | unreachable {miss} | detour>1.3x: {bad} ({100*bad/max(n,1):.1f}%) | worst {worst:.2f}x")
