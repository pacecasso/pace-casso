"""Typeset a wordmark as BLOCK LETTERS on the city block grid.

Ten letters shrunk across a logo merge into a bar (Ralph, Sep 23: "the JUST DO
IT is completely not readable"). Real GPS wordmarks stack short lines with each
letter several blocks wide and a full block of air between letters. Letters are
emitted as OUTLINES so a route can trace them, and an optional mark (a
blockified logo) sits on top as a lockup.

usage: blockletters.py "JUST DO IT" out.json [cols] [maxperline] [preview.png] [--with=mark.json]
"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw
from skimage import measure

R = 224
FONT = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "11110", "10001", "10001", "10001", "11110"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
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
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
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

text = sys.argv[1].upper()
out = sys.argv[2]
pos = [a for a in sys.argv[3:] if not a.startswith("--")]
COLS = int(pos[0]) if len(pos) > 0 else 28
MAXPL = int(pos[1]) if len(pos) > 1 else 5
PREV = pos[2] if len(pos) > 2 else None
mark = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--with=")), None)
VS = 3      # font rows are VS cells tall
ASPECT = 3  # rows per column in the cell grid (blocks: ~270 m wide, ~80 m tall)

words = text.split()
lines, cur = [], ""
for w in words:
    t = (cur + " " + w).strip()
    if len(t) <= MAXPL:
        cur = t
    else:
        if cur:
            lines.append(cur)
        cur = w
if cur:
    lines.append(cur)

SC = max(1, (COLS - 2) // (max(len(l) for l in lines) * 6))  # cells per font pixel
LW = 5 * SC
GAP = SC

def outlines(mask):
    """rectilinear outlines of a boolean cell mask, in cell coords"""
    res = []
    for cnt in measure.find_contours(np.pad(mask.astype(float), 1), 0.5):
        rc = cnt - 1
        q = [(round(p[1] * 2) / 2, round(p[0] * 2) / 2) for p in rc]
        q = [p for i, p in enumerate(q) if i == 0 or p != q[i - 1]]
        m = [q[0]]
        for i in range(1, len(q) - 1):
            (x0, y0), (x1, y1), (x2, y2) = m[-1], q[i], q[i + 1]
            if (x1 - x0) * (y2 - y1) != (y1 - y0) * (x2 - x1):
                m.append(q[i])
        m.append(q[-1])
        if len(m) > 2:
            res.append(m)
    return res

strokes = []
top = 0.0
if mark:  # lockup: the logo mark above the words
    ms = json.load(open(mark))["strokes"]
    xs = [p[0] for s in ms for p in s]; ys = [p[1] for s in ms for p in s]
    sc = R * 0.60 / max(max(xs) - min(xs), 1e-6)
    strokes += [[[R * 0.2 + (p[0] - min(xs)) * sc, R * 0.03 + (p[1] - min(ys)) * sc] for p in s] for s in ms]
    top = R * 0.03 + (max(ys) - min(ys)) * sc + R * 0.05

# one cell grid holding every line, so letters share one scale
line_h = 7 * SC * VS
lead = 2 * VS
grid_w = max(len(l) for l in lines) * (LW + GAP) - GAP
grid_h = len(lines) * (line_h + lead) - lead
g = np.zeros((grid_h, grid_w), bool)
for li, line in enumerate(lines):
    x = (grid_w - (len(line) * (LW + GAP) - GAP)) // 2
    y0 = li * (line_h + lead)
    for ch in line:
        for r, row in enumerate(FONT.get(ch, FONT[" "])):
            for c, v in enumerate(row):
                if v == "1":
                    g[y0 + r * SC * VS:y0 + (r + 1) * SC * VS, x + c * SC:x + (c + 1) * SC] = True
        x += LW + GAP
scale = (R * 0.92) / grid_w          # x: cell width
sy = scale / ASPECT                  # y: cell height (a block is ~3x shorter)
if top + grid_h * sy > R * 0.97:     # keep the lockup inside the square
    sy = (R * 0.97 - top) / grid_h
    scale = min(scale, sy * ASPECT)
ox = (R - grid_w * scale) / 2
ox = (R - grid_w * scale) / 2
strokes += [[[ox + x * scale, top + y * sy] for x, y in m] for m in outlines(g)]

json.dump({"strokes": strokes}, open(out, "w"))
if PREV:
    im = Image.new("RGB", (R * 2, R * 2), "white")
    d = ImageDraw.Draw(im)
    for st in strokes:
        d.line([(x * 2, y * 2) for x, y in st], fill=(0, 0, 0), width=3)
    im.save(PREV)
print(f"lines {lines}, letter {LW}x{line_h} cells of {COLS}, {len(strokes)} outlines")
