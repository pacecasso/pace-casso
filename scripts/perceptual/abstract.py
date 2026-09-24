"""CLIPasso-lite: optimise N polyline strokes so the drawing is perceptually
like the upload (RN101 conv-layer geometry + ViT-B/32 semantics).
Optional grid mode: stroke vertices are snapped (straight-through) to a lattice
rotated like Manhattan's grid, so the optimiser sees the drawing as the street
grid would force it to be.

usage: abstract.py image out_prefix n_strokes [grid_cells(0=off)] [seed]
"""
import sys, json, math, random
import numpy as np, torch, torch.nn.functional as F, open_clip
from PIL import Image

dev = "cuda"
img_path, out, NS = sys.argv[1], sys.argv[2], int(sys.argv[3])
GRID = int(sys.argv[4]) if len(sys.argv) > 4 else 0
SEED = int(sys.argv[5]) if len(sys.argv) > 5 else 0
torch.manual_seed(SEED); random.seed(SEED); np.random.seed(SEED)
R = 224
P = 6  # points per stroke

def load(p):
    im = Image.open(p)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    im = im.convert("RGB")
    w, h = im.size; s = max(w, h)
    c = Image.new("RGB", (s, s), "white"); c.paste(im, ((s - w) // 2, (s - h) // 2))
    return c.resize((R, R), Image.LANCZOS)

target_pil = load(img_path)
target = torch.tensor(np.asarray(target_pil), dtype=torch.float32, device=dev).permute(2, 0, 1)[None] / 255

MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=dev)[None, :, None, None]
STD = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=dev)[None, :, None, None]
rn, _, _ = open_clip.create_model_and_transforms("RN101", pretrained="openai", device=dev)
vb, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai", device=dev)
rn.eval(); vb.eval()
for p in list(rn.parameters()) + list(vb.parameters()):
    p.requires_grad_(False)
V = rn.visual

def rn_feats(x):
    x = (x - MEAN) / STD
    x = V.act1(V.bn1(V.conv1(x))); x = V.act2(V.bn2(V.conv2(x))); x = V.act3(V.bn3(V.conv3(x))); x = V.avgpool(x)
    f2 = V.layer1(x); f3 = V.layer2(f2); f4 = V.layer3(f3)
    return [f3, f4]

def vb_emb(x):
    e = vb.encode_image((x - MEAN) / STD)
    return e / e.norm(dim=-1, keepdim=True)

def augment(x, n=4):
    outs = [x]
    for _ in range(n - 1):
        th = torch.eye(2, 3, device=dev)[None].repeat(x.shape[0], 1, 1)
        th[:, :, :2] += (torch.rand(x.shape[0], 2, 2, device=dev) - 0.5) * 0.25
        th[:, :, 2] += (torch.rand(x.shape[0], 2, device=dev) - 0.5) * 0.1
        g = F.affine_grid(th, x.shape, align_corners=False)
        outs.append(F.grid_sample(x, g, padding_mode="border", align_corners=False))
    return torch.cat(outs)

# --- init strokes at ink / edge saliency (CLIPasso inits from saliency)
gray = np.asarray(target_pil.convert("L"), dtype=np.float32) / 255
gy, gx = np.gradient(gray)
sal = np.hypot(gx, gy) + 0.15 * (gray < 0.8)
sal = sal / sal.sum()
idx = np.random.choice(R * R, NS, p=sal.ravel(), replace=False)
starts = np.stack([idx % R, idx // R], 1).astype(np.float32)
pts = []
for s in starts:
    ang = random.random() * 2 * math.pi
    d = np.array([math.cos(ang), math.sin(ang)]) * 5
    pts.append([s + d * (k - P / 2) + np.random.randn(2) * 1.5 for k in range(P)])
X = torch.tensor(np.array(pts), dtype=torch.float32, device=dev, requires_grad=True)  # NS,P,2

# Manhattan lattice frame: rotated 29 deg; avenues coarse, streets fine (aspect ~3:1)
ANG = math.radians(29)
rot = torch.tensor([[math.cos(ANG), -math.sin(ANG)], [math.sin(ANG), math.cos(ANG)]], device=dev)

def snap(x):
    if not GRID:
        return x
    cell = R / GRID
    c = (x - R / 2) @ rot  # into grid frame
    step = torch.tensor([cell, cell / 3], device=dev)
    q = torch.round(c / step) * step
    q = c + (q - c).detach()  # straight-through
    return q @ rot.T + R / 2

def expand_grid_path(x):
    """Between snapped vertices, walk the lattice as a staircase: split each
    segment into equal stair steps along the two grid axes (what the runner
    actually does on a grid). Differentiable in vertex positions."""
    if not GRID:
        return x
    cell = R / GRID
    c = (x - R / 2) @ rot  # NS,P,2
    a, b = c[:, :-1], c[:, 1:]
    d = b - a
    n = 6
    t = torch.linspace(0, 1, n + 1, device=dev)
    pts = []
    for k in range(n):
        p0 = a + d * t[k]
        pts.append(p0)
        pts.append(p0 + torch.stack([d[..., 0] / n, torch.zeros_like(d[..., 1])], -1))
    seq = torch.stack(pts, 2).reshape(x.shape[0], -1, 2)
    seq = torch.cat([seq, c[:, -1:]], 1)
    return seq @ rot.T + R / 2

yy, xx = torch.meshgrid(torch.arange(R, device=dev), torch.arange(R, device=dev), indexing="ij")
PIX = torch.stack([xx, yy], -1).reshape(-1, 2).float() + 0.5

def render(X, width=1.6):
    Y = expand_grid_path(snap(X))
    a = Y[:, :-1].reshape(-1, 2); b = Y[:, 1:].reshape(-1, 2)
    ab = b - a
    t = ((PIX[:, None] - a[None]) * ab[None]).sum(-1) / (ab * ab).sum(-1).clamp(min=1e-6)[None]
    t = t.clamp(0, 1)
    proj = a[None] + t[..., None] * ab[None]
    d2 = ((PIX[:, None] - proj) ** 2).sum(-1)
    ink = torch.exp(-d2 / (2 * width ** 2))
    cov = 1 - torch.exp(torch.log1p(-ink.clamp(max=0.999)).sum(-1))
    img = 1 - cov.reshape(1, 1, R, R)
    return img.repeat(1, 3, 1, 1)

with torch.no_grad():
    tA = augment(target.repeat(1, 1, 1, 1), 1)
    tf = rn_feats(target)
    te = vb_emb(target)

opt = torch.optim.Adam([X], lr=1.0)
ITERS = 1500
for it in range(ITERS):
    opt.zero_grad()
    img = render(X)
    both = augment(torch.cat([img, target]), 4)
    xi, xt = both[0::2], both[1::2]
    fi, ft = rn_feats(xi), rn_feats(xt)
    geo = sum(((a - b) ** 2).mean() for a, b in zip(fi, ft))
    sem = 1 - (vb_emb(xi) * vb_emb(xt)).sum(-1).mean()
    loss = geo + 0.1 * sem
    loss.backward()
    opt.step()
    with torch.no_grad():
        X.clamp_(4, R - 4)
    if it % 500 == 0 or it == ITERS - 1:
        print(f"it {it} geo {geo.item():.4f} sem {sem.item():.4f}", flush=True)

with torch.no_grad():
    img = render(X, width=1.4)
    Image.fromarray((img[0].permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)).resize((448, 448)).save(out + ".png")
    json.dump({"strokes": snap(X).cpu().tolist(), "grid": GRID, "size": R}, open(out + ".json", "w"))
