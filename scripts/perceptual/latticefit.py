"""Fit a free-form sketch onto the Manhattan lattice by discrete search.

Lattice: avenues every A px, streets every A/3 px, grid tilted 29 deg; the
drawing stays upright on a north-up map. A segment between two lattice points
is drawn as the staircase a runner makes (unit avenue / street moves that hug
the straight line). Moves: nudge one vertex by 1 avenue or 1-3 streets, drop a
vertex, drop a stroke. Every candidate is rendered exactly and scored on the
GPU (RN101 geometry + ViT-B/32 semantics + distance). Held-out ViT-L/14 grades
the result at the end.

usage: latticefit.py target.png sketch.json out_prefix cols [rounds] [kmW]
"""
import sys, json, math, random
import numpy as np, torch, open_clip
from PIL import Image, ImageDraw

dev = "cuda"
tgt, sk, out, COLS = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
ROUNDS = int(sys.argv[5]) if len(sys.argv) > 5 else 300
KMW = float(sys.argv[6]) if len(sys.argv) > 6 else 0.004
random.seed(0)
R = 224
A = R / COLS; B = A / 3
ANG = math.radians(29)
ca, sa = math.cos(ANG), math.sin(ANG)
ex = np.array([ca, sa]); ey = np.array([sa, -ca])  # grid axes in image px (y down)
CEN = np.array([R / 2, R / 2])

def to_lat(p):
    d = np.array(p) - CEN
    return (round(float(d @ ex) / A), round(float(d @ ey) / B))
def to_px(ij):
    return CEN + ij[0] * A * ex + ij[1] * B * ey

def stair(a, b):
    """unit lattice moves from a to b hugging the straight line (in metres: col=3 rows)."""
    (i0, j0), (i1, j1) = a, b
    di, dj = i1 - i0, j1 - j0
    pts = [(i0, j0)]; i, j = i0, j0
    L = math.hypot(di * 3, dj) or 1
    while (i, j) != (i1, j1):
        cands = []
        if i != i1: cands.append((i + (1 if di > 0 else -1), j))
        if j != j1: cands.append((i, j + (1 if dj > 0 else -1)))
        def off(q):
            return abs((q[0] - i0) * 3 * dj - (q[1] - j0) * di * 3) / L
        i, j = min(cands, key=off)
        pts.append((i, j))
    # merge collinear unit moves
    m = [pts[0]]
    for k in range(1, len(pts) - 1):
        a0, a1, a2 = m[-1], pts[k], pts[k + 1]
        if (a1[0] - a0[0]) * (a2[1] - a1[1]) != (a1[1] - a0[1]) * (a2[0] - a1[0]):
            m.append(a1)
    if len(pts) > 1: m.append(pts[-1])
    return m

def strokes_path(S):
    return [[q for k in range(len(s) - 1) for q in stair(s[k], s[k + 1])[(0 if k == 0 else 1):]] if len(s) > 1 else s for s in S]

def render(S, size=R, width=2, col=0):
    im = Image.new("L", (size * 2, size * 2), 255); d = ImageDraw.Draw(im)
    for path in strokes_path(S):
        if len(path) < 2: continue
        d.line([tuple(to_px(q) * 2 * size / R) for q in path], fill=col, width=width * 2, joint="curve")
    return im.resize((size, size), Image.LANCZOS)

def km(S):  # avenue step ~270 m, street ~80 m
    t = 0
    for s in S:
        for k in range(len(s) - 1):
            t += abs(s[k + 1][0] - s[k][0]) * 0.27 + abs(s[k + 1][1] - s[k][1]) * 0.08
    return t

MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=dev)[None, :, None, None]
STD = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=dev)[None, :, None, None]
rn, _, _ = open_clip.create_model_and_transforms("RN101", pretrained="openai", device=dev)
vb, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai", device=dev)
rn.eval(); vb.eval(); V = rn.visual
@torch.no_grad()
def feats(x):
    x = (x - MEAN) / STD
    e = vb.encode_image(x); e = e / e.norm(dim=-1, keepdim=True)
    y = V.act1(V.bn1(V.conv1(x))); y = V.act2(V.bn2(V.conv2(y))); y = V.act3(V.bn3(V.conv3(y))); y = V.avgpool(y)
    f3 = V.layer2(V.layer1(y)); f4 = V.layer3(f3)
    return f3, f4, e
def totensor(ims):
    return torch.stack([torch.tensor(np.asarray(im.convert("RGB")), dtype=torch.float32) for im in ims]).permute(0, 3, 1, 2).to(dev) / 255

def load(p):
    im = Image.open(p).convert("RGB"); w0, h0 = im.size; s = max(w0, h0)
    c = Image.new("RGB", (s, s), "white"); c.paste(im, ((s - w0) // 2, (s - h0) // 2))
    return c.resize((R, R), Image.LANCZOS)
tp = load(tgt)
T3, T4, TE = feats(totensor([tp]))

def score(Ss):
    f3, f4, e = feats(totensor([render(S) for S in Ss]))
    geo = ((f3 - T3) ** 2).mean((1, 2, 3)) + ((f4 - T4) ** 2).mean((1, 2, 3))
    sem = 1 - (e * TE).sum(-1)
    k = torch.tensor([km(S) for S in Ss], device=dev)
    return (geo + 0.1 * sem + KMW * k).cpu().numpy(), geo.cpu().numpy(), sem.cpu().numpy()

raw = json.load(open(sk))["strokes"]
S = []
for s in raw:
    q = [to_lat(p) for p in s]
    q = [p for k, p in enumerate(q) if k == 0 or p != q[k - 1]]
    if len(q) > 1: S.append(q)
cur, g0, s0 = score([S]); cur = cur[0]
print(f"snapped: obj {cur:.4f} geo {g0[0]:.4f} sem {s0[0]:.4f} km {km(S):.1f}", flush=True)
render(S, 448, col=0).save(out + "_snapped.png")

def mutate(S):
    S = [list(s) for s in S]
    r = random.random()
    k = random.randrange(len(S))
    if r < 0.75:
        v = random.randrange(len(S[k]))
        i, j = S[k][v]
        if random.random() < 0.5: i += random.choice((-1, 1))
        else: j += random.choice((-3, -2, -1, 1, 2, 3))
        S[k][v] = (i, j)
    elif r < 0.88 and len(S[k]) > 2:
        del S[k][random.randrange(len(S[k]))]
    elif r < 0.95 and len(S) > 1:
        del S[k]
    else:
        v = random.randrange(len(S[k]) - 1)
        a, b = S[k][v], S[k][v + 1]
        S[k].insert(v + 1, ((a[0] + b[0]) // 2 + random.choice((-1, 0, 1)), (a[1] + b[1]) // 2 + random.choice((-3, 0, 3))))
    return [s for s in S if len(s) > 1]

for rd in range(ROUNDS):
    cands = [mutate(S) for _ in range(48)]
    cands = [c for c in cands if c]
    obj, geo, sem = score(cands)
    b = int(obj.argmin())
    if obj[b] < cur:
        cur, S = obj[b], cands[b]
    if rd % 100 == 0 or rd == ROUNDS - 1:
        print(f"round {rd} obj {cur:.4f} km {km(S):.1f} strokes {len(S)}", flush=True)

_, gF, sF = score([S])
print(f"fitted: geo {gF[0]:.4f} sem {sF[0]:.4f} km {km(S):.1f}", flush=True)
render(S, 448, col=0).save(out + "_fit.png")
json.dump({"strokes": S, "cols": COLS}, open(out + "_fit.json", "w"))
