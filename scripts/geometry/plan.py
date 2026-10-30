"""Picture -> ink mask -> SIZE-AWARE drawing plan (the scale budget).

The site's partplan.py decides outline-vs-centreline at a fixed 7 px of a
560 px image, whatever size the drawing will be on the map. Here every
decision is made in METRES for the half-size H the drawing will have:

  * a solid part wider than OUTLINE_W_M is drawn as its outline; anything
    thinner is drawn as ONE centreline (two streets 1 block apart do not read
    as a filled bar, they read as a smudge or a double line)
  * outlines/holes/branches smaller than MIN_FEAT_M are dropped (a 150 m
    loop is 2 blocks: it comes out as a random square)
  * text (a row of 3+ similar small glyphs) is found and handled per the
    caller's choice: drop it, or keep it (as centrelines) at whatever size.

Strokes come back in unit coords (-1..1, y up) like streetfit's SKU, with
per-stroke metadata, plus what was dropped and why.
"""
import numpy as np
from PIL import Image
from scipy import ndimage as nd
from skimage import measure, morphology

HI = 560
OUTLINE_W_M = 230.0   # thinner than this -> single centreline
MIN_FEAT_M = 260.0    # smaller than this -> dropped
SIMPLIFY_M = 25.0

def ink_of(path):
    return ink_parts(path)[0]

def ink_parts(path):
    """upload -> ink mask (same rules as autoprep.py's ink step: border colour is
    the background; a solid badge plate under a logo is removed), no CLIP"""
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); im = Image.alpha_composite(bg, im)
    a = np.asarray(im.convert("RGB")).astype(int)
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    vals, counts = np.unique(border // 16, axis=0, return_counts=True)
    bgc = vals[counts.argmax()] * 16 + 8
    ink = np.abs(a - bgc).sum(-1) > 90
    q = a[ink] // 32
    if len(q):
        v2, c2 = np.unique(q, axis=0, return_counts=True)
        plate = v2[c2.argmax()] * 32 + 16
        share = c2.max() / len(q)
        onplate = ink & (np.abs(a - plate).sum(-1) > 120)
        filled = nd.binary_fill_holes(ink)
        solid = ink.sum() / max(filled.sum(), 1)
        rim = nd.binary_dilation(~filled, iterations=3)
        touching = (onplate & rim).sum() / max(onplate.sum(), 1)
        if share > 0.55 and solid > 0.9 and onplate.sum() > 0.08 * ink.sum() and touching < 0.03:
            ink = onplate
    ink = nd.binary_opening(ink, iterations=1)
    # COLOUR PARTS: a two-tone logo (Strava's orange A + peach V) is two shapes
    # to a human eye even where they touch. Each colour holding 12%+ of the ink
    # becomes its own part; pixels go to the nearest part colour.
    lab = np.zeros(ink.shape, np.int32)
    px = a[ink]
    v3, c3 = np.unique(px // 40, axis=0, return_counts=True)
    centres = []
    for k in np.argsort(-c3):
        if c3[k] < 0.12 * len(px): break
        c = v3[k] * 40 + 20
        if all(np.abs(c - q).sum() > 90 for q in centres): centres.append(c)
    if len(centres) >= 2:
        d = np.stack([np.abs(px - c).sum(-1) for c in centres], 1)
        lab[ink] = d.argmin(1) + 1
    else:
        lab[ink] = 1
    # square canvas, ink centred on its bounding box, HI x HI
    ys, xs = np.nonzero(ink)
    lab = lab[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = lab.shape; s = int(max(h, w) * 1.04) + 2
    sq = np.zeros((s, s), np.int32); sq[(s - h) // 2:(s - h) // 2 + h, (s - w) // 2:(s - w) // 2 + w] = lab
    big = np.asarray(Image.fromarray(((sq > 0) * 255).astype(np.uint8)).resize((HI, HI), Image.LANCZOS)) > 127
    big = morphology.remove_small_objects(big, 30)
    parts = np.asarray(Image.fromarray(sq.astype(np.uint8)).resize((HI, HI), Image.NEAREST)).astype(np.int32)
    # fill part labels into anti-aliased edge pixels that NEAREST missed
    if parts.max() > 1:
        idx = nd.distance_transform_edt(parts == 0, return_distances=False, return_indices=True)
        parts = parts[idx[0], idx[1]]
    parts = np.where(big, np.maximum(parts, 1), 0)
    return big, parts

def find_text(mask):
    """components that form a text line: 2+ pieces of near-equal height,
    top- and bottom-aligned, side by side, none the main mass, and the row
    at least 3x as wide as tall (words of a heavy font merge into one piece
    per word, so single letters cannot be required)"""
    lab, n = nd.label(mask, structure=np.ones((3, 3)))
    sl = nd.find_objects(lab)
    areas = nd.sum(mask, lab, range(1, n + 1))
    if n < 2: return np.zeros_like(mask)
    big = max(areas)
    boxes = [(i + 1, s[0].start, s[0].stop, s[1].start, s[1].stop, areas[i]) for i, s in enumerate(sl)]
    cand = [b for b in boxes if b[5] < 0.9 * big and (b[2] - b[1]) > 8]
    text = set()
    for b in cand:
        h = b[2] - b[1]
        row = [c for c in cand if abs((c[2] - c[1]) - h) < 0.15 * h and abs(c[1] - b[1]) < 0.12 * h and abs(c[2] - b[2]) < 0.12 * h]
        if len(row) < 2: continue
        row.sort(key=lambda c: c[3])
        gaps = [row[k + 1][3] - row[k][4] for k in range(len(row) - 1)]
        width = row[-1][4] - row[0][3]
        if max(gaps) < 1.0 * h and width >= 3 * h and h < 0.45 * mask.shape[0]:
            text |= {c[0] for c in row}
    return np.isin(lab, list(text)) if text else np.zeros_like(mask)

def _simplify(pts, tol):
    pts = np.asarray(pts, float)
    return pts if len(pts) < 3 else measure.approximate_polygon(pts, tol)

def _skeleton_paths(mask, min_len_px):
    sk = morphology.skeletonize(mask)
    seen = np.zeros_like(sk)
    nb = nd.convolve(sk.astype(int), np.ones((3, 3), int), mode="constant") - 1
    def walk(y, x):
        path = [(y, x)]; seen[y, x] = True
        while True:
            nxt = None
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if (dy or dx) and 0 <= yy < HI and 0 <= xx < HI and sk[yy, xx] and not seen[yy, xx]:
                        nxt = (yy, xx); break
                if nxt: break
            if not nxt: return path
            y, x = nxt; seen[y, x] = True; path.append(nxt)
    out = []
    for y, x in list(zip(*np.nonzero(sk & (nb == 1)))) + list(zip(*np.nonzero(sk))):
        if seen[y, x]: continue
        p = walk(y, x)
        if len(p) >= min_len_px:
            if len(p) > 8 and abs(p[0][0] - p[-1][0]) <= 2 and abs(p[0][1] - p[-1][1]) <= 2:
                p.append(p[0])            # a ring's centreline closes
            out.append(np.array(p, float))
    return out

def make_plan(mask, H, text_mode="keep", outline_w_m=OUTLINE_W_M, min_feat_m=MIN_FEAT_M, parts=None):
    """mask: HI x HI bool. H: drawing half-size in metres.
    text_mode: 'keep' | 'drop' | 'only'"""
    mpp = 2.0 * H / HI                         # metres per pixel
    text = find_text(mask)
    dropped = []
    if text.any():
        if text_mode == "drop":
            mask = mask & ~text; dropped.append(("text", int(text.sum())))
        elif text_mode == "only":
            mask = mask & text
    # LINE ART (an outline drawing, e.g. a colouring-book cat): the ink IS the
    # line - draw its centre, never the two edges of the pen stroke
    lineart = is_lineart(mask)
    r_px = max(1, min(HI, int(round(outline_w_m / 2 / mpp))))
    if lineart or outline_w_m > 1e6:
        mass = np.zeros_like(mask)
    else:
        mass = nd.binary_opening(mask, morphology.disk(r_px))
        mass = morphology.remove_small_objects(mass, max(10, int((min_feat_m / mpp) ** 2 * 0.3)))
    masses = [mass]
    if parts is not None and parts.max() > 1 and mass.any():
        # one outline per colour part (opened separately so each keeps its own shape)
        masses = []
        for k in range(1, parts.max() + 1):
            mk = nd.binary_opening(mask & (parts == k), morphology.disk(r_px))
            mk = morphology.remove_small_objects(mk, max(10, int((min_feat_m / mpp) ** 2 * 0.3)))
            if mk.any(): masses.append(mk)
        mass = np.any(masses, 0) if masses else mass
    thin = (mask & ~nd.binary_dilation(mass, morphology.disk(max(2, min(r_px, 20))))) if mass.any() else mask.copy()
    thin = morphology.remove_small_objects(thin, 20)
    strokes = []; meta = []
    tol = max(1.0, SIMPLIFY_M / mpp)
    for c in [c for m_ in masses for c in measure.find_contours(np.pad(m_.astype(float), 1), 0.5)]:
        c = _simplify(c - 1, tol)
        if len(c) < 4: continue
        ext = np.hypot(*(c.max(0) - c.min(0))) * mpp
        if ext < min_feat_m:
            dropped.append(("small outline", round(ext))); continue
        strokes.append(c); meta.append("outline")
    for p in _skeleton_paths(thin, max(3, int(0.6 * min_feat_m / mpp))):
        strokes.append(_simplify(p, tol)); meta.append("centreline")
    S = 2.0 / HI
    sku = [np.array([[x * S - 1, 1 - y * S] for y, x in s]) for s in strokes]
    full_len = _ink_length(mask)
    kept_len = sum(float(np.hypot(*np.diff(s, axis=0).T).sum()) for s in strokes) / S
    return {"strokes": sku, "kinds": meta, "dropped": dropped, "lineart": bool(lineart),
            "has_text": bool(text.any()), "kept_frac": min(1.0, kept_len / max(full_len, 1)), "H": H}

def is_lineart(mask):
    """an outline drawing: thin pen strokes (mean width < 3.2% of the canvas)
    that enclose mostly empty paper"""
    sk = morphology.skeletonize(mask)
    width = mask.sum() / max(sk.sum(), 1)
    fill = mask.sum() / max(nd.binary_fill_holes(mask).sum(), 1)
    return bool(width < 0.032 * HI and fill < 0.45)

def stroke_width_px(mask):
    """typical full width (px) of the main solid parts: 2 x distance-to-edge
    sampled on the skeleton, 60th percentile, over components holding 15%+ of the ink"""
    lab, n = nd.label(mask, structure=np.ones((3, 3)))
    if n == 0: return 0.0
    areas = nd.sum(mask, lab, range(1, n + 1))
    main = np.isin(lab, [i + 1 for i, a in enumerate(areas) if a >= 0.15 * mask.sum()])
    dt = nd.distance_transform_edt(main)
    sk = morphology.skeletonize(main)
    v = 2 * dt[sk]
    return float(np.percentile(v, 60)) if len(v) else 0.0

def min_half_size(mask, text_mode="keep", outline_w_m=OUTLINE_W_M):
    """smallest H (m) at which the picture's main solid parts are still wide
    enough to be drawn as outlines. Line art (thin everywhere) has no floor
    from this rule. Below it, a bold logo collapses into a skeleton scribble."""
    if text_mode == "drop":
        mask = mask & ~find_text(mask)
    if is_lineart(mask):
        return 0.0
    w = stroke_width_px(mask)
    if w <= 0: return 0.0
    return outline_w_m * HI / (2 * w)

def _ink_length(mask):
    """reference amount of drawing in px: outline perimeter of solid parts or
    skeleton length of line art (for 'how much of the picture survived')"""
    sk = morphology.skeletonize(mask)
    if is_lineart(mask):
        return float(sk.sum())
    return float(sum(np.hypot(*np.diff(c, axis=0).T).sum() for c in measure.find_contours(np.pad(mask.astype(float), 1), 0.5)))

def unit_length(sku):
    return sum(float(np.hypot(*np.diff(s, axis=0).T).sum()) for s in sku)
