"""Street-paint: choose WHICH street blocks to ink so the run looks like the upload.

Every block (degree-2 chain between intersections) inside a square window is a
variable w in [0,1]. The drawing is rendered exactly as the GPS trace would
show it (the real street geometry), and scored by perceptual CLIP losses
against the target line art. A length term keeps the run short. Backtracking
is allowed, so ANY connected set of blocks is runnable: after optimisation the
chosen blocks are connected (shortest paths that prefer already-inked blocks)
and a Chinese-postman circuit is planned through them.

usage: streetpaint.py target.png out_prefix lat lng halfM [rotDeg] [lenW] [seed]
"""
import sys, json, math, random, heapq
from collections import defaultdict
import numpy as np, torch, torch.nn.functional as F, open_clip
from PIL import Image, ImageDraw

dev = "cuda"
tgt_path, out = sys.argv[1], sys.argv[2]
LAT0, LNG0, HALF = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
ROT = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
LENW = float(sys.argv[7]) if len(sys.argv) > 7 else 1.0
SEED = int(sys.argv[8]) if len(sys.argv) > 8 else 0
torch.manual_seed(SEED); random.seed(SEED)
R = 224
GRAPH = r"C:\users\ralph\desktop\pace-casso\lib\data\nyc-core-walk-graph.json"

# ---------------- graph window -> chains
g = json.load(open(GRAPH))
lat = np.array(g["lat"]) / g["scale"]; lng = np.array(g["lng"]) / g["scale"]
E = np.array(g["edges"]).reshape(-1, 2)
kx = math.cos(math.radians(LAT0)) * 111320; ky = 110540
X = (lng - LNG0) * kx; Y = (lat - LAT0) * ky
c, s = math.cos(math.radians(ROT)), math.sin(math.radians(ROT))
U = c * X + s * Y; Vv = -s * X + c * Y  # drawing frame
inside = (np.abs(U) < HALF * 1.02) & (np.abs(Vv) < HALF * 1.02)
E = E[inside[E[:, 0]] & inside[E[:, 1]]]
adj = defaultdict(set)
for a, b in E:
    if a != b:
        adj[a].add(b); adj[b].add(a)
def pix(n):
    return ((U[n] / HALF + 1) * R / 2, (1 - Vv[n] / HALF) * R / 2)
def mdist(a, b):
    return math.hypot(X[a] - X[b], Y[a] - Y[b])

seen = set(); chains = []
for n in list(adj):
    if len(adj[n]) == 2:
        continue
    for m in adj[n]:
        if (n, m) in seen:
            continue
        path = [n, m]; seen.add((n, m)); seen.add((m, n))
        while len(adj[path[-1]]) == 2:
            nx = [q for q in adj[path[-1]] if q != path[-2]]
            if not nx or (path[-1], nx[0]) in seen:
                break
            seen.add((path[-1], nx[0])); seen.add((nx[0], path[-1])); path.append(nx[0])
        chains.append(path)
C = len(chains)
clen = np.array([sum(mdist(p[i], p[i + 1]) for i in range(len(p) - 1)) for p in chains])
print(f"window chains {C}, total street km {clen.sum()/1000:.0f}", flush=True)

# ---------------- sparse raster of each chain (anti-aliased line, width ~1.6 px)
SS = 2; W = R * SS
pidx, cidx, val = [], [], []
for ci, p in enumerate(chains):
    im = Image.new("L", (W, W), 0)
    ImageDraw.Draw(im).line([(x * SS, y * SS) for x, y in (pix(n) for n in p)], fill=255, width=int(1.7 * SS))
    a = np.asarray(im, dtype=np.float32).reshape(R, SS, R, SS).mean((1, 3)) / 255
    nz = np.nonzero(a.ravel() > 0.02)[0]
    pidx.append(nz); cidx.append(np.full(len(nz), ci)); val.append(a.ravel()[nz])
pidx = torch.tensor(np.concatenate(pidx), device=dev)
cidx = torch.tensor(np.concatenate(cidx), device=dev)
val = torch.tensor(np.concatenate(val), device=dev).clamp(max=0.98)

def render(w):
    lg = torch.log1p(-(w[cidx] * val).clamp(max=0.98))
    acc = torch.zeros(R * R, device=dev).index_add(0, pidx, lg)
    img = torch.exp(acc).reshape(1, 1, R, R)  # 1 = paper, 0 = ink
    return img.repeat(1, 3, 1, 1)

# ---------------- target + models
def load(p):
    im = Image.open(p).convert("RGB"); w0, h0 = im.size; sq = max(w0, h0)
    cv = Image.new("RGB", (sq, sq), "white"); cv.paste(im, ((sq - w0) // 2, (sq - h0) // 2))
    return cv.resize((R, R), Image.LANCZOS)
tp = load(tgt_path)
target = torch.tensor(np.asarray(tp), dtype=torch.float32, device=dev).permute(2, 0, 1)[None] / 255
MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=dev)[None, :, None, None]
STD = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=dev)[None, :, None, None]
rn, _, _ = open_clip.create_model_and_transforms("RN101", pretrained="openai", device=dev)
vb, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai", device=dev)
for m in (rn, vb):
    m.eval()
    for q in m.parameters(): q.requires_grad_(False)
Vis = rn.visual
def rn_feats(x):
    x = (x - MEAN) / STD
    x = Vis.act1(Vis.bn1(Vis.conv1(x))); x = Vis.act2(Vis.bn2(Vis.conv2(x))); x = Vis.act3(Vis.bn3(Vis.conv3(x))); x = Vis.avgpool(x)
    f2 = Vis.layer1(x); f3 = Vis.layer2(f2); f4 = Vis.layer3(f3)
    return [f3, f4]
def vb_emb(x):
    e = vb.encode_image((x - MEAN) / STD); return e / e.norm(dim=-1, keepdim=True)
def augment(x, n=4):
    outs = [x]
    for _ in range(n - 1):
        th = torch.eye(2, 3, device=dev)[None].repeat(x.shape[0], 1, 1)
        th[:, :, :2] += (torch.rand(x.shape[0], 2, 2, device=dev) - 0.5) * 0.2
        th[:, :, 2] += (torch.rand(x.shape[0], 2, device=dev) - 0.5) * 0.08
        gr = F.affine_grid(th, x.shape, align_corners=False)
        outs.append(F.grid_sample(x, gr, padding_mode="border", align_corners=False))
    return torch.cat(outs)

# ---------------- init from overlap with (blurred) target ink
ink = 1 - target[0].mean(0)
inkb = F.max_pool2d(ink[None, None], 5, 1, 2)[0, 0].reshape(-1)
num = torch.zeros(C, device=dev).index_add(0, cidx, val * inkb[pidx])
den = torch.zeros(C, device=dev).index_add(0, cidx, val).clamp(min=1e-6)
ov = num / den
logit = torch.where(ov > 0.5, torch.full_like(ov, 1.0), torch.full_like(ov, -5.0)).requires_grad_(True)
DANG = float(sys.argv[9]) if len(sys.argv) > 9 else 0.0005
nodes_of = {}
ends = []
for ci, p in enumerate(chains):
    for n in (p[0], p[-1]):
        ends.append((nodes_of.setdefault(n, len(nodes_of)), ci))
end_node = torch.tensor([e[0] for e in ends], device=dev); end_chain = torch.tensor([e[1] for e in ends], device=dev)
NN = len(nodes_of)
lenN = torch.tensor(clen / 1000, device=dev, dtype=torch.float32)

@torch.no_grad()
def hard_score(lg):
    im = render((torch.sigmoid(lg) > 0.5).float())
    geo = sum(((a - b) ** 2).mean() for a, b in zip(rn_feats(im), rn_feats(target)))
    return geo.item(), (1 - (vb_emb(im) * vb_emb(target)).sum()).item()
print("HARD init geo/sem", hard_score(logit), flush=True)
opt = torch.optim.Adam([logit], lr=0.05)
ITERS = 1200
for it in range(ITERS):
    opt.zero_grad()
    w = torch.sigmoid(logit)
    beta = (it / ITERS) ** 2 * 0.02
    img = render(w)
    both = augment(torch.cat([img, target]), 4)
    xi, xt = both[0::2], both[1::2]
    geo = sum(((a - b) ** 2).mean() for a, b in zip(rn_feats(xi), rn_feats(xt)))
    sem = 1 - (vb_emb(xi) * vb_emb(xt)).sum(-1).mean()
    km = (w * lenN).sum()
    sn = torch.zeros(NN, device=dev).index_add(0, end_node, w[end_chain])
    dang = (sn * torch.exp(-(sn - 1) ** 2 / 0.3)).sum()
    loss = geo + 0.1 * sem + LENW * 0.002 * km + DANG * dang + beta * (w * (1 - w) * lenN).sum()
    loss.backward(); opt.step()
    if it % 300 == 0 or it == ITERS - 1:
        print(f"it {it} geo {geo.item():.4f} sem {sem.item():.4f} ink km {km.item():.1f} dangling {dang.item():.0f}", flush=True)

print('HARD final geo/sem', hard_score(logit), flush=True)
sel = set(np.nonzero((torch.sigmoid(logit) > 0.5).cpu().numpy())[0].tolist())

# ---------------- connect components (Dijkstra; inked blocks nearly free)
cadj = defaultdict(list)
for ci, p in enumerate(chains):
    a, b = p[0], p[-1]
    cadj[a].append((b, ci)); cadj[b].append((a, ci))
def comps(selset):
    par = {}
    def f(x):
        while par.setdefault(x, x) != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    for ci in selset:
        a, b = chains[ci][0], chains[ci][-1]; par[f(a)] = f(b)
    groups = defaultdict(set)
    for ci in selset:
        groups[f(chains[ci][0])].add(ci)
    return list(groups.values())
# drop tiny isolated specks (< 150 m) before connecting
groups = comps(sel)
for gset in groups:
    if sum(clen[ci] for ci in gset) < 150 and len(groups) > 1:
        sel -= gset
connectors = set()
while True:
    groups = comps(sel | connectors)
    if len(groups) <= 1:
        break
    groups.sort(key=lambda gs: -sum(clen[ci] for ci in gs))
    main = set(); [main.update((chains[ci][0], chains[ci][-1])) for ci in groups[0]]
    # multi-source Dijkstra from main component to any other component
    other = {}
    for k, gs in enumerate(groups[1:], 1):
        for ci in gs:
            other[chains[ci][0]] = k; other[chains[ci][-1]] = k
    dist = {n: 0.0 for n in main}; prev = {}
    pq = [(0.0, n) for n in main]; heapq.heapify(pq); hit = None
    while pq:
        d, n = heapq.heappop(pq)
        if d > dist.get(n, 1e18): continue
        if n in other: hit = n; break
        for m, ci in cadj[n]:
            nd = d + (0.05 if ci in sel or ci in connectors else 1.0) * clen[ci]
            if nd < dist.get(m, 1e18):
                dist[m] = nd; prev[m] = (n, ci); heapq.heappush(pq, (nd, m))
    if hit is None:
        # unreachable inside window: drop that component
        k = min(other.values()); sel -= groups[k]; continue
    n = hit
    while n in prev:
        n, ci = prev[n]; connectors.add(ci)

drawn = sel | connectors
# ---------------- Chinese postman (greedy odd matching via Dijkstra on drawn+all)
deg = defaultdict(int)
for ci in drawn:
    deg[chains[ci][0]] += 1; deg[chains[ci][-1]] += 1
odd = [n for n, d in deg.items() if d % 2]
extra = []
def sp(src, targets):
    dist = {src: 0.0}; prev = {}; pq = [(0.0, src)]
    while pq:
        d, n = heapq.heappop(pq)
        if d > dist[n]: continue
        if n in targets and n != src:
            path = []; m = n
            while m in prev: m, ci = prev[m]; path.append(ci)
            return n, d, path
        for m, ci in cadj[n]:
            nd = d + (1.0 if ci in drawn else 3.0) * clen[ci]
            if nd < dist.get(m, 1e18):
                dist[m] = nd; prev[m] = (n, ci); heapq.heappush(pq, (nd, m))
    return None, 0, []
oddset = set(odd)
while len(oddset) > 2:  # leave 2 odd nodes -> open route (start != finish)
    a = oddset.pop()
    b, d, path = sp(a, oddset)
    if b is None: continue
    oddset.discard(b); extra += path
multi = list(drawn) + extra
# Hierholzer
eadj = defaultdict(list)
for k, ci in enumerate(multi):
    a, b = chains[ci][0], chains[ci][-1]
    eadj[a].append((b, k, ci)); eadj[b].append((a, k, ci))
used = [False] * len(multi)
start = next(iter(oddset)) if oddset else chains[multi[0]][0]
stack = [(start, None, None)]; circuit = []
ptr = defaultdict(int)
while stack:
    n, k, ci = stack[-1]
    moved = False
    while ptr[n] < len(eadj[n]):
        m, kk, cc = eadj[n][ptr[n]]; ptr[n] += 1
        if not used[kk]:
            used[kk] = True; stack.append((m, kk, cc)); moved = True; break
    if not moved:
        stack.pop(); circuit.append((n, ci))
circuit.reverse()
route = [circuit[0][0]]
for i in range(1, len(circuit)):
    n, ci = circuit[i]
    p = chains[ci]
    seg = p if p[0] == route[-1] else p[::-1]
    route += seg[1:]
km_run = sum(mdist(route[i], route[i + 1]) for i in range(len(route) - 1)) / 1000
km_ink = sum(clen[ci] for ci in drawn) / 1000
print(f"selected {len(sel)} blocks + {len(connectors)} connectors | ink {km_ink:.1f} km | run {km_run:.1f} km | euler used {sum(used)}/{len(multi)}", flush=True)

# ---------------- outputs: hard render (what Strava shows), gpx, compare sheet
def hard(chs, size=448, col=(230, 60, 20), bg=True):
    im = Image.new("RGB", (size, size), "white"); d = ImageDraw.Draw(im)
    f = size / R
    if bg:
        for p in chains:
            d.line([(x * f, y * f) for x, y in (pix(n) for n in p)], fill=(225, 225, 225), width=1)
    for ci in chs:
        d.line([(x * f, y * f) for x, y in (pix(n) for n in chains[ci])], fill=col, width=3)
    return im
sheet = Image.new("RGB", (448 * 3, 448), "white")
sheet.paste(tp.resize((448, 448)), (0, 0)); sheet.paste(hard(drawn), (448, 0)); sheet.paste(hard(drawn, col=(0, 0, 0), bg=False), (896, 0))
sheet.save(out + "_sheet.png")
hard(drawn, size=224, col=(0, 0, 0), bg=False).save(out + "_ink.png")
with open(out + ".gpx", "w") as fh:
    fh.write('<?xml version="1.0"?><gpx version="1.1" creator="streetpaint"><trk><trkseg>')
    for n in route:
        fh.write(f'<trkpt lat="{lat[n]:.6f}" lon="{lng[n]:.6f}"/>')
    fh.write("</trkseg></trk></gpx>")
json.dump({"km_run": km_run, "km_ink": km_ink, "blocks": len(sel), "connectors": len(connectors),
           "lat": LAT0, "lng": LNG0, "half": HALF, "rot": ROT}, open(out + ".json", "w"))
