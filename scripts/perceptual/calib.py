"""Soundness gate for a free local perceptual scorer (CLIP on the RTX 5080).

Test A: corpus. For each catalogued strav.art piece, render its line mask and
ask CLIP to pick its own subject text out of 100 random other subjects. If the
scorer measures legibility, pieces the catalogue called strong (stranger would
name it >= 7) must be recognised far more often than weak ones (<= 4).

Test B: our routes with known verdicts (Ralph's eye / my read of the batch).
Each route render must pick its own subject among ~40 common subjects; readable
ones should rank their subject high, failures should not.
"""
import glob, json, random, re, sys, os
import numpy as np, torch, open_clip
from PIL import Image, ImageDraw

REPO = r"C:\users\ralph\desktop\pace-casso"
dev = "cuda"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "ViT-L-14"
PRE = sys.argv[2] if len(sys.argv) > 2 else "openai"
model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRE, device=dev)
tok = open_clip.get_tokenizer(MODEL)
model.eval()

@torch.no_grad()
def emb_img(ims):
    out = []
    for i in range(0, len(ims), 64):
        x = torch.stack([preprocess(im) for im in ims[i:i + 64]]).to(dev)
        e = model.encode_image(x).float()
        out.append(e / e.norm(dim=-1, keepdim=True))
    return torch.cat(out)

@torch.no_grad()
def emb_txt(ts):
    out = []
    for i in range(0, len(ts), 256):
        e = model.encode_text(tok(ts[i:i + 256]).to(dev)).float()
        out.append(e / e.norm(dim=-1, keepdim=True))
    return torch.cat(out)

def prompt(s):
    return f"a simple line drawing of {s}"

def load_mask(p):
    im = Image.open(p).convert("L")
    bb = Image.eval(im, lambda v: 255 - v).getbbox()
    if bb:
        im = im.crop(bb)
    w, h = im.size
    s = max(w, h) + 40
    c = Image.new("L", (s, s), 255)
    c.paste(im, ((s - w) // 2, (s - h) // 2))
    return c.convert("RGB")

def auc(pos, neg):
    pos, neg = np.array(pos), np.array(neg)
    return float(((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()))

# ---------------- Test A
rows = []
for f in glob.glob(REPO + r"\tmp-corpus\stravart\catalog\*.jsonl"):
    for line in open(f, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if not r.get("subject") or r.get("stranger_would_name_it") is None:
            continue
        mp = REPO + r"\tmp-corpus\stravart\masks\\" + r["file"].replace("_jpg", "") + ".png"
        if os.path.exists(mp):
            rows.append((mp, r["subject"].split(":")[0].split(";")[0][:70], int(r["stranger_would_name_it"])))
print("catalogued with masks:", len(rows))
random.seed(1)
subs = [r[1] for r in rows]
T = emb_txt([prompt(s) for s in subs])
I = emb_img([load_mask(r[0]) for r in rows])
sims = I @ T.T
ranks, scores = [], []
for i, r in enumerate(rows):
    others = random.sample([j for j in range(len(rows)) if subs[j] != subs[i]], 99)
    s = sims[i, [i] + others]
    ranks.append(int((s > s[0]).sum()))  # 0 = own subject best
    scores.append(r[2])
ranks, scores = np.array(ranks), np.array(scores)
strong, weak = scores >= 7, scores <= 4
print(f"A: top1 strong {np.mean(ranks[strong]==0):.2f} weak {np.mean(ranks[weak]==0):.2f} | "
      f"top5 strong {np.mean(ranks[strong]<5):.2f} weak {np.mean(ranks[weak]<5):.2f} | n {strong.sum()}/{weak.sum()}")
print("A: AUC(strong vs weak, by -rank) =", round(auc(-ranks[strong], -ranks[weak]), 3))
from scipy.stats import spearmanr
print("A: spearman(stranger score, -rank) =", round(spearmanr(scores, -ranks).correlation, 3))

# ---------------- Test B
def gpx_img(p, size=448, width=6):
    txt = open(p, encoding="utf-8").read()
    pts = [(float(a), float(b)) for a, b in re.findall(r'lat="([-\d.]+)"\s+lon="([-\d.]+)"', txt)]
    if not pts:
        pts = [(float(b), float(a)) for a, b in re.findall(r'lon="([-\d.]+)"\s+lat="([-\d.]+)"', txt)]
    lat0 = np.mean([p[0] for p in pts])
    xy = np.array([((lo) * np.cos(np.radians(lat0)), -la) for la, lo in pts])
    xy -= xy.min(0)
    sc = (size - 60) / xy.max()
    xy = xy * sc + (size - xy.max(0) * sc) / 2
    im = Image.new("RGB", (size, size), "white")
    ImageDraw.Draw(im).line([tuple(p) for p in xy], fill="black", width=width, joint="curve")
    return im

SUBJ = ["a cat", "a heart", "a gas pump and a man wearing headphones", "the Chanel logo of two interlocking C letters",
        "the Rolling Stones tongue and lips logo", "a unicorn", "the Nike swoosh", "the Strava logo chevrons",
        "a dog", "a horse", "a bird", "a fish", "a potato", "a rabbit", "a bear", "a house", "a star", "a flower",
        "a tree", "a car", "a shoe", "a person running", "a skull", "an apple", "a lion", "an elephant", "a boot",
        "a map of a country", "a mitten", "a ghost", "a bottle", "a key", "a guitar", "a crown", "a pig", "a whale",
        "a rocket", "a butterfly", "a letter", "a blob"]
TS = emb_txt([prompt(s) for s in SUBJ])
cases = [  # (render, true subject index, verdict)
    ("tmp-big/bg-cat/best.gpx", 0, "READS"), ("tmp-big/bg-heart/best.gpx", 1, "READS"),
    ("tmp-finisher/gas-ralph/best.gpx", 2, "RALPH-OK"), ("tmp-finisher/unicorn-ralph/best.gpx", 5, "RALPH-OK"),
    ("tmp-big/bg-gas/best.gpx", 2, "partial"), ("tmp-big/bg-chanel/best.gpx", 3, "FAIL"),
    ("tmp-big/bg-stones/best.gpx", 4, "FAIL"),
    ("tmp-batch/cat/best.gpx", 0, "READS"), ("tmp-batch/strava/best.gpx", 7, "arguable"),
    ("tmp-batch/heart/best.gpx", 1, "FAIL-broken"), ("tmp-batch/stones/best.gpx", 4, "FAIL"),
    ("tmp-batch/chanel/best.gpx", 3, "FAIL"), ("tmp-batch/pacelogo/best.gpx", None, "FAIL"),
    ("tmp-batch/gas/best.gpx", 2, "FAIL"),
]
os.makedirs("renders", exist_ok=True)
for p, ti, v in cases:
    fp = os.path.join(REPO, p)
    if not os.path.exists(fp) or ti is None:
        continue
    im = gpx_img(fp)
    im.save("renders/" + p.replace("/", "_") + ".png")
    s = (emb_img([im]) @ TS.T)[0]
    rank = int((s > s[ti]).sum())
    top = [SUBJ[j] for j in s.argsort(descending=True)[:3].tolist()]
    print(f"B: {v:12s} {p:38s} rank {rank:2d}/40  top3 {top}")
