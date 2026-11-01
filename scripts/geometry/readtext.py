"""Read the main words of a logo, offline and free (RapidOCR).

Oct 30 test: Nike -> "JUSTDOIT", Chanel -> "CHANEL" (+ a 0.65 "F" from the CC
mark), PaceCasso -> "PACECASSO" + "DESIGN RUN REPEAT", and nothing on the gas
pump, Strava or the cat. Windows' own OCR read Nike as "NSTDOIT".

read_words(path) -> (words, boxes): the main text line(s) as one string with
word breaks, and their boxes (x0, y0, x1, y1 in image pixels) so the caller
can lift the logo's own lettering out before redrawing it as block letters.
"""
import re
import unicodedata
import numpy as np
from PIL import Image
from scipy import ndimage as nd
from skimage.morphology import disk

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
    objs = [s for s in nd.find_objects(lab) if s is not None]
    if not objs: return text
    tall = max(s[0].stop - s[0].start for s in objs)
    # every clump of the letters' height or near it, not specks
    spans = sorted((s[1].start, s[1].stop) for s in objs if s[0].stop - s[0].start > 0.4 * tall)
    words = []
    # a word break is a gap of a quarter of the letter height or more; letter
    # gaps are smaller (halotel's separate lower-case letters, 7-10 px gaps at
    # 140 px tall, were split by width as "HALO TEL", Oct 31)
    for a, b in spans:
        if words and a < words[-1][1] + 0.25 * tall: words[-1][1] = max(words[-1][1], b)
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


ARCH = 0.3        # letter centres spread over this x letter height: the line is curved


def _flat_read(a, box, ink, bg):
    """read a curved line (an arched name) again with its letters slid onto a
    straight line: NEW HOLLAND's arch read as "NEWWLAND" (0.68), straightened
    as "NEW HOLLAND" (0.998), Nov 1. -> (text, score) or None"""
    x0, y0, x1, y1 = box
    lab, n = nd.label(ink[y0:y1, x0:x1], structure=np.ones((3, 3)))
    objs = [o for o in nd.find_objects(lab) if o is not None]
    if not objs: return None
    top = max(o[0].stop - o[0].start for o in objs)
    big = [o for o in objs if o[0].stop - o[0].start > 0.4 * top]
    if len(big) < 4: return None
    cx = np.array([(o[1].start + o[1].stop) / 2 for o in big])
    cy = np.array([(o[0].start + o[0].stop) / 2 for o in big])
    h = np.median([o[0].stop - o[0].start for o in big])
    if cy.max() - cy.min() < ARCH * h: return None
    xs = np.arange(x1 - x0)
    shift = np.polyval(np.polyfit(cx, cy, 2), xs)
    shift -= shift.mean()
    crop = a[y0:y1, x0:x1]
    pad = int(np.abs(shift).max()) + 2
    out = np.empty((crop.shape[0] + 2 * pad, crop.shape[1], 3), np.uint8)
    out[:] = bg
    for x in xs:
        o = pad - int(round(shift[x]))
        out[o:o + crop.shape[0], x] = crop[:, x]
    r = _ocr()(out)
    if not r.txts: return None
    # the read nearest the straightened letters' centre line (the crop can
    # take in a line under the arch too)
    mid = pad + float(np.mean(cy - np.interp(cx, xs, shift)))
    k = min(range(len(r.txts)), key=lambda i: abs(np.asarray(r.boxes[i])[:, 1].mean() - mid))
    return r.txts[k], float(r.scores[k])


def read_words(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    a = np.asarray(im.convert("RGB"))
    r = _ocr()(a, return_word_box=True)
    if not r.txts: return "", []
    gray = a.astype(int)
    border = np.concatenate([gray[0], gray[-1], gray[:, 0], gray[:, -1]])
    vals, counts = np.unique(border // 16, axis=0, return_counts=True)
    bg = vals[counts.argmax()] * 16 + 8
    ink = np.abs(gray - bg).sum(-1) > 90
    lines = []
    wr = getattr(r, "word_results", None) or [None] * len(r.txts)
    for txt, score, quad, wl in zip(r.txts, r.scores, r.boxes, wr):
        q = np.asarray(quad)
        box = (max(0, int(q[:, 0].min())), max(0, int(q[:, 1].min())), int(q[:, 0].max()) + 1, int(q[:, 1].max()) + 1)
        flat = _flat_read(a, box, ink, bg.clip(0, 255).astype(np.uint8))
        if flat and flat[1] > score:
            txt, score = flat
        # accents to plain letters (LABORATÓRIO lost its O when they were deleted)
        plain = unicodedata.normalize("NFKD", txt.upper()).encode("ascii", "ignore").decode()
        clean = re.sub(r"[^A-Z0-9 ]", "", plain).strip()
        # a word needs 3+ characters and a letter: three rings read as "80" (Oct 30)
        if score < MIN_SCORE or len(clean.replace(" ", "")) < 3 or not re.search(r"[A-Z]", clean): continue
        if wl and not flat:
            # the line box can run over a mark beside the words (halotel's
            # line box took in its dot mark, and the lift erased it, Oct 31
            # review); the word boxes start and end at the letters
            wx = np.concatenate([np.asarray(w[2])[:, 0] for w in wl])
            box = (max(box[0], int(wx.min())), box[1], min(box[2], int(wx.max()) + 1), box[3])
        lines.append((clean, box))
    if not lines: return "", []
    tallest = max(b[3] - b[1] for _, b in lines)
    main = sorted([l for l in lines if l[1][3] - l[1][1] >= TAGLINE * tallest], key=lambda l: l[1][1])
    words = " ".join(_spaced(t, b, ink) for t, b in main)
    return re.sub(r" +", " ", words).strip(), [b for _, b in lines]


OUTSIDE = 0.3      # a shape with less area than this x (text height)^2 outside the text boxes is lettering
BACKING = 0.8      # ... unless it covers this x (text height)^2 once its holes are filled
HOLES = 0.2        # ... and its holes are this share of its ink: letters cut out of a badge


def lift(path, boxes, out_path, pad=0.08):
    """the upload with its lettering painted the background colour: every
    shape of ink that lies mostly inside a text box. Painting the whole box
    also erased whatever of the mark it overlapped (Oct 31: the Daraz box
    took the right half of the icon and its play triangle with it)."""
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    a = np.asarray(im.convert("RGB")).copy()
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]]).astype(int)
    vals, counts = np.unique(border // 16, axis=0, return_counts=True)
    bgc = (vals[counts.argmax()] * 16 + 8).clip(0, 255).astype(np.uint8)
    # the ink step's own threshold (plan.ink_parts): a looser one took EMTUSA's
    # gradient background for ink; the erased area is grown to take the edges
    ink = np.abs(a.astype(int) - bgc.astype(int)).sum(-1) > 90
    lab, n = nd.label(ink, structure=np.ones((3, 3)))
    total = np.bincount(lab.ravel(), minlength=n + 1)
    h, w = a.shape[:2]
    inbox = np.zeros((h, w), bool)
    spans = []
    for x0, y0, x1, y1 in boxes:
        p = int(pad * (y1 - y0))
        span = (slice(max(0, y0 - p), min(h, y1 + p)), slice(max(0, x0 - p), min(w, x1 + p)))
        inbox[span] = True
        spans.append(span)
    inside = np.bincount(lab[inbox].ravel(), minlength=n + 1)
    # the mark has real area outside the boxes; tight letters merged into one
    # shape (EMTUSA's E-M-T) only poke a sliver past the padding
    tall = max(y1 - y0 for _, y0, _, y1 in boxes)
    # ... and a letter lies mostly inside its box: a small mark wholly outside
    # also has little area outside (halotel's dot, once the box stopped
    # covering it, Nov 1)
    text = ((total - inside) < OUTSIDE * tall * tall) & (inside > 0.5 * total)
    text[0] = False
    # a backing shape with the words cut out of it is part of the mark, not a
    # letter (Sun FM's orange disc behind "99.9" was erased, Oct 31 review):
    # keep it, with the cut-out letters filled, since the words are redrawn
    backing = np.zeros(n + 1, bool)
    for i, s in enumerate(nd.find_objects(lab), 1):
        if s is None or not text[i]: continue
        m = lab[s] == i
        filled = nd.binary_fill_holes(m)
        holes = filled.sum() - m.sum()
        if filled.sum() > BACKING * tall * tall and holes > HOLES * m.sum():
            text[i] = False; backing[i] = True
            # cut-outs that run off the badge's edge are notches, not holes
            # (Sun FM's "99.9" overhangs its disc): close over them, then fill
            r = max(1, int(0.12 * tall))
            body = nd.binary_fill_holes(nd.binary_closing(np.pad(m, r), disk(r))[r:-r, r:-r])
            sub = a[s]
            sub[body & ~m] = np.median(sub[m], axis=0).astype(np.uint8)
            lab[s][body & ~m] = i
    erase = text[lab]
    # a letter joined to the mark (the spider's thread runs into the O of
    # CROOKED) is still a letter: inside a box, a piece of a bigger shape goes
    # unless the box's left or right side cuts it, as it cuts a mark beside the word
    for span in spans:
        sub = ink[span] & ~erase[span] & ~backing[lab[span]]
        pl, k = nd.label(sub, structure=np.ones((3, 3)))
        sides = set(np.unique(pl[:, 0])) | set(np.unique(pl[:, -1]))
        letters = np.isin(pl, [i for i in range(1, k + 1) if i not in sides])
        erase[span] |= letters
    a[nd.binary_dilation(erase, iterations=2)] = bgc
    Image.fromarray(a).save(out_path)
    return out_path


if __name__ == "__main__":
    import sys
    for f in sys.argv[1:]:
        print(f, "->", repr(read_words(f)[0]))
