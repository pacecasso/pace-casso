"""Typed words -> BLOCK LETTERS, laid into the picture's ink mask under the mark.

A logo's own lettering is too tight for streets: in Nike's JUST DO IT the
letters touch, so their outlines merge into a row of boxes (Oct 30). Real GPS
wordmarks set each letter on whole blocks with a block of air between letters.
The words come from the person (they type them on /draw); reading them off
the picture with Windows' OCR got "NSTDOIT" and "mST DO IT".

Letters use the 5x7 block font from scripts/perceptual/blockletters.py (the
Sep 23 / July Nike routes). One font pixel = one CELL; letters are one cell
apart and lines two cells apart, so at a size where a cell spans a block or
more, every stroke and every gap lands on its own street.
"""
import numpy as np
from scipy import ndimage as nd
from skimage import morphology

FONT = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "11110", "10001", "10001", "10001", "11110"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    # D and O must differ by more than a block: on streets a 1-cell corner
    # cut squares off, so O is a plain box and D is cut 2 cells deep (Oct 30)
    "D": ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
    "E": ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
    "F": ["11111", "10000", "11110", "10000", "10000", "10000", "10000"],
    "G": ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
    "H": ["10001", "10001", "11111", "10001", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    "K": ["10001", "10010", "11100", "10010", "10010", "10001", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
    "P": ["11110", "10001", "11110", "10000", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10011", "01111"],
    "R": ["11110", "10001", "11110", "10010", "10010", "10001", "10001"],
    "S": ["01111", "10000", "01110", "00001", "00001", "10001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    "0": ["01110", "10011", "10101", "10101", "10101", "11001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
    "3": ["11110", "00001", "01110", "00001", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["01110", "10000", "11110", "10001", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "01110", "10001", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
    " ": ["00000"] * 7,
}

MAX_PER_LINE = 5


def lines_of(words):
    """greedy line breaks, at most MAX_PER_LINE characters a line"""
    lines, cur = [], ""
    split = []
    for w in words.upper().split():
        # one long word (PACECASSO) would be a 50-cell row: stack it in two halves
        if len(w) > MAX_PER_LINE + 1:
            h = (len(w) + 1) // 2
            split += [w[:h], w[h:]]
        else:
            split.append(w)
    for w in split:
        t = (cur + " " + w).strip()
        if len(t) <= MAX_PER_LINE or not cur:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines


def render(words):
    """cell grid (bool, rows x cols) of the typed words, lines centred"""
    lines = lines_of(words)
    if not lines: return np.zeros((0, 0), bool)
    width = max(len(l) for l in lines) * 6 - 1
    g = np.zeros((len(lines) * 9 - 2, width), bool)
    for li, line in enumerate(lines):
        x = (width - (len(line) * 6 - 1)) // 2
        for ch in line:
            for r, row in enumerate(FONT.get(ch, FONT[" "])):
                for c, v in enumerate(row):
                    if v == "1": g[li * 9 + r, x + c] = True
            x += 6
    return g


def compose(mask, words, gap_cells=2):
    """mask (HI x HI, the picture with its own lettering removed) + typed words
    -> (new HI x HI mask, words-only mask, cell size in px). The mark keeps its
    shape; the words sit under it, as wide as the mark (at least), and the whole
    lockup is re-centred on a square canvas."""
    HI = mask.shape[0]
    g = render(words)
    if g.size == 0: return mask, np.zeros_like(mask), 0.0
    ys, xs = np.nonzero(mask)
    has_mark = len(ys) > 0
    if has_mark:
        mark = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        mh, mw = mark.shape
    else:
        mark = np.zeros((0, 0), bool); mh = mw = 0
    rows, cols = g.shape
    # a cell is at least 1/29 of the mark's width: a long word (CHANEL, 35 cells)
    # squeezed to the mark's width came out too small to read on streets (Oct 30)
    cell = max(mw / cols, mw / 29, 3.0) if has_mark else 1.0
    th, tw = int(round(rows * cell)), int(round(cols * cell))
    gap = int(round(gap_cells * cell)) if has_mark else 0
    H0, W0 = mh + gap + th, max(mw, tw)
    side = int(max(H0, W0) * 1.04) + 2
    canvas = np.zeros((side, side), bool); words_m = np.zeros((side, side), bool)
    oy = (side - H0) // 2
    if has_mark:
        ox = (side - mw) // 2
        canvas[oy:oy + mh, ox:ox + mw] = mark
    ox = (side - tw) // 2
    yy = (np.arange(th) / cell).astype(int).clip(0, rows - 1)
    xx = (np.arange(tw) / cell).astype(int).clip(0, cols - 1)
    block = g[np.ix_(yy, xx)]
    words_m[oy + mh + gap:oy + mh + gap + th, ox:ox + tw] = block
    canvas |= words_m
    # back to HI x HI
    k = HI / side
    idx = (np.arange(HI) / k).astype(int).clip(0, side - 1)
    out = canvas[np.ix_(idx, idx)]
    wout = words_m[np.ix_(idx, idx)]
    return out, wout, cell * k
