"""Fit an interpretive sketch onto real NYC streets by perceptual search.

Sketch strokes (from abstract.py) are placed on the 500k-node NYC walk graph
at a free centre / size / rotation, each stroke leg is routed with a corridor
A* (stay near the intended line), the ROUTED drawing is rendered, and scored
by ViT-L/14 (the scorer calibrated in calib.py) against the upload.
Stage 1 samples placements city-wide; stage 2 hill-climbs placement and
individual sketch vertices on the best seats. A second model (ViT-B/16 LAION,
never optimised against) grades the finalists.

usage: streetfit.py target.png sketch.json out_dir [n_seats] [refine_rounds]
"""
import sys, os, json, math, random, heapq, time
import numpy as np, torch, open_clip
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

dev = "cuda"
TGT, SK, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
NSEATS = int(sys.argv[4]) if len(sys.argv) > 4 else 240
ROUNDS = int(sys.argv[5]) if len(sys.argv) > 5 else 60
TEXT = os.environ["SUBJECT_TEXT"]
os.makedirs(OUT, exist_ok=True)
random.seed(1); np.random.seed(1)
R = 224

# ---------------- graph
g = json.load(open(r"C:\users\ralph\desktop\pace-casso\lib\data\nyc-core-walk-graph.json"))
lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
LAT0, LNG0 = 40.70, -73.95
KX = math.cos(math.radians(LAT0)) * 111320; KY = 110540
NX = (lng - LNG0) * KX; NY = (lat - LAT0) * KY
E = np.array(g["edges"]).reshape(-1, 2)
N = len(NX)
nbr = [[] for _ in range(N)]
for a, b in E.tolist():
    if a != b:
        nbr[a].append(b); nbr[b].append(a)
deg = np.array([len(x) for x in nbr])
tree = cKDTree(np.stack([NX, NY], 1))
land = np.nonzero(deg >= 3)[0]
print(f"graph {N} nodes", flush=True)

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

leg_cache = {}
TURN = float(os.environ.get("TURN_M", "60"))
KM_W = float(os.environ.get("KM_W", "0.006"))
DEV_W = float(os.environ.get("DEV_W", "1.5"))
def route_leg(s, t):
    if (s, t) in leg_cache: return leg_cache[(s, t)]
    p = _route_leg(s, t, 1.0, 90000)
    if p is None: p = _route_leg(s, t, 3.0, 250000)
    leg_cache[(s, t)] = p
    return p

def _route_leg(s, t, widen, cap):
    """corridor A*: length + 1.5 x distance from the straight s-t line."""
    ax, ay, bx, by = NX[s], NY[s], NX[t], NY[t]
    L = math.hypot(bx - ax, by - ay)
    corr = max(120.0, 0.3 * L) * widen
    # states are (node, previous node) so heading changes can cost TURN metres
    # per 90 degrees: long clean runs and regular staircases beat jitter
    start = (s, -1)
    gs = {start: 0.0}; prev = {}; pq = [(L, 0, start)]; closed = set(); it = 0; goal = None; cnt = 0
    while pq and it < cap:
        it += 1
        f, _, st = heapq.heappop(pq)
        if st in closed: continue
        u, pu = st
        if u == t: goal = st; break
        closed.add(st)
        gu = gs[st]; ux, uy = NX[u], NY[u]
        if pu >= 0:
            hx, hy = ux - NX[pu], uy - NY[pu]; hn = math.hypot(hx, hy) or 1.0
        for v in nbr[u]:
            if v == pu: continue
            vx, vy = NX[v], NY[v]
            d = seg_dist(vx, vy, ax, ay, bx, by)
            if d > corr: continue
            el = math.hypot(vx - ux, vy - uy)
            turn = 0.0
            if pu >= 0 and el > 0:
                turn = TURN * (1 - ((vx - ux) * hx + (vy - uy) * hy) / (el * hn))
            ng = gu + el + DEV_W * d + turn
            sv = (v, u)
            if ng < gs.get(sv, 1e18):
                gs[sv] = ng; prev[sv] = st; cnt += 1
                heapq.heappush(pq, (ng + math.hypot(bx - vx, by - vy), cnt, sv))
    if goal is None:
        return None
    path = []; st = goal
    while True:
        path.append(st[0])
        if st == start: break
        st = prev[st]
    path.reverse()
    return path

# ---------------- sketch
sk = json.load(open(SK))["strokes"]
SKU = [np.array([[(x / R) * 2 - 1, 1 - (y / R) * 2] for x, y in s]) for s in sk]  # unit, y up

def place(pl, sku=SKU):
    cx, cy, H, th = pl
    c, s = math.cos(math.radians(th)), math.sin(math.radians(th))
    out = []
    for st in sku:
        x = st[:, 0] * H; y = st[:, 1] * H
        out.append(np.stack([cx + c * x - s * y, cy + s * x + c * y], 1))
    return out

def route(pl, sku=SKU):
    """returns list of routed strokes (node lists) and quality info"""
    pts = place(pl, sku)
    strokes = []; miss = 0; far = 0; total = 0
    for st in pts:
        d, idx = tree.query(st)
        far += int((d > 0.12 * pl[2]).sum()); total += len(st)
        nodes = [int(i) for i in idx]
        path = [nodes[0]]
        for a, b in zip(nodes[:-1], nodes[1:]):
            if a == b: continue
            p = route_leg(a, b)
            if p is None:
                miss += 1
                if len(path) > 1: strokes.append(path)
                path = [b]; continue
            path += p[1:]
        if len(path) > 1: strokes.append(path)
    return strokes, miss, far / max(1, total)

def render(pl, strokes, size=R, width=2):
    """render in the DRAWING frame (as the runner's GPS art reads)"""
    cx, cy, H, th = pl
    # judged NORTH-UP, exactly as the runner and their friends see it on a map
    c, s = 1.0, 0.0
    S2 = size * 2
    im = Image.new("L", (S2, S2), 255); d = ImageDraw.Draw(im)
    for p in strokes:
        x = NX[p] - cx; y = NY[p] - cy
        u = c * x - s * y; v = s * x + c * y
        xy = np.stack([(u / H + 1) / 2 * S2, (1 - v / H) / 2 * S2], 1)
        d.line([tuple(q) for q in xy], fill=0, width=width * 2, joint="curve")
    return im.resize((size, size), Image.LANCZOS).convert("RGB")

def km_of(strokes):
    return sum(float(np.hypot(np.diff(NX[p]), np.diff(NY[p])).sum()) for p in strokes) / 1000

# ---------------- scorers
def mk(name, pre):
    m, _, pp = open_clip.create_model_and_transforms(name, pretrained=pre, device=dev); m.eval()
    return m, pp, open_clip.get_tokenizer(name)
def load(p):
    im = Image.open(p).convert("RGB"); w0, h0 = im.size; s0 = max(w0, h0)
    cv = Image.new("RGB", (s0, s0), "white"); cv.paste(im, ((s0 - w0) // 2, (s0 - h0) // 2))
    return cv.resize((R, R), Image.LANCZOS)
tp = load(TGT)
# vocabulary for the recognition test (the one that passed calibration):
# 300 gallery subjects + common failure look-alikes, true subject last
_voc = set()
for f in __import__("glob").glob(r"C:\users\ralph\desktop\pace-casso\tmp-corpus\stravart\catalog\*.jsonl"):
    for line in open(f, encoding="utf-8"):
        try: v = json.loads(line).get("subject")
        except Exception: continue
        if v: _voc.add(v.split(":")[0].split(";")[0].split("(")[0].strip()[:60])
VOCAB = random.Random(3).sample(sorted(_voc), 300) + [
    "a mitten", "a map of a country", "a blob", "a random scribble", "a maze", "a potato", "a boot", "a key",
    "a person running", "a dog", "a cat", "a heart", "a house", "a bottle", "a letter", "a robot", "a building"]
VOCAB = [v for v in VOCAB if v.lower() != TEXT.lower()] + [TEXT]
class Scorer:
    """log-probability that the drawing gets named TEXT among VOCAB."""
    def __init__(self, name, pre):
        self.m, self.pp, self.tok = mk(name, pre)
        with torch.no_grad():
            e = self.m.encode_text(self.tok([f"a line drawing of {v}" for v in VOCAB]).to(dev)).float()
        self.tt = e / e.norm(dim=-1, keepdim=True)
    @torch.no_grad()
    def emb(self, ims):
        x = torch.stack([self.pp(im) for im in ims]).to(dev)
        e = self.m.encode_image(x).float(); return e / e.norm(dim=-1, keepdim=True)
    def score(self, ims):
        return torch.log_softmax(100 * self.emb(ims) @ self.tt.T, -1)[:, -1].cpu().numpy()
    def rank(self, ims):
        lg = self.emb(ims) @ self.tt.T
        return (lg > lg[:, -1:]).sum(-1).cpu().numpy()
main = Scorer("ViT-L-14", "openai")

def evaluate(pls, sku=SKU):
    res = []
    for pl in pls:
        st, miss, far = route(pl, sku)
        res.append((pl, st, miss, far))
    ims = [render(pl, st) if st else Image.new("RGB", (R, R), "white") for pl, st, _, _ in res]
    sc = main.score(ims)
    out = []
    for (pl, st, miss, far), s in zip(res, sc):
        pen = 1.0 * miss + 4.0 * far + KM_W * km_of(st)
        out.append((float(s) - pen, pl, st, miss, far))
    return out

# ---------------- stage 1: city-wide seats
t0 = time.time()
seats = []
for _ in range(NSEATS):
    n = int(random.choice(land))
    seats.append((float(NX[n]), float(NY[n]), random.choice([2500, 3500, 5000, 7000, 9000]), random.uniform(-35, 35)))
res = []
for i in range(0, len(seats), 24):
    res += evaluate(seats[i:i + 24])
res.sort(key=lambda r: -r[0])
print(f"stage1 {len(res)} seats in {time.time()-t0:.0f}s; top: " + ", ".join(f"{r[0]:.3f}" for r in res[:5]), flush=True)

# ---------------- stage 2: refine top seats (placement jitter + sketch vertex nudges)
finals = []
for rank, (s0, pl, st, miss, far) in enumerate(res[:4]):
    best = (s0, pl, [x.copy() for x in SKU], st)
    for rd in range(ROUNDS):
        cands = []
        for _ in range(12):
            bpl = list(best[1]); bsk = [x.copy() for x in best[2]]
            if random.random() < 0.4:
                bpl[0] += random.gauss(0, 0.05 * bpl[2]); bpl[1] += random.gauss(0, 0.05 * bpl[2])
                bpl[2] *= math.exp(random.gauss(0, 0.06)); bpl[3] += random.gauss(0, 3)
            else:
                k = random.randrange(len(bsk)); v = random.randrange(len(bsk[k]))
                bsk[k][v] += np.random.normal(0, 0.04, 2)
            cands.append((tuple(bpl), bsk))
        ev = []
        for pl2, sk2 in cands:
            r = evaluate([pl2], sk2)[0]
            ev.append((r[0], pl2, sk2, r[2]))
        b = max(ev, key=lambda r: r[0])
        if b[0] > best[0]: best = b
    print(f"seat {rank}: {s0:.3f} -> {best[0]:.3f}  km {km_of(best[3]):.1f}  H {best[1][2]:.0f}  rot {best[1][3]:.0f}", flush=True)
    finals.append(best)

# ---------------- held-out grade + outputs
held = Scorer("ViT-B-16", "laion2b_s34b_b88k")
ims = [render(f[1], f[3]) for f in finals]
hs = held.rank(ims); ms = main.rank(ims)
for i, (f, h) in enumerate(zip(finals, hs)):
    s, pl, sk2, st = f
    render(pl, st, 448, 3).save(f"{OUT}/seat{i}_drawing.png")
    # map view, north-up, with street background
    cx, cy, H = pl[0], pl[1], pl[2] * 1.25
    S2 = 900; im = Image.new("RGB", (S2, S2), "white"); d = ImageDraw.Draw(im)
    near = tree.query_ball_point([cx, cy], H * 1.45)
    nearset = set(near)
    for a in near:
        for b in nbr[a]:
            if b > a and b in nearset:
                d.line([((NX[a]-cx)/H*S2/2+S2/2, S2/2-(NY[a]-cy)/H*S2/2), ((NX[b]-cx)/H*S2/2+S2/2, S2/2-(NY[b]-cy)/H*S2/2)], fill=(222, 222, 222), width=1)
    for p in st:
        d.line([((NX[q]-cx)/H*S2/2+S2/2, S2/2-(NY[q]-cy)/H*S2/2) for q in p], fill=(235, 70, 20), width=4)
    im.save(f"{OUT}/seat{i}_map.png")
    json.dump({"score": s, "held_out_rank": int(h), "main_rank": int(ms[i]), "km_ink": km_of(st), "placement": pl,
               "center_latlng": [LAT0 + pl[1] / KY, LNG0 + pl[0] / KX],
               "strokes_latlng": [[[float(lat[q]), float(lng[q])] for q in p] for p in st]},
              open(f"{OUT}/seat{i}.json", "w"))
    print(f"FINAL seat{i}: logp {s:.2f} rank main {ms[i]} held-out {h} km {km_of(st):.1f} center {LAT0 + pl[1]/KY:.4f},{LNG0 + pl[0]/KX:.4f} H {pl[2]:.0f} rot {pl[3]:.0f}", flush=True)
