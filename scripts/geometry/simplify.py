"""Upload -> simple bold line art (Oct 31): the step between the picture and
the final draw. The old site's flow: line art first, the user tidies it, then
it is plotted as one etch-a-sketch line. What can be drawn is set by the city,
not the picture: a 20-30 km route is ~25 blocks across, so anything under a
block or two is noise on the map.

  * solid parts become the edges of their colour regions, smoothed to a block
    (a flower's petals, ring and eye are three shapes to a human eye even
    though they are one blob of ink); regions under ~2 blocks are absorbed by
    their neighbour, and an edge shared by two colours is drawn once
  * thin parts (pen lines, strokes of a mark) become ONE centre line, double
    lines a block apart merged, spurs and wiggles cut
  * words are read (readtext.py), lifted out and set back under the mark as
    single-line block letters, one font pixel per block
  * a length budget keeps the biggest pieces: an etch-a-sketch with a dozen
    lines reads, one with forty is a scribble

line_art(path) -> (strokes, letters, words); strokes are N x 2 arrays of
(row, col) on the HI x HI canvas, letters the block-letter strokes among
them. render(strokes, letters) -> the picture the user touches up and the
engine draws: thin lines on white (the engine traces their centres, with no
readability floor that could push it past 65 km), the mark in black and the
letters in LETTER_RGB, so the engine can still find the letters after the
touch-up and square them up with the street grid as it did for Nike."""
import os, tempfile
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd
from skimage import measure, morphology
import plan as P
import blocktext as B

HI = P.HI
CELLS = 24          # street blocks across the drawing
MAX_LEN = 14.0      # total line length budget, in canvas widths
MAX_STROKES = 40
LETTER_RGB = (20, 70, 200)
THICK = float(os.environ.get("SIMP_THICK", "1.0"))   # half-width (blocks) above which a part is drawn as its outline
SMOOTH = float(os.environ.get("SIMP_SMOOTH", "0.3"))  # colour-region smoothing, blocks
REGION = float(os.environ.get("SIMP_REGION", "3.0"))  # colour regions under this many square blocks are absorbed
CLOSE = float(os.environ.get("SIMP_CLOSE", "0.2"))  # gaps under twice this many blocks are closed
REACH = float(os.environ.get("SIMP_REACH", "1.5"))     # thin ink within this many blocks of a solid part is part of its outline
MARK_LEN = float(os.environ.get("SIMP_MARK_LEN", "9.0"))  # mark budget (canvas widths) when words are added too


def _crop(m, pad):
    return m[pad:-pad, pad:-pad]


def _paths(sk, min_len, tol):
    return [measure.approximate_polygon(p, tol) for p in P._skeleton_paths(sk, max(2, int(min_len)))]


def _prune(sk, spur):
    """cut skeleton branches shorter than spur px that end in a tip, then let
    the surviving lines' ends grow back (erosion shortened them too)"""
    keep = sk.copy()
    for _ in range(int(spur)):
        nb = nd.convolve(keep.astype(int), np.ones((3, 3), int), mode="constant") - 1
        tips = keep & (nb <= 1)
        if not tips.any(): break
        keep &= ~tips
    for _ in range(int(spur)):
        grow = sk & ~keep & nd.binary_dilation(keep, np.ones((3, 3)))
        nb = nd.convolve(keep.astype(int), np.ones((3, 3), int), mode="constant") - 1
        # only grow from line ends, so pruned side branches stay pruned
        ends = keep & (nb <= 1)
        grow &= nd.binary_dilation(ends, np.ones((3, 3)))
        if not grow.any(): break
        keep |= grow
    return keep


def simplify(mask, parts=None, cells=CELLS, max_len=MAX_LEN):
    if not mask.any(): return []
    c = HI / cells
    tol = 0.3 * c
    pad = int(2 * c)
    m = _crop(nd.binary_closing(np.pad(mask, pad), morphology.disk(max(1, int(CLOSE * c)))), pad)
    # thick = what survives opening with a disk a block wide
    thick = nd.binary_opening(m, morphology.disk(max(1, int(THICK * c))))
    thick = morphology.remove_small_objects(thick, max_size=int(1.5 * c * c))
    if REACH > 0 and thick.any():
        # the opening also cut every neck and point under two blocks wide (the
        # Daraz icon's triangle opened into a notch, the crow lost its feathers,
        # the spider its legs): give back the ink within REACH blocks of the
        # solid parts; longer thin lines (a web's threads) stay centre lines
        thick = m & nd.binary_dilation(thick, morphology.disk(max(1, int(REACH * c))))
    strokes = []
    if thick.any():
        if parts is None or parts.max() <= 1:
            lab = thick.astype(np.int32)
        else:
            # colour labels on every thick pixel (closing filled some with 0)
            idx = nd.distance_transform_edt(parts == 0, return_distances=False, return_indices=True)
            lab = np.where(thick, parts[idx[0], idx[1]], 0).astype(np.int32)
        K = int(lab.max())
        lp = np.pad(lab, pad)
        sm = np.stack([nd.gaussian_filter((lp == k).astype(float), SMOOTH * c) for k in range(K + 1)])
        lab2 = sm.argmax(0)
        # regions under ~2 blocks: absorbed by whatever surrounds them
        for _ in range(2):
            small = np.zeros(lab2.shape, bool)
            for k in range(K + 1):
                rl, n = nd.label(lab2 == k)
                if n == 0: continue
                area = np.bincount(rl.ravel())
                tiny = area < REGION * c * c; tiny[0] = False
                small |= tiny[rl]
            if not small.any(): break
            idx = nd.distance_transform_edt(small, return_distances=False, return_indices=True)
            lab2 = lab2[idx[0], idx[1]]
        edge = np.zeros(lab2.shape, bool)
        edge[:, :-1] |= lab2[:, :-1] != lab2[:, 1:]
        edge[:-1, :] |= lab2[:-1, :] != lab2[1:, :]
        sk = _crop(morphology.skeletonize(nd.binary_dilation(edge)), pad)
        strokes += _paths(sk, 1.5 * c, tol)
    thin = m & ~nd.binary_dilation(thick, morphology.disk(max(1, int(0.5 * c))))
    thin = morphology.remove_small_objects(thin, max_size=int(0.5 * c * c))
    if thin.any():
        # double lines under a block apart become one
        thin = _crop(nd.binary_closing(np.pad(thin, pad), morphology.disk(max(1, int(0.5 * c)))), pad)
        sk = _prune(morphology.skeletonize(thin), c)
        strokes += _paths(sk, 1.5 * c, tol)
    # budget: longest first (the main outline outranks any detail)
    def length(s): return float(np.hypot(*np.diff(s, axis=0).T).sum())
    strokes.sort(key=lambda s: -length(s))
    kept, total = [], 0.0
    for s in strokes:
        L = length(s)
        if len(kept) >= MAX_STROKES or (kept and total + L > max_len * HI): break
        kept.append(s); total += L
    return kept


GAP = float(os.environ.get("SIMP_GAP", "0.6"))        # bold(): gaps under twice this many blocks belong to the body
COLLAPSED = 0.75    # a drawing that covers less than this share of the mark's edges has lost the picture
BETTER = 0.15       # ... and the bold drawing takes its place when it covers this much more
SAME = 0.92         # two drawings whose lines lie on each other this much are one drawing


def _length(s):
    return float(np.hypot(*np.diff(s, axis=0).T).sum())


def bold(mask, cells=CELLS, max_len=MAX_LEN):
    """the mark as ONE bold shape: its outline with the narrow gaps closed, and
    the gaps themselves as the lines inside it. simplify() reads a mark made of
    tightly packed pieces as thin ink and merges it into a blob with a single
    line through it (Nov 11 review: the Three Weavers knot, 25 woven tiles a
    block or two wide, came out as two stray lines). A person draws that knot
    as an oval with the weave's white channels as lines across it."""
    if not mask.any(): return []
    c = HI / cells
    tol = 0.3 * c
    pad = int(2 * c)
    body = _crop(nd.binary_closing(np.pad(mask, pad), morphology.disk(max(1, int(GAP * c)))), pad)
    body = morphology.remove_small_objects(body, max_size=int(c * c))
    if not body.any(): return []
    # holes under ~2 square blocks are part of the body; bigger ones (a ring's) stay
    hl, n = nd.label(nd.binary_fill_holes(body) & ~body)
    if n:
        small = np.bincount(hl.ravel()) < 2.0 * c * c; small[0] = False
        body |= small[hl]
    sm = nd.gaussian_filter(np.pad(body, pad).astype(float), SMOOTH * c) > 0.5
    edge = sm & ~nd.binary_erosion(sm)
    outline = _paths(_crop(morphology.skeletonize(nd.binary_dilation(edge)), pad), 1.5 * c, tol)
    # the gaps well inside the body, as centre lines
    gaps = body & ~mask & nd.binary_erosion(body, morphology.disk(max(1, int(0.5 * c))))
    gaps = morphology.remove_small_objects(gaps, max_size=int(0.3 * c * c))
    inner = _paths(_prune(morphology.skeletonize(gaps), c), 2.0 * c, tol) if gaps.any() else []
    # the outline first, then the inner lines, longest first, within the budget
    kept, total = [], 0.0
    for s in sorted(outline, key=lambda s: -_length(s)) + sorted(inner, key=lambda s: -_length(s)):
        L = _length(s)
        if len(kept) >= MAX_STROKES or (kept and total + L > max_len * HI): continue
        kept.append(s); total += L
    return kept


def _raster(strokes):
    im = Image.new("L", (HI, HI), 0)
    d = ImageDraw.Draw(im)
    for s in strokes:
        if len(s) >= 2: d.line([(float(x), float(y)) for y, x in s], fill=255, width=2)
    return np.asarray(im) > 0


def cover(mask, strokes, cells=CELLS):
    """the share of the mark's edges with a drawn line within a block: 0.9+
    for a drawing that follows the picture, 0.17 for the knot's stray lines"""
    if not mask.any(): return 1.0
    if not strokes: return 0.0
    edge = mask & ~nd.binary_erosion(mask)
    near = nd.binary_dilation(_raster(strokes), morphology.disk(int(HI / cells)))
    return float((edge & near).sum() / max(edge.sum(), 1))


def same(a, b, cells=CELLS):
    """two stroke sets that draw the same picture: each one's lines lie within
    half a block of the other's"""
    if not a or not b: return not a and not b
    ra, rb = _raster(a), _raster(b)
    d = morphology.disk(max(1, int(0.5 * HI / cells)))
    return min((ra & nd.binary_dilation(rb, d)).sum() / max(ra.sum(), 1),
               (rb & nd.binary_dilation(ra, d)).sum() / max(rb.sum(), 1)) >= SAME


def mark_options(mask, parts, max_len):
    """the drawings of one mark to offer, the one to show first at the front:
    the detailed drawing (simplify) and, when it differs, the bold one. The
    detailed drawing leads unless it has lost the picture and the bold one has
    not (Nov 11: the customer was shown the knot's two stray lines with no
    other choice and no warning)."""
    detail = simplify(mask, parts, max_len=max_len)
    strong = bold(mask, max_len=max_len)
    if not strong or same(detail, strong): return [detail]
    if not detail: return [strong]
    cd, cb = cover(mask, detail), cover(mask, strong)
    print(f"cover: detail {cd:.2f}, bold {cb:.2f}")
    return [strong, detail] if cd < COLLAPSED and cb >= cd + BETTER else [detail, strong]


def _letters(g, cell, oy, ox):
    """single-line block letters: the skeleton of each glyph's font pixels"""
    up = 8
    big = np.kron(g, np.ones((up, up), bool))
    sk = morphology.skeletonize(np.pad(big, up))
    out = []
    for p in _all_paths(sk):
        p = (p - up) / up * cell + np.array([oy, ox]) + cell / 2 - cell / up / 2
        out.append(measure.approximate_polygon(p, 0.3 * cell))
    return out


def _all_paths(sk):
    """skeleton -> polylines on any canvas size (plan._skeleton_paths assumes HI)"""
    H, W = sk.shape
    seen = np.zeros_like(sk)
    nb = nd.convolve(sk.astype(int), np.ones((3, 3), int), mode="constant") - 1
    out = []
    starts = list(zip(*np.nonzero(sk & (nb == 1)))) + list(zip(*np.nonzero(sk)))
    for y, x in starts:
        if seen[y, x]: continue
        path = [(y, x)]; seen[y, x] = True
        while True:
            nxt = None
            for dy, dx in ((0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and sk[yy, xx] and not seen[yy, xx]:
                    nxt = (yy, xx); break
            if not nxt: break
            y, x = nxt; seen[y, x] = True; path.append(nxt)
        if len(path) >= 2: out.append(np.array(path, float))
    return out


ROW_CHARS = 12      # the name is set on ONE row, at most this many characters


def street_words(words):
    """the words that go on the map: whole words from the start, on one row.
    A second row is joined to the first by walks that cut through the letters
    (Oct 31: AKWEST/STUDIO and SOUT/HERN scrambled; one-row BIKKEL read)."""
    out = ""
    for w in words.upper().split():
        t = (out + " " + w).strip()
        if len(t) > ROW_CHARS: break
        out = t
    return out or words.upper().split()[0][:ROW_CHARS]


def row_grid(text):
    """cell grid (bool, 7 x cols) of the text on one row"""
    g = np.zeros((7, max(1, len(text) * 6 - 1)), bool)
    for i, ch in enumerate(text):
        for r, row in enumerate(B.FONT.get(ch, B.FONT[" "])):
            for c, v in enumerate(row):
                if v == "1": g[r, i * 6 + c] = True
    return g


def lay_out(mark_strokes, words, gap_cells=2):
    """mark strokes (HI canvas) + typed words -> one canvas, words as block
    letters under the mark, at least 1/29 of the mark wide a cell (as
    blocktext.compose), everything re-centred and scaled back to HI"""
    g = row_grid(street_words(words))
    if g.size == 0: return mark_strokes
    rows, cols = g.shape
    if mark_strokes:
        allp = np.concatenate(mark_strokes)
        y0, x0 = allp.min(0); y1, x1 = allp.max(0)
        mh, mw = y1 - y0, x1 - x0
    else:
        y0 = x0 = 0.0; mh = mw = 0.0
    cell = max(mw / cols, mw / 29, 3.0) if mark_strokes else HI / max(rows, cols)
    th, tw = rows * cell, cols * cell
    gap = gap_cells * cell if mark_strokes else 0.0
    H0, W0 = mh + gap + th, max(mw, tw)
    side = max(H0, W0) * 1.04 + 2
    oy = (side - H0) / 2
    out = [s - np.array([y0, x0]) + np.array([oy, (side - mw) / 2]) for s in mark_strokes]
    letters = _letters(g, cell, oy + mh + gap, (side - tw) / 2)
    k = HI / side
    return [s * k for s in out], [s * k for s in letters]


PHOTO_BORDER = 0.75   # a photo's border is mostly NOT one colour (logos on paper: 0.86+)
PHOTO_COLOURS = 0.95  # ... and its top 16 colours cover less than this (flat logos: 0.95+)
SUBJECT_MIN = 0.05    # a subject the photo model finds must cover this much of the picture
TONES = int(os.environ.get("SIMP_TONES", "3"))  # brightness bands inside a photo's subject
_seg = None


def _rgb(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); im = Image.alpha_composite(bg, im)
    return im.convert("RGB")


def is_photo(path):
    """a photo, not a logo: its border is busy and its colours are spread out
    (Oct 31: the Eurasier dog photo was traced from the background shapes,
    since the logo rules take the commonest border colour as the paper)"""
    a = np.asarray(_rgb(path)).astype(int)
    b = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    v, n = np.unique(b // 16, axis=0, return_counts=True)
    border = (np.abs(b - (v[n.argmax()] * 16 + 8)).sum(-1) < 60).mean()
    small = _rgb(path); small.thumbnail((300, 300))
    q = np.asarray(small).reshape(-1, 3) // 32
    _, c = np.unique(q, axis=0, return_counts=True)
    colours = np.sort(c)[::-1][:16].sum() / len(q)
    return border < PHOTO_BORDER and colours < PHOTO_COLOURS


def photo_subject(path):
    """the main subject of a photo (DeepLabV3, torchvision, local and free:
    people, animals, vehicles...) as a mask on the HI canvas, cropped and
    centred as plan.ink_parts does; None when it finds nothing big enough"""
    global _seg
    import torch
    from torchvision.models.segmentation import deeplabv3_resnet101, DeepLabV3_ResNet101_Weights
    w = DeepLabV3_ResNet101_Weights.DEFAULT
    if _seg is None: _seg = deeplabv3_resnet101(weights=w).eval()
    im = _rgb(path); im.thumbnail((520, 520))
    with torch.no_grad():
        lab = _seg(w.transforms()(im).unsqueeze(0))["out"][0].argmax(0).numpy()
    ids, n = np.unique(lab[lab > 0], return_counts=True)
    if not len(ids) or n.max() < SUBJECT_MIN * lab.size: return None
    m = lab == ids[n.argmax()]
    lb, k = nd.label(m)
    m = lb == np.bincount(lb.ravel())[1:].argmax() + 1      # its largest piece
    m = nd.binary_fill_holes(m)
    # inside the subject: its main tones as colour parts (a face's dark eyes,
    # nose and mouth against light fur), so simplify draws their edges too
    px = np.asarray(im.convert("L"), float)
    lab = np.zeros(m.shape, np.int32)
    v = px[m]
    edges = np.quantile(v, np.linspace(0, 1, TONES + 1)[1:-1])
    lab[m] = np.digitize(v, edges) + 1
    ys, xs = np.nonzero(m)
    lab = lab[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, wd = lab.shape; s = int(max(h, wd) * 1.04) + 2
    sq = np.zeros((s, s), np.int32); sq[(s - h) // 2:(s - h) // 2 + h, (s - wd) // 2:(s - wd) // 2 + wd] = lab
    mask = np.asarray(Image.fromarray(((sq > 0) * 255).astype(np.uint8)).resize((HI, HI), Image.LANCZOS)) > 127
    parts = np.asarray(Image.fromarray(sq.astype(np.uint8)).resize((HI, HI), Image.NEAREST)).astype(np.int32)
    return mask, np.where(mask, np.maximum(parts, 1), 0)


def line_art(path, words_mode="keep"):
    """the drawing shown first (see line_art_options)"""
    return line_art_options(path, words_mode)[0]


def line_art_options(path, words_mode="keep"):
    """-> [(strokes, letters, words), ...]: one or two drawings of the upload
    for the person to choose from, the one to show first at the front"""
    if is_photo(path):
        try:
            subject = photo_subject(path)
        except Exception as e:      # no model available: the logo rules below
            print(f"photo subject failed: {e}")
            subject = None
        if subject is not None:
            return [(st, [], "") for st in mark_options(*subject, MAX_LEN)]
    words, boxes = "", []
    if words_mode == "keep":
        try:
            import readtext as R
            words, boxes = R.read_words(path)
        except Exception as e:
            print(f"reading text failed: {e}")
    src = path
    if words:
        src = os.path.join(tempfile.mkdtemp(), "lifted.png")
        import readtext as R
        R.lift(path, boxes, src)
    try:
        mask, parts = P.ink_parts(src)
    except ValueError:            # nothing but words
        mask, parts = np.zeros((HI, HI), bool), None
    out = []
    for strokes in mark_options(mask, parts, MARK_LEN if words else MAX_LEN):
        letters = []
        if words:
            strokes, letters = lay_out(strokes, words)
        out.append((strokes, letters, words))
    return out


def render(strokes, letters=(), size=800, width_frac=0.012):
    im = Image.new("RGB", (size, size), "white")
    d = ImageDraw.Draw(im)
    k = size / HI
    w = max(2, int(width_frac * size))
    r = w / 2
    for group, colour in ((strokes, (0, 0, 0)), (letters, LETTER_RGB)):
        for s in group:
            pts = [(float(x) * k, float(y) * k) for y, x in s]
            if len(pts) < 2: continue
            d.line(pts, fill=colour, width=w, joint="curve")
            for x, y in (pts[0], pts[-1]):
                d.ellipse([x - r, y - r, x + r, y + r], fill=colour)
    return im


def masks_of(path):
    """a (touched-up) line art image -> (ink mask, letters mask) on the HI x HI
    canvas, cropped and centred exactly as plan.ink_parts does"""
    a = np.asarray(Image.open(path).convert("RGB")).astype(int)
    ink = (255 * 3 - a.sum(-1)) > 150
    lr = np.array(LETTER_RGB)
    let = ink & (np.abs(a - lr).sum(-1) < 120)
    ink = nd.binary_opening(ink, iterations=1)
    if not ink.any(): raise ValueError("no ink")
    ys, xs = np.nonzero(ink)
    crop = lambda m: m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    out = []
    for m in (crop(ink), crop(let)):
        h, w = m.shape; sd = int(max(h, w) * 1.04) + 2
        sq = np.zeros((sd, sd), np.uint8); sq[(sd - h) // 2:(sd - h) // 2 + h, (sd - w) // 2:(sd - w) // 2 + w] = m * 255
        out.append(np.asarray(Image.fromarray(sq).resize((HI, HI), Image.LANCZOS)) > 127)
    return out[0], out[1] & out[0]


if __name__ == "__main__":
    import sys
    src, out = sys.argv[1], sys.argv[2]
    # <out>: the drawing shown first; <out minus .png>-2.png: the other choice, when there is one
    for i, (st, let, words) in enumerate(line_art_options(src)):
        if i == 0:
            # the whole name as read, for the short version's letters (draw_job.py --words)
            with open(os.path.splitext(out)[0] + ".words.txt", "w", encoding="utf-8") as f: f.write(words or "")
        render(st, let).save(out if i == 0 else f"{os.path.splitext(out)[0]}-{i + 1}.png")
        print(f"drawing {i + 1}: {len(st)} strokes, {len(let)} letter strokes, words {words!r}")
