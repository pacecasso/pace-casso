"""The city: NYC walk graph (same file + frame as streetfit.py), the giant
component, an orientation raster (which street directions exist near each
10 m cell), a 'no streets here' raster, and the deviation-charged router."""
import os, json, math, heapq
import numpy as np
from scipy.spatial import cKDTree
from scipy import ndimage as nd

HERE = os.path.dirname(os.path.abspath(__file__))
GRAPH = os.path.join(HERE, "..", "..", "lib", "data", "nyc-core-walk-graph.json")
# gitignored; rebuilt from GRAPH on the first run
CACHE = os.path.join(HERE, "city_cache.npz")
LAT0, LNG0 = 40.70, -73.95
KX = math.cos(math.radians(LAT0)) * 111320; KY = 110540
CELL = 10.0; NB = 12

if os.path.exists(CACHE):
    z = np.load(CACHE)
    lat, lng, E = z["lat"], z["lng"], z["E"]
else:
    g = json.load(open(GRAPH))
    lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
    E = np.array(g["edges"]).reshape(-1, 2); E = E[E[:, 0] != E[:, 1]]
    E = np.unique(np.sort(E, 1), axis=0)
    np.savez(CACHE, lat=lat, lng=lng, E=E)
NX = (lng - LNG0) * KX; NY = (lat - LAT0) * KY
N = len(NX)
order = np.argsort(np.concatenate([E[:, 0], E[:, 1]]), kind="stable")
_src = np.concatenate([E[:, 0], E[:, 1]])[order]; _dst = np.concatenate([E[:, 1], E[:, 0]])[order]
_ptr = np.searchsorted(_src, np.arange(N + 1))
nbr = [_dst[_ptr[i]:_ptr[i + 1]].tolist() for i in range(N)]
deg = np.diff(_ptr)

from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
_, _lab = connected_components(coo_matrix((np.ones(len(E)), (E[:, 0], E[:, 1])), shape=(N, N)), directed=False)
GIANT = np.nonzero(_lab == np.bincount(_lab).argmax())[0]
INGIANT = np.zeros(N, bool); INGIANT[GIANT] = True
_gt = cKDTree(np.stack([NX[GIANT], NY[GIANT]], 1))
def snap(pts):
    d, i = _gt.query(pts); return d, GIANT[i]
land = GIANT[deg[GIANT] >= 3]
alltree = cKDTree(np.stack([NX, NY], 1))

# ---------- rasters
x0, y0 = NX.min() - 300, NY.min() - 300
GW = int((NX.max() + 300 - x0) / CELL) + 1; GH = int((NY.max() + 300 - y0) / CELL) + 1
_EG = E[INGIANT[E[:, 0]] & INGIANT[E[:, 1]]]
ax_, ay_ = NX[_EG[:, 0]], NY[_EG[:, 0]]; bx_, by_ = NX[_EG[:, 1]], NY[_EG[:, 1]]
_el = np.hypot(bx_ - ax_, by_ - ay_)
_eb = ((np.degrees(np.arctan2(by_ - ay_, bx_ - ax_)) % 180) / (180 / NB)).astype(int) % NB
_ns = np.maximum(1, (_el / 5).astype(int))
_rep = np.repeat(np.arange(len(_EG)), _ns)
_t = (np.arange(len(_rep)) - np.repeat(np.cumsum(_ns) - _ns, _ns)) / np.repeat(_ns, _ns)
_px = ax_[_rep] + _t * (bx_ - ax_)[_rep]; _py = ay_[_rep] + _t * (by_ - ay_)[_rep]
_ci = ((_px - x0) / CELL).astype(int); _cj = ((_py - y0) / CELL).astype(int)
ORI = np.zeros((NB, GH, GW), bool)
ORI[_eb[_rep], _cj, _ci] = True
ANY = ORI.any(0)
_st = nd.generate_binary_structure(2, 1)
for k in range(NB):
    ORI[k] = nd.binary_dilation(ORI[k], _st, iterations=3)          # ~30 m
SUP = ORI | np.roll(ORI, 1, 0) | np.roll(ORI, -1, 0)                  # +-22 deg
# 'reachable': a street within ~70 m (else: water, park interior, rail yard, airport)
NEAR = nd.binary_dilation(ANY, _st, iterations=7)
del _rep, _t, _px, _py, _ci, _cj    # ORI stays: support_strict reads it

def lookup(R, wx, wy):
    i = ((wx - x0) / CELL).astype(int); j = ((wy - y0) / CELL).astype(int)
    ok = (i >= 0) & (i < GW) & (j >= 0) & (j < GH)
    out = np.zeros(len(wx), bool)
    out[ok] = R[j[ok], i[ok]]
    return out

def support(TS, TT, pl):
    """share of the design's outline that already has a same-direction street
    within ~30 m, and share that lands where there is no street at all"""
    cx, cy, H, th = pl
    c, s_ = math.cos(math.radians(th)), math.sin(math.radians(th))
    x = TS[:, 0] * H; y = TS[:, 1] * H
    wx = cx + c * x - s_ * y; wy = cy + s_ * x + c * y
    i = ((wx - x0) / CELL).astype(int); j = ((wy - y0) / CELL).astype(int)
    ok = (i >= 0) & (i < GW) & (j >= 0) & (j < GH)
    b = (((TT + th) % 180) / (180 / NB)).astype(int) % NB
    sup = np.zeros(len(TS), bool); near = np.zeros(len(TS), bool)
    sup[ok] = SUP[b[ok], j[ok], i[ok]]; near[ok] = NEAR[j[ok], i[ok]]
    return sup.mean(), 1 - near.mean()

def support_strict(TS, TT, pl):
    """support() with the street's direction within one bin (+-7.5 deg) instead
    of three: block letters only read when their strokes run ALONG the grid"""
    cx, cy, H, th = pl
    c, s_ = math.cos(math.radians(th)), math.sin(math.radians(th))
    x = TS[:, 0] * H; y = TS[:, 1] * H
    wx = cx + c * x - s_ * y; wy = cy + s_ * x + c * y
    i = ((wx - x0) / CELL).astype(int); j = ((wy - y0) / CELL).astype(int)
    ok = (i >= 0) & (i < GW) & (j >= 0) & (j < GH)
    b = (((TT + th) % 180) / (180 / NB)).astype(int) % NB
    sup = np.zeros(len(TS), bool)
    sup[ok] = ORI[b[ok], j[ok], i[ok]]
    return sup.mean()

# ---------- router
TURN = 25.0
def _dseg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay; LL = dx * dx + dy * dy
    t = 0.0 if LL == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / LL))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

def route_leg(s, t, A, B, sig, widen=1.0):
    """A* from node s to t; each metre costs (1 + (distance from line A-B / sig)^2),
    each 90 deg turn TURN metres. Falls back to wider corridors, then looser sig."""
    ax, ay = A; bx, by = B
    L = math.hypot(bx - ax, by - ay)
    corr = max(4 * sig, 0.35 * L) * widen
    start = (s, -1); gs = {start: 0.0}; prev = {}; pq = [(0.0, 0, start)]; closed = set(); cnt = 0; goal = None; it = 0
    isg = 1.0 / (sig * sig)
    while pq and it < 300000:
        it += 1
        f, _, stt = heapq.heappop(pq)
        if stt in closed: continue
        u, pu = stt
        if u == t: goal = stt; break
        closed.add(stt)
        ux, uy = NX[u], NY[u]
        if pu >= 0:
            hx, hy = ux - NX[pu], uy - NY[pu]; hn = math.hypot(hx, hy) or 1.0
        gu = gs[stt]
        for v in nbr[u]:
            if v == pu: continue
            vx, vy = NX[v], NY[v]
            dm = _dseg((ux + vx) / 2, (uy + vy) / 2, ax, ay, bx, by)
            if dm > corr: continue
            e = math.hypot(vx - ux, vy - uy)
            dv = _dseg(vx, vy, ax, ay, bx, by)
            turn = TURN * (1 - ((vx - ux) * hx + (vy - uy) * hy) / (e * hn)) if (pu >= 0 and e > 0) else 0.0
            ng = gu + e * (1 + (dm * dm + dv * dv) * 0.5 * isg) + turn
            sv = (v, u)
            if ng < gs.get(sv, 1e18):
                gs[sv] = ng; prev[sv] = stt; cnt += 1
                heapq.heappush(pq, (ng + math.hypot(bx - vx, by - vy), cnt, sv))
    if goal is None:
        if widen < 3: return route_leg(s, t, A, B, sig, 3.0)
        if widen < 50: return route_leg(s, t, A, B, sig * 3, 100.0)
        return None
    path = []; stt = goal
    while True:
        path.append(stt[0])
        if stt == start: break
        stt = prev[stt]
    return path[::-1]

def plen(p):
    return float(np.hypot(np.diff(NX[p]), np.diff(NY[p])).sum()) if len(p) > 1 else 0.0

SPUR_M = 160.0
LOOP_M = 260.0   # knots under this are snapping noise; an ear or a fin is bigger
def clean(p, max_loop_m):
    """remove short out-and-back spurs (A,B,...,B,A under SPUR_M deep: snapping
    noise; a deliberate spike such as an ear or a swoosh tip is longer and kept)
    and small closed detours (a node revisited after < max_loop_m)"""
    changed = True
    while changed:
        changed = False
        for i in range(1, len(p) - 1):
            if p[i - 1] == p[i + 1]:
                k = 1
                while i - k - 1 >= 0 and i + k + 1 < len(p) and p[i - k - 1] == p[i + k + 1]: k += 1
                if plen(p[i - k:i + 1]) < SPUR_M:
                    p = p[:i - k + 1] + p[i + k + 1:]; changed = True; break
        if changed: continue
        last = {}
        for i, q in enumerate(p):
            if q in last:
                j = last[q]
                seg = p[j:i + 1]
                # keep the stroke's own closure (whole loop) - only cut short detours
                if 0 < plen(seg) < max_loop_m and not (j == 0 and i == len(p) - 1):
                    p = p[:j] + p[i:]; changed = True; break
            last[q] = i
    return p

def densify(poly, step):
    out = [poly[0]]
    for a, b in zip(poly[:-1], poly[1:]):
        L = float(np.hypot(*(b - a))); n = max(1, int(math.ceil(L / step)))
        for k in range(1, n + 1): out.append(a + (b - a) * k / n)
    return np.array(out)

def place(SKU, pl):
    cx, cy, H, th = pl
    c, s_ = math.cos(math.radians(th)), math.sin(math.radians(th))
    return [np.stack([cx + c * s[:, 0] * H - s_ * s[:, 1] * H, cy + s_ * s[:, 0] * H + c * s[:, 1] * H], 1) for s in SKU]

def trace(SKU, pl, wp_m=200.0):
    H = pl[2]; sig = max(30.0, 0.018 * H)
    strokes = []; fails = 0
    for poly in place(SKU, pl):
        wp = densify(poly, wp_m)
        _, idx = snap(wp)
        path = [int(idx[0])]
        for k in range(1, len(wp)):
            a, b = path[-1], int(idx[k])
            if a == b: continue
            p = route_leg(a, b, wp[k - 1], wp[k], sig)
            if p is None:
                fails += 1
                if len(path) > 1: strokes.append(clean(path, LOOP_M))
                path = [b]; continue
            path += p[1:]
        if len(path) > 1: strokes.append(clean(path, LOOP_M))
    return strokes, fails

def km_of(strokes):
    return sum(plen(p) for p in strokes) / 1000

def to_latlng(p):
    return [[float(lat[q]), float(lng[q])] for q in p]
