"""Geometry-first fit, end to end: picture -> size-aware plan -> spot search
(streets that already run along the shape) -> deviation-charged tracing ->
selection by measured likeness -> one continuous runnable GPX per lane.

usage: python fit.py <upload> <outdir> [--lanes=short:10,pick:20,long:35] [--text=keep|drop|only]
writes <outdir>/<lane>.gpx, <lane>.json (km, points, label, stats), <lane>_plan.png
"""
import sys, os, json, math, random, time, heapq
import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import city as C
import plan as P

KM_PER_UNIT_H = 1.25        # ink km ~ KM_PER_UNIT_H * L_unit * H / 1000 (calibrated on practice set)
NSEATS = int(os.environ.get("NSEATS", "30000"))
NTRACE = int(os.environ.get("NTRACE", "16"))
# drawing style (an owner decision for bold marks): "outline" draws solid parts
# as their outline; "line" draws every part as one single centre line
STYLE = "outline"; OUTLINE_W = P.OUTLINE_W_M
PARTS = None
# block-letter weight in the spot score (strict-direction support of the typed words)
TEXT_W = float(os.environ.get("TEXT_W", "4.0"))

def targets(sku):
    TS, TT = [], []
    for s in sku:
        d = C.densify(s, 0.01)
        tg = np.gradient(d, axis=0)
        TS.append(d); TT.append(np.degrees(np.arctan2(tg[:, 1], tg[:, 0])))
    return np.concatenate(TS), np.concatenate(TT)

def likeness(TS, pl, strokes, tau_m):
    cx, cy, H, th = pl
    tau = tau_m / H
    c, s_ = math.cos(math.radians(-th)), math.sin(math.radians(-th))
    pts = []
    for p in strokes:
        xy = np.stack([C.NX[p] - cx, C.NY[p] - cy], 1) / H
        xy = np.stack([c * xy[:, 0] - s_ * xy[:, 1], s_ * xy[:, 0] + c * xy[:, 1]], 1)
        pts.append(C.densify(xy, 0.01))
    if not pts: return 0.0, 0.0, 0.0
    Pp = np.concatenate(pts)
    d_tp, _ = cKDTree(Pp).query(TS); d_pt, _ = cKDTree(TS).query(Pp)
    cov = float((d_tp < tau).mean()); prec = float((d_pt < tau).mean())
    return cov, prec, 2 * cov * prec / max(cov + prec, 1e-9)

def search(TS, TT, H, rng, nseats=NSEATS, text=None, ntrace=NTRACE):
    """text: (TS, TT) of typed block letters, or None. Letters only read where
    their strokes run along the grid, so they get a strict-direction support
    term and may turn up to 45 deg to square up with a grid (Manhattan's runs
    29 deg off north); a free-form mark alone keeps +-25."""
    lo, hi = 0.9 * H, 1.15 * H
    rot = 45.0 if text is not None else 25.0
    def sc(pl):
        s, off = C.support(TS, TT, pl)
        v = s - 2.0 * off - 0.002 * abs(pl[3])
        if text is not None:
            v += TEXT_W * C.support_strict(text[0], text[1], pl)
        return v
    cand = []
    for _ in range(nseats):
        n = int(C.land[rng.integers(len(C.land))])
        pl = (float(C.NX[n]), float(C.NY[n]), float(rng.uniform(lo, hi)), float(rng.uniform(-rot, rot)))
        cand.append((sc(pl), pl))
    cand.sort(key=lambda r: -r[0])
    ref = []
    for s0, pl in cand[:200]:
        best = (s0, pl)
        for _ in range(40):
            cx, cy, h, th = best[1]
            p2 = (cx + rng.normal(0, 0.03 * h), cy + rng.normal(0, 0.03 * h), float(np.clip(h * math.exp(rng.normal(0, 0.05)), lo, hi)), float(np.clip(th + rng.normal(0, 2), -rot, rot)))
            s2 = sc(p2)
            if s2 > best[0]: best = (s2, p2)
        ref.append(best)
    ref.sort(key=lambda r: -r[0])
    picked = []
    for s0, pl in ref:
        if all(math.hypot(pl[0] - q[1][0], pl[1] - q[1][1]) > 0.7 * max(pl[2], q[1][2]) for q in picked):
            picked.append((s0, pl))
        if len(picked) >= ntrace: break
    return picked

def connect(strokes, ink_w=0.1, total_w=0.1):
    """One continuous route. Starts from the longest stroke; every other stroke
    is either APPENDED (walk from the current end) or SPLICED in where the
    route passes closest (walk out, draw it, come back over the same streets:
    an out-and-back spike or a side loop), whichever adds fewer NEW visible
    metres (streets not already drawn); total km only breaks near-ties. Loops
    can be entered at any of their nodes. Connector walks retrace drawn streets
    almost for free: a join that cuts across blank space is a line the picture
    does not have (Oct 31: BIKKEL's letters traced cleanly and the joins
    between them turned the word into scribble)."""
    strokes = [s for s in strokes if len(s) > 1]
    if not strokes: return [], 0.0
    ink = set()
    for s in strokes:
        for a, b in zip(s[:-1], s[1:]): ink.add((min(a, b), max(a, b)))
    def wlen(u, v): return math.hypot(C.NX[u] - C.NX[v], C.NY[u] - C.NY[v])
    def visible(p):
        return sum(wlen(a, b) for a, b in zip(p[:-1], p[1:]) if (min(a, b), max(a, b)) not in ink)
    def dijkstra(srcs, targets, limit=1e18):
        """multi-source; returns path (list) from some src to the first target reached"""
        D = {u: 0.0 for u in srcs}; prev = {}; pq = [(0.0, u) for u in srcs]; heapq.heapify(pq)
        while pq:
            d, u = heapq.heappop(pq)
            if d > D[u] or d > limit: continue
            if u in targets:
                path = [u]
                while path[-1] in prev: path.append(prev[path[-1]])
                return path[::-1]
            for v in C.nbr[u]:
                w = wlen(u, v) * (ink_w if (min(u, v), max(u, v)) in ink else 1.0)
                if d + w < D.get(v, 1e18): D[v] = d + w; prev[v] = u; heapq.heappush(pq, (d + w, v))
        return None
    closed = [len(s) > 3 and s[0] == s[-1] for s in strokes]
    order = sorted(range(len(strokes)), key=lambda k: -C.plen(strokes[k]))
    k0 = order[0]; route = list(strokes[k0]); conn = 0.0
    left = order[1:]
    while left:
        # nearest remaining stroke to anything already on the route
        rset = set(route)
        ends = {}
        for k in left:
            pts = strokes[k][:-1] if closed[k] else [strokes[k][0], strokes[k][-1]]
            for i, q in enumerate(pts): ends.setdefault(q, (k, i))
        path = dijkstra(list(rset), set(ends))
        if path is None: left.pop(0); continue
        k, i = ends[path[-1]]; s = strokes[k]
        if closed[k]: body = s[i:-1] + s[:i + 1]
        else: body = s if i == 0 else s[::-1]
        # option A: splice at the route node where the walk started
        splice_cost = visible(path) + total_w * (2 * C.plen(path) + (C.plen(body) if closed[k] else 2 * C.plen(body)))
        # option B: append from the route's current end
        pa = dijkstra([route[-1]], set(body if closed[k] else [s[0], s[-1]]))
        append_cost = 1e18 if pa is None else visible(pa) + total_w * (C.plen(pa) + C.plen(body))
        if append_cost <= splice_cost:
            if closed[k]:
                j = s.index(pa[-1]) if pa[-1] in s[:-1] else 0
                body = s[j:-1] + s[:j + 1]
            else:
                body = s if pa[-1] == s[0] else s[::-1]
            conn += C.plen(pa); route += pa[1:] + body[1:]
            walk = pa
        else:
            at = route.index(path[0])
            back = body[::-1] if not closed[k] else []
            ins = path[1:] + body[1:] + back[1:] + path[::-1][1:] if not closed[k] else path[1:] + body[1:] + path[::-1][1:]
            conn += 2 * C.plen(path)
            route = route[:at + 1] + ins + route[at + 1:]
            walk = path
        left.remove(k)
        # the join is drawn now too: later joins may retrace it
        for p_ in (body, walk):
            for a, b in zip(p_[:-1], p_[1:]): ink.add((min(a, b), max(a, b)))
    return route, conn / 1000

def plan_for_km(mask, km, text_mode):
    hmin = 0.0 if STYLE == "line" else P.min_half_size(mask, text_mode)
    H = 2000.0
    for _ in range(3):
        pp = P.make_plan(mask, H, text_mode, OUTLINE_W, parts=PARTS)
        L = P.unit_length(pp["strokes"])
        if L <= 0: return pp
        H = float(np.clip(km * 1000 / (KM_PER_UNIT_H * L), 500, 6000))
    bumped = H < 1.2 * hmin
    pp = P.make_plan(mask, max(H, 1.2 * hmin), text_mode, OUTLINE_W, parts=PARTS)
    pp["bumped_from_H"] = H if bumped else None
    return pp

def text_strokes(sku, words_mask):
    """the plan strokes that draw the typed words (mostly inside words_mask)"""
    if words_mask is None or not words_mask.any(): return []
    near = P.nd.binary_dilation(words_mask, iterations=3)
    out = []
    for s in sku:
        px = np.clip(((s[:, 0] + 1) / 2 * P.HI).astype(int), 0, P.HI - 1)
        py = np.clip(((1 - s[:, 1]) / 2 * P.HI).astype(int), 0, P.HI - 1)
        if near[py, px].mean() > 0.5: out.append(s)
    return out

def fit_lane(mask, km, text_mode, seed=1, words_mask=None):
    rng = np.random.default_rng(seed)
    pp = plan_for_km(mask, km, text_mode)
    sku = pp["strokes"]
    if not sku: return None
    TS, TT = targets(sku)
    tsk = text_strokes(sku, words_mask)
    text = targets(tsk) if tsk else None
    # word logos: more traced candidates, since the letters only read on a few spots
    picked = search(TS, TT, pp["H"], rng, text=text, ntrace=40 if text is not None else NTRACE)
    best = None
    for s0, pl in picked:
        st, fails = C.trace(sku, pl)
        cov, prec, F = likeness(TS, pl, st, max(30.0, 0.015 * pl[2]))
        score = F - 0.004 * abs(pl[3]) - 0.03 * fails
        tcov = None
        if text is not None:
            # how much of the lettering the traced streets actually cover
            tcov = likeness(text[0], pl, st, max(30.0, 0.015 * pl[2]))[0]
            score += tcov
        if best is None or score > best[0]:
            best = (score, pl, st, cov, prec, F, s0, fails, tcov)
    score, pl, st, cov, prec, F, s0, fails, tcov = best
    route, conn = connect(st)
    return {"plan": pp, "placement": pl, "strokes": st, "route": route, "km": round(C.plen(route) / 1000, 1),
            "km_ink": round(C.km_of(st), 1), "connector_km": round(conn, 1), "coverage": cov, "precision": prec,
            "F": F, "support": s0, "fails": fails, "text_cov": tcov, "score": score}

def save(res, out, name, label):
    r = res["route"]
    with open(f"{out}/{name}.gpx", "w") as f:
        f.write('<?xml version="1.0"?><gpx version="1.1" creator="pacecasso-geofit"><trk><trkseg>')
        for n in r: f.write(f'<trkpt lat="{C.lat[n]:.6f}" lon="{C.lng[n]:.6f}"/>')
        f.write("</trkseg></trk></gpx>")
    pp = res["plan"]
    json.dump({"label": label, "km": res["km"], "points": [[float(C.lat[n]), float(C.lng[n])] for n in r],
               "stats": {k: res[k] for k in ("km_ink", "connector_km", "coverage", "precision", "F", "support", "fails")},
               "placement": list(res["placement"]), "center_latlng": [C.LAT0 + res["placement"][1] / C.KY, C.LNG0 + res["placement"][0] / C.KX],
               "plan": {"H": pp["H"], "kinds": pp["kinds"], "dropped": pp["dropped"], "kept_frac": pp["kept_frac"],
                        "has_text": pp["has_text"], "lineart": pp["lineart"], "bumped_from_H": pp.get("bumped_from_H")},
               "strokes_latlng": [C.to_latlng(p) for p in res["strokes"]]}, open(f"{out}/{name}.json", "w"))
    im = Image.new("RGB", (400, 400), "white"); d = ImageDraw.Draw(im)
    for s in pp["strokes"]:
        d.line([((x + 1) * 200, (1 - y) * 200) for x, y in s], fill="black", width=2)
    im.save(f"{out}/{name}_plan.png")

if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    lanes = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--lanes=")), "short:10,pick:20,long:35")
    text_mode = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--text=")), "keep")
    STYLE = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--style=")), "outline")
    if STYLE == "line": OUTLINE_W = 1e9
    os.makedirs(out, exist_ok=True)
    mask, PARTS = P.ink_parts(src)
    if os.environ.get("NO_COLOUR_PARTS"): PARTS = None
    for lane in lanes.split(","):
        name, km = lane.split(":"); t0 = time.time()
        res = fit_lane(mask, float(km), text_mode)
        if res is None: print(f"{name}: nothing to draw"); continue
        save(res, out, name, name)
        pp = res["plan"]
        print(f"{name}: target {km} km -> {res['km']} km ({res['km_ink']} ink + {res['connector_km']} connectors) "
              f"H {res['placement'][2]:.0f} rot {res['placement'][3]:.0f} F {res['F']:.2f} cov {res['coverage']:.2f} prec {res['precision']:.2f} "
              f"support {res['support']:.2f} fails {res['fails']} | plan {len(pp['strokes'])} strokes {sorted(set(pp['kinds']))} "
              f"kept {pp['kept_frac']:.2f} dropped {pp['dropped'][:4]} text {pp['has_text']} bumped {pp.get('bumped_from_H')} ({time.time()-t0:.0f}s)", flush=True)
