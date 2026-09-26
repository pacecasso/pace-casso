"""upload -> black ink on white, with NO per-logo flags, plus an automatic
subject name for the recognition scorer.

prep.py needed "blue" for gas (a logo printed on a solid badge): the border
colour test calls the whole yellow disc ink. Here, when one colour fills most
of the ink and something else sits on it, the something else is the logo.

The name is CLIP's own reading of the ink (ViT-L-14 over the same vocabulary
streetfit scores against, plus common logo words). streetfit then asks the
routed drawing to still be named that - the scorer is consistent with itself,
no human caption and no API call.

usage: autoprep.py upload ink.png  -> prints SUBJECT=<name>
"""
import sys, json, glob, random
import numpy as np, torch, open_clip
from PIL import Image
from scipy import ndimage as nd

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src)
if im.mode in ("RGBA", "LA", "P"):
    im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); im = Image.alpha_composite(bg, im)
a = np.asarray(im.convert("RGB")).astype(int)
border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
vals, counts = np.unique(border // 16, axis=0, return_counts=True)
bgc = vals[counts.argmax()] * 16 + 8
ink = np.abs(a - bgc).sum(-1) > 90

# badge rule: the dominant colour inside the ink is a backing plate when it
# covers most of the ink and a different colour covers a real share of it
q = a[ink] // 32
if len(q):
    v2, c2 = np.unique(q, axis=0, return_counts=True)
    plate = v2[c2.argmax()] * 32 + 16
    share = c2.max() / len(q)
    onplate = ink & (np.abs(a - plate).sum(-1) > 120)
    filled = nd.binary_fill_holes(ink)
    solid = ink.sum() / max(filled.sum(), 1)
    # a real plate SURROUNDS the logo: two-tone logos (Strava) and anti-alias
    # rims of a solid logo (Nike) touch the outside, a badge's logo does not
    rim = nd.binary_dilation(~filled, iterations=3)
    touching = (onplate & rim).sum() / max(onplate.sum(), 1)
    if share > 0.55 and solid > 0.9 and onplate.sum() > 0.08 * ink.sum() and touching < 0.03:
        ink = onplate
        print("badge: logo taken off its backing colour")
ink = nd.binary_opening(ink, iterations=1)

# frame rule: a photo of a print (canvas mockup, framed poster) puts the
# print's edge or its shadow beside the drawing as a long straight hairline.
# Routed, that hairline became a spur off the side of the cat (Sep 26 job
# 7c6da300). Drop a line only when it is straight, axis-aligned, long, touches
# no other ink, and is thinner than the drawing's own stroke or broken up.
# A shadow comes out dashed (9 pieces, gaps up to 88 px on a 450 px photo),
# so pieces are clustered by the column/row they sit on, not by gap size.
from skimage.morphology import skeletonize
H, W = ink.shape
stroke = ink.sum() / max(skeletonize(ink).sum(), 1)
lab, _ = nd.label(ink, structure=np.ones((3, 3)))
slices = nd.find_objects(lab)
for axis in (0, 1):  # 0 = vertical lines, 1 = horizontal
    span, other = (H, W) if axis == 0 else (W, H)
    tmax = max(4, 0.015 * other)
    # pieces whose whole extent is a thin band across this axis
    thin = [(i, sl) for i, sl in enumerate(slices, 1)
            if sl[1 - axis].stop - sl[1 - axis].start <= tmax]
    thin.sort(key=lambda p: p[1][1 - axis].start)
    clusters: list = []
    for p in thin:
        if clusters and p[1][1 - axis].start - clusters[-1][0][1][1 - axis].start <= 3:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    for c in clusters:
        lo = min(sl[axis].start for _, sl in c); hi = max(sl[axis].stop for _, sl in c)
        long_ = hi - lo
        band = max(sl[1 - axis].stop for _, sl in c) - min(sl[1 - axis].start for _, sl in c)
        if long_ < 0.4 * span or band > tmax:
            continue
        g = np.isin(lab, [i for i, _ in c])
        covered = g.any(axis=1 - axis).sum() / long_
        # an edge is mostly there; specks and a logo's "- TAGLINE -" dashes
        # that happen to share a row cover ~13% of it (pacelogo)
        if covered < 0.5:
            continue
        if g.sum() / long_ < 0.75 * stroke or covered < 0.85:
            ink &= ~g
            print(f"frame: dropped a {'vertical' if axis == 0 else 'horizontal'} edge line ({long_} px, {len(c)} pieces)")
Image.fromarray(np.where(ink[..., None], [20, 20, 20], [255, 255, 255]).astype(np.uint8)).save(out)

# ---- automatic subject name
voc = set()
for f in glob.glob(r"C:\users\ralph\desktop\pace-casso\tmp-corpus\stravart\catalog\*.jsonl"):
    for line in open(f, encoding="utf-8"):
        try: v = json.loads(line).get("subject")
        except Exception: continue
        if v: voc.add(v.split(":")[0].split(";")[0].split("(")[0].strip()[:60])
extra = ["a heart", "a star", "a cat", "a dog", "a bird", "a fish", "a horse", "a lion", "a tiger", "a bear",
         "a unicorn", "a dinosaur", "a skull", "a lightning bolt", "a check mark swoosh", "a letter",
         "two interlocking letters C", "a lips and tongue logo", "a chevron logo", "a gas pump",
         "a person wearing headphones", "a running shoe", "a person running", "a tree", "an apple",
         "a crown", "an anchor", "a rocket", "a car", "a bicycle", "a coffee cup", "a flower", "a leaf",
         "a peace sign", "a smiley face", "a sad face", "a circle", "a triangle", "a hand", "a guitar",
         "a company logo", "a word"]
VOCAB = sorted(voc | set(extra))
dev = "cuda"
m, _, pp = open_clip.create_model_and_transforms("ViT-L-14", pretrained="openai", device=dev); m.eval()
tok = open_clip.get_tokenizer("ViT-L-14")
w0, h0 = ink.shape[1], ink.shape[0]; s0 = max(w0, h0)
cv = Image.new("RGB", (s0, s0), "white"); cv.paste(Image.open(out).convert("RGB"), ((s0 - w0) // 2, (s0 - h0) // 2))
with torch.no_grad():
    te = []
    for i in range(0, len(VOCAB), 256):
        e = m.encode_text(tok([f"a line drawing of {v}" for v in VOCAB[i:i + 256]]).to(dev)).float()
        te.append(e / e.norm(dim=-1, keepdim=True))
    te = torch.cat(te)
    ie = m.encode_image(pp(cv.resize((224, 224))).unsqueeze(0).to(dev)).float(); ie = ie / ie.norm(dim=-1, keepdim=True)
    lg = (ie @ te.T)[0]
top = lg.topk(5)
print("top:", " | ".join(VOCAB[i] for i in top.indices.tolist()))
print(f"SUBJECT={VOCAB[top.indices[0].item()]}")
