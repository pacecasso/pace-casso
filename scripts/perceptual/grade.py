"""Recognition grade: rank of the true subject among a big subject vocabulary
(corpus subjects + common distractors), under two CLIP models.
rank 0 = the drawing is named correctly first.

usage: grade.py "subject text" img1.png [img2.png ...]
"""
import sys, glob, json, random
import torch, open_clip
from PIL import Image
dev = "cuda"
REPO = r"C:\users\ralph\desktop\pace-casso"
subj = sys.argv[1]
DISTRACT = ["a mitten", "a map of a country", "a blob", "a random scribble", "a maze", "a potato", "a boot", "a key",
            "a person running", "a dog", "a cat", "a heart", "a house", "a bottle", "a letter", "a robot", "a building"]
vocab = set()
for f in glob.glob(REPO + r"\tmp-corpus\stravart\catalog\*.jsonl"):
    for line in open(f, encoding="utf-8"):
        try: s = json.loads(line).get("subject")
        except Exception: continue
        if s: vocab.add(s.split(":")[0].split(";")[0].split("(")[0].strip()[:60])
random.seed(3)
vocab = sorted(vocab); vocab = random.sample(vocab, 300) + DISTRACT
vocab = [v for v in vocab if v.lower() != subj.lower()] + [subj]
def fit(im):
    im = im.convert("RGB"); w, h = im.size; s = max(w, h)
    c = Image.new("RGB", (s, s), "white"); c.paste(im, ((s - w) // 2, (s - h) // 2)); return c
for name, pre in [("ViT-L-14", "openai"), ("ViT-B-16", "laion2b_s34b_b88k")]:
    m, _, pp = open_clip.create_model_and_transforms(name, pretrained=pre, device=dev); m.eval()
    tok = open_clip.get_tokenizer(name)
    with torch.no_grad():
        t = m.encode_text(tok([f"a line drawing of {v}" for v in vocab]).to(dev)).float(); t /= t.norm(dim=-1, keepdim=True)
        for p in sys.argv[2:]:
            e = m.encode_image(pp(fit(Image.open(p)))[None].to(dev)).float(); e /= e.norm(dim=-1, keepdim=True)
            s = (e @ t.T)[0]
            rank = int((s > s[-1]).sum())
            top = [vocab[j] for j in s.argsort(descending=True)[:3].tolist()]
            print(f"{name:9s} rank {rank:3d}/{len(vocab)}  {p[-48:]:48s} top {top}")
