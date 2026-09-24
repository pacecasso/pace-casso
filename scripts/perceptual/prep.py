"""upload -> black ink on white: pixels that differ from the dominant border colour."""
import sys, numpy as np
from PIL import Image
im = Image.open(sys.argv[1])
if im.mode in ("RGBA", "LA", "P"):
    im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); im = Image.alpha_composite(bg, im)
a = np.asarray(im.convert("RGB")).astype(int)
border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
vals, counts = np.unique(border // 16, axis=0, return_counts=True)
bgc = vals[counts.argmax()] * 16 + 8
d = np.abs(a - bgc).sum(-1)
ink = d > 90
if len(sys.argv) > 3 and sys.argv[3] == "blue":  # gas: logo colour on a yellow disc
    ink = (a[..., 2] > a[..., 0] + 60) & (a[..., 2] > 100)
Image.fromarray(np.where(ink[..., None], [20, 20, 20], [255, 255, 255]).astype(np.uint8)).save(sys.argv[2])
