"""Read the main words of a logo, offline and free (RapidOCR).

Oct 30 test: Nike -> "JUSTDOIT", Chanel -> "CHANEL" (+ a 0.65 "F" from the CC
mark), PaceCasso -> "PACECASSO" + "DESIGN RUN REPEAT", and nothing on the gas
pump, Strava or the cat. Windows' own OCR read Nike as "NSTDOIT".

read_words(path) -> (words, boxes): the main text line(s) as one string with
word breaks, and their boxes (x0, y0, x1, y1 in image pixels) so the caller
can lift the logo's own lettering out before redrawing it as block letters.
"""
import re
import numpy as np
from PIL import Image
from scipy import ndimage as nd

MIN_SCORE = 0.8
TAGLINE = 0.6      # a line under 60% of the tallest line's height is a tagline: left out
_engine = None


def _ocr():
    global _engine
    if _engine is None:
        from rapidocr import RapidOCR
        _engine = RapidOCR()
    return _engine


def _spaced(text, box, ink):
    """OCR often drops the spaces in tight logo type ("JUSTDOIT"). Each word of
    a heavy font is its own clump of ink, so split the letters across the
    clumps in proportion to their widths."""
    if " " in text or len(text) < 4: return text
    x0, y0, x1, y1 = box
    sub = ink[y0:y1, x0:x1]
    lab, n = nd.label(sub, structure=np.ones((3, 3)))
    spans = sorted((s[1].start, s[1].stop) for s in nd.find_objects(lab)
                   if s is not None and s[0].stop - s[0].start > 0.5 * (y1 - y0))
    words = []
    for a, b in spans:                      # merge overlapping spans
        if words and a <= words[-1][1]: words[-1][1] = max(words[-1][1], b)
        else: words.append([a, b])
    if len(words) < 2 or len(words) > len(text) // 2: return text
    # largest-remainder shares (plain rounding read Nike as "JUST DOI T")
    widths = np.array([b - a for a, b in words], float)
    share = widths / widths.sum() * len(text)
    counts = np.floor(share).astype(int)
    for k in np.argsort(-(share - counts))[:len(text) - counts.sum()]:
        counts[k] += 1
    if (counts < 1).any(): return text
    out, i = [], 0
    for c in counts:
        out.append(text[i:i + c]); i += c
    return " ".join(out)


def read_words(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    a = np.asarray(im.convert("RGB"))
    r = _ocr()(a)
    if not r.txts: return "", []
    lines = []
    for txt, score, quad in zip(r.txts, r.scores, r.boxes):
        clean = re.sub(r"[^A-Z0-9 ]", "", txt.upper()).strip()
        if score < MIN_SCORE or len(clean.replace(" ", "")) < 2: continue
        q = np.asarray(quad)
        box = (int(q[:, 0].min()), int(q[:, 1].min()), int(q[:, 0].max()) + 1, int(q[:, 1].max()) + 1)
        lines.append((clean, box))
    if not lines: return "", []
    tallest = max(b[3] - b[1] for _, b in lines)
    main = sorted([l for l in lines if l[1][3] - l[1][1] >= TAGLINE * tallest], key=lambda l: l[1][1])
    gray = a.astype(int)
    border = np.concatenate([gray[0], gray[-1], gray[:, 0], gray[:, -1]])
    vals, counts = np.unique(border // 16, axis=0, return_counts=True)
    ink = np.abs(gray - (vals[counts.argmax()] * 16 + 8)).sum(-1) > 90
    words = " ".join(_spaced(t, b, ink) for t, b in main)
    return re.sub(r" +", " ", words).strip(), [b for _, b in lines]


def lift(path, boxes, out_path, pad=0.08):
    """the upload with every text box painted the background colour"""
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    a = np.asarray(im.convert("RGB")).copy()
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]]).astype(int)
    vals, counts = np.unique(border // 16, axis=0, return_counts=True)
    bgc = (vals[counts.argmax()] * 16 + 8).clip(0, 255).astype(np.uint8)
    h, w = a.shape[:2]
    for x0, y0, x1, y1 in boxes:
        p = int(pad * (y1 - y0))
        a[max(0, y0 - p):min(h, y1 + p), max(0, x0 - p):min(w, x1 + p)] = bgc
    Image.fromarray(a).save(out_path)
    return out_path


if __name__ == "__main__":
    import sys
    for f in sys.argv[1:]:
        print(f, "->", repr(read_words(f)[0]))
