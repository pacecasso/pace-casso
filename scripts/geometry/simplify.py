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
SMOOTH = float(os.environ.get("SIMP_SMOOTH", "0.7"))  # colour-region smoothing, blocks
REGION = float(os.environ.get("SIMP_REGION", "3.0"))  # colour regions under this many square blocks are absorbed
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
    m = _crop(nd.binary_closing(np.pad(mask, pad), morphology.disk(max(1, int(0.4 * c)))), pad)
    # thick = what survives opening with a disk a block wide
    thick = nd.binary_opening(m, morphology.disk(max(1, int(THICK * c))))
    thick = morphology.remove_small_objects(thick, max_size=int(1.5 * c * c))
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


def line_art(path, words_mode="keep"):
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
    strokes = simplify(mask, parts, max_len=MARK_LEN if words else MAX_LEN)
    letters = []
    if words:
        strokes, letters = lay_out(strokes, words)
    return strokes, letters, words


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
    st, let, words = line_art(src)
    render(st, let).save(out)
    print(f"{len(st)} strokes, {len(let)} letter strokes, words {words!r}")
