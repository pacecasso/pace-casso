"""Join a fitted drawing's strokes into ONE continuous runnable route.

Greedy tour: from the current position, walk (Dijkstra) to the nearest
endpoint of an unvisited stroke, preferring streets already drawn (so the
connector is a backtrack over ink, not a new visible line), then run that
stroke. Writes GPX + a north-up map with the route + a stats line.

usage: connect.py seat.json out_prefix
"""
import sys, json, math, heapq
import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

seat = json.load(open(sys.argv[1])); OUT = sys.argv[2]
g = json.load(open(r"C:\users\ralph\desktop\pace-casso\lib\data\nyc-core-walk-graph.json"))
lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
LAT0 = 40.70; KX = math.cos(math.radians(LAT0)) * 111320; KY = 110540
NX = (lng + 73.95) * KX; NY = (lat - LAT0) * KY
E = np.array(g["edges"]).reshape(-1, 2)
nbr = [[] for _ in range(len(NX))]
for a, b in E.tolist():
    if a != b: nbr[a].append(b); nbr[b].append(a)
tree = cKDTree(np.stack([NX, NY], 1))
def node(p):
    return int(tree.query([(p[1] + 73.95) * KX, (p[0] - LAT0) * KY])[1])
strokes = [[node(p) for p in s] for s in seat["strokes_latlng"]]
strokes = [[q for k, q in enumerate(s) if k == 0 or q != s[k - 1]] for s in strokes if len(s) > 1]
ink = set()
for s in strokes:
    for a, b in zip(s[:-1], s[1:]): ink.add((min(a, b), max(a, b)))
def dist(a, b): return math.hypot(NX[a] - NX[b], NY[a] - NY[b])
def walk(src, targets):
    D = {src: 0.0}; prev = {}; pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > D[u]: continue
        if u in targets:
            path = [u]
            while path[-1] != src: path.append(prev[path[-1]])
            return path[::-1]
        for v in nbr[u]:
            w = dist(u, v) * (0.35 if (min(u, v), max(u, v)) in ink else 1.0)
            if d + w < D.get(v, 1e18): D[v] = d + w; prev[v] = u; heapq.heappush(pq, (d + w, v))
    return None
left = list(range(len(strokes)))
# start at the stroke end furthest west (arbitrary but deterministic)
k0 = min(left, key=lambda k: NX[strokes[k][0]])
route = list(strokes[k0]); left.remove(k0)
conn_m = 0.0
while left:
    ends = {}
    for k in left:
        ends.setdefault(strokes[k][0], (k, False)); ends.setdefault(strokes[k][-1], (k, True))
    path = walk(route[-1], set(ends))
    if path is None: left.pop(); continue
    conn_m += sum(dist(a, b) for a, b in zip(path[:-1], path[1:]))
    k, rev = ends[path[-1]]
    route += path[1:] + (strokes[k][::-1] if rev else strokes[k])[1:]
    left.remove(k)
km = sum(dist(a, b) for a, b in zip(route[:-1], route[1:])) / 1000
with open(OUT + ".gpx", "w") as f:
    f.write('<?xml version="1.0"?><gpx version="1.1" creator="pacecasso-perceptual"><trk><trkseg>')
    for n in route: f.write(f'<trkpt lat="{lat[n]:.6f}" lon="{lng[n]:.6f}"/>')
    f.write("</trkseg></trk></gpx>")
# north-up map: grey streets, orange route
xs, ys = NX[route], NY[route]
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
H = max(xs.max() - xs.min(), ys.max() - ys.min()) / 2 * 1.12
S = 1000
im = Image.new("RGB", (S, S), (246, 246, 244)); d = ImageDraw.Draw(im)
P = lambda n: ((NX[n] - cx) / H * S / 2 + S / 2, S / 2 - (NY[n] - cy) / H * S / 2)
near = tree.query_ball_point([cx, cy], H * 1.45); ns = set(near)
for a in near:
    for b in nbr[a]:
        if b > a and b in ns: d.line([P(a), P(b)], fill=(218, 218, 218), width=1)
d.line([P(n) for n in route], fill=(235, 80, 20), width=4, joint="curve")
d.text((12, 12), f"{km:.1f} km total ({conn_m/1000:.1f} km of connectors, mostly retracing drawn streets)", fill=(40, 40, 40))
im.save(OUT + "_map.png")
print(f"one continuous route: {km:.1f} km, connectors {conn_m/1000:.1f} km, {len(route)} points")
