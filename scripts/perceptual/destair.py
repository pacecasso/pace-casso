"""Take the block-by-block staircase out of a fitted drawing.

streetfit routes each sketch leg with a pull toward the straight line, so any
edge that runs across the grid comes out as dozens of one-block zigzags. A
GPS artist draws that edge as one diagonal street or a few long steps. This
pass keeps the drawing's real corners (Douglas-Peucker at drawing scale) and
re-routes between them with as few turns as possible, inside a band around
the intended edge, so the shape and its features stay where they were.

usage: destair.py seat.json seat_clean.json   (env: TOL = band, fraction of H)
"""
import sys, json, math, heapq, os
import numpy as np
from scipy.spatial import cKDTree

SRC, OUT = sys.argv[1], sys.argv[2]
TOL = float(os.environ.get("TOL", "0.03"))       # band half-width, fraction of H
TURN_PEN = float(os.environ.get("TURN_PEN", "400"))  # metres per 90 degrees
seat = json.load(open(SRC))
H = seat["placement"][2]
tol = TOL * H

g = json.load(open(r"C:\users\ralph\desktop\pace-casso\lib\data\nyc-core-walk-graph.json"))
lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
LAT0 = 40.70; KX = math.cos(math.radians(LAT0)) * 111320; KY = 110540
NX = (lng + 73.95) * KX; NY = (lat - LAT0) * KY
E = np.array(g["edges"]).reshape(-1, 2)
nbr = [[] for _ in range(len(NX))]
for a, b in E.tolist():
    if a != b: nbr[a].append(b); nbr[b].append(a)
tree = cKDTree(np.stack([NX, NY], 1))
def node(p): return int(tree.query([(p[1] + 73.95) * KX, (p[0] - LAT0) * KY])[1])

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

def poly_dist(px, py, pts):
    return min(seg_dist(px, py, NX[a], NY[a], NX[b], NY[b]) for a, b in zip(pts[:-1], pts[1:]))

def dp(path, eps):
    """Douglas-Peucker on node ids: the drawing's corners at this scale"""
    keep = {0, len(path) - 1}; stack = [(0, len(path) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1: continue
        ax, ay, bx, by = NX[path[i]], NY[path[i]], NX[path[j]], NY[path[j]]
        k, dm = -1, -1.0
        for m in range(i + 1, j):
            d = seg_dist(NX[path[m]], NY[path[m]], ax, ay, bx, by)
            if d > dm: k, dm = m, d
        if dm > eps: keep.add(k); stack += [(i, k), (k, j)]
    return sorted(keep)

def turns(path):
    n = 0
    for a, b, c in zip(path[:-2], path[1:-1], path[2:]):
        h1 = (NX[b] - NX[a], NY[b] - NY[a]); h2 = (NX[c] - NX[b], NY[c] - NY[b])
        l1, l2 = math.hypot(*h1), math.hypot(*h2)
        if l1 and l2 and (h1[0] * h2[0] + h1[1] * h2[1]) / (l1 * l2) < math.cos(math.radians(35)): n += 1
    return n

def min_turn(s, t, sub):
    """fewest-turn path s->t through nodes within tol of the edge s-t or of the
    original sub-path (so the old route is always a feasible fallback)"""
    ax, ay, bx, by = NX[s], NY[s], NX[t], NY[t]
    L = math.hypot(bx - ax, by - ay)
    k = max(2, int(L / (tol * 0.5)))
    subset = set(sub); band = set(sub)
    for q in range(k + 1):
        f = q / k
        band.update(tree.query_ball_point([ax + f * (bx - ax), ay + f * (by - ay)], tol))
    band = {v for v in band if v in subset or seg_dist(NX[v], NY[v], ax, ay, bx, by) <= tol}
    start = (s, -1); gs = {start: 0.0}; prev = {}; pq = [(L, 0, start)]; cnt = 0; goal = None; closed = set()
    while pq:
        f, _, st = heapq.heappop(pq)
        if st in closed: continue
        closed.add(st); u, pu = st
        if u == t: goal = st; break
        ux, uy = NX[u], NY[u]
        if pu >= 0: hx, hy = ux - NX[pu], uy - NY[pu]; hn = math.hypot(hx, hy) or 1.0
        for v in nbr[u]:
            if v == pu or v not in band: continue
            el = math.hypot(NX[v] - ux, NY[v] - uy)
            turn = 0.0
            if pu >= 0 and el > 0:
                turn = TURN_PEN * (1 - ((NX[v] - ux) * hx + (NY[v] - uy) * hy) / (el * hn))
            ng = gs[st] + el + turn
            sv = (v, u)
            if ng < gs.get(sv, 1e18):
                gs[sv] = ng; prev[sv] = st; cnt += 1
                heapq.heappush(pq, (ng + math.hypot(bx - NX[v], by - NY[v]), cnt, sv))
    if goal is None: return None
    path = []; st = goal
    while True:
        path.append(st[0])
        if st == start: break
        st = prev[st]
    return path[::-1]

def corners(p, scale):
    """indices where the drawing itself turns hard (ear tips, tail tip), judged
    by headings taken `scale` metres back and ahead along the path, so a one-
    block stair step is not a corner"""
    cum = np.concatenate([[0], np.cumsum([math.hypot(NX[b] - NX[a], NY[b] - NY[a]) for a, b in zip(p[:-1], p[1:])])])
    xs, ys = NX[p], NY[p]
    ang = np.zeros(len(p))
    for i in range(len(p)):
        j0 = int(np.searchsorted(cum, cum[i] - scale)); j1 = min(int(np.searchsorted(cum, cum[i] + scale)), len(p) - 1)
        if j0 >= i or j1 <= i: continue
        h1 = (xs[i] - xs[j0], ys[i] - ys[j0]); h2 = (xs[j1] - xs[i], ys[j1] - ys[i])
        l1, l2 = math.hypot(*h1), math.hypot(*h2)
        if l1 and l2: ang[i] = math.degrees(math.acos(max(-1, min(1, (h1[0] * h2[0] + h1[1] * h2[1]) / (l1 * l2)))))
    keep = [0]
    for i in range(1, len(p) - 1):
        # local maximum of the turn, over 60 degrees
        w = ang[max(0, i - 3):i + 4]
        if ang[i] > 60 and ang[i] == w.max() and cum[i] - cum[keep[-1]] > scale: keep.append(i)
    keep.append(len(p) - 1)
    return keep

def plen(p): return sum(math.hypot(NX[b] - NX[a], NY[b] - NY[a]) for a, b in zip(p[:-1], p[1:]))

def tube_route(p):
    """fewest-turn path from p[0] to p[-1] anywhere within tol of the old path"""
    s, t = p[0], p[-1]
    pts = []
    for a, b in zip(p[:-1], p[1:]):
        n = max(1, int(math.hypot(NX[b] - NX[a], NY[b] - NY[a]) / (tol * 0.25)))
        pts += [(NX[a] + (NX[b] - NX[a]) * q / n, NY[a] + (NY[b] - NY[a]) * q / n) for q in range(n)]
    pts.append((NX[t], NY[t]))
    band = set(p)
    for lst in tree.query_ball_point(pts, tol): band.update(lst)
    start = (s, -1); gs = {start: 0.0}; prev = {}; pq = [(0.0, 0, start)]; cnt = 0; goal = None; closed = set()
    while pq:
        f, _, st = heapq.heappop(pq)
        if st in closed: continue
        closed.add(st); u, pu = st
        if u == t: goal = st; break
        ux, uy = NX[u], NY[u]
        if pu >= 0: hx, hy = ux - NX[pu], uy - NY[pu]; hn = math.hypot(hx, hy) or 1.0
        for v in nbr[u]:
            if v == pu or v not in band: continue
            el = math.hypot(NX[v] - ux, NY[v] - uy)
            turn = 0.0
            if pu >= 0 and el > 0:
                turn = TURN_PEN * (1 - ((NX[v] - ux) * hx + (NY[v] - uy) * hy) / (el * hn))
            ng = gs[st] + el + turn
            sv = (v, u)
            if ng < gs.get(sv, 1e18):
                gs[sv] = ng; prev[sv] = st; cnt += 1
                heapq.heappush(pq, (ng, cnt, sv))
    if goal is None: return None
    path = []; st = goal
    while True:
        path.append(st[0])
        if st == start: break
        st = prev[st]
    return path[::-1]

MODE = os.environ.get("MODE", "tube")
out = []; t0 = t1 = 0
for s in seat["strokes_latlng"]:
    p = [node(x) for x in s]
    p = [q for k, q in enumerate(p) if k == 0 or q != p[k - 1]]
    if len(p) < 3: out.append(p); continue
    if MODE == "tube":
        cs = corners(p, 3 * tol)
        new = [p[0]]
        for i, j in zip(cs[:-1], cs[1:]):
            sub = p[i:j + 1]
            r = tube_route(sub) if len(sub) > 2 else None
            # a much shorter result means the tube touched itself and the
            # route cut across the shape (a loop, a thin feature): keep the old
            ok = r is not None and turns(r) < turns(sub) and plen(r) > 0.8 * plen(sub)
            new += (r if ok else sub)[1:]
        t0 += turns(p); t1 += turns(new); out.append(new)
        continue
    anchors = dp(p, tol)
    new = [p[0]]
    for i, j in zip(anchors[:-1], anchors[1:]):
        sub = p[i:j + 1]
        r = min_turn(p[i], p[j], sub)
        # keep the original leg unless the new one has fewer turns
        new += (r if r is not None and turns(r) < turns(sub) else sub)[1:]
    t0 += turns(p); t1 += turns(new)
    out.append(new)
seat["strokes_latlng"] = [[[float(lat[q]), float(lng[q])] for q in p] for p in out]
seat["destair"] = {"tol_m": round(tol), "turns_before": t0, "turns_after": t1}
json.dump(seat, open(OUT, "w"))
print(f"destair: turns {t0} -> {t1} (band {tol:.0f} m)")
