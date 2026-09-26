"""Make a plan one connected drawing: every island gets a stem to the rest.

A GPS artist hangs details off the main line (whiskers as spurs off the
face, legs off the base) so the run never has to travel to them. Our plans
had eyes, chin lines and the like as islands, and the connector tour
reached each one over new streets, which turned the face into boxes
(Sep 26 artist-cat test). This adds the shortest straight stem from each
island to the nearest other ink, spanning-tree style, until everything
touches.

usage: attach.py plan.json plan_attached.json [touch_px]
"""
import sys, json, math

SRC, OUT = sys.argv[1], sys.argv[2]
TOUCH = float(sys.argv[3]) if len(sys.argv) > 3 else 4.0
strokes = json.load(open(SRC))["strokes"]

def seg_near(p, a, b):
    ax, ay = a; bx, by = b; dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L))
    q = (ax + t * dx, ay + t * dy)
    return math.hypot(p[0] - q[0], p[1] - q[1]), q

def near(p, s):
    return min((seg_near(p, a, b) for a, b in zip(s[:-1], s[1:])), key=lambda r: r[0]) if len(s) > 1 else (math.hypot(p[0] - s[0][0], p[1] - s[0][1]), tuple(s[0]))

def gap(s, t):
    """closest approach between two polylines, via their vertices"""
    best = (1e18, None, None)
    for p in s:
        d, q = near(p, t)
        if d < best[0]: best = (d, tuple(p), q)
    for p in t:
        d, q = near(p, s)
        if d < best[0]: best = (d, q, tuple(p))
    return best

n = len(strokes)
comp = list(range(n))
def find(i):
    while comp[i] != i: comp[i] = comp[comp[i]]; i = comp[i]
    return i
pair = {}
for i in range(n):
    for j in range(i + 1, n):
        pair[(i, j)] = gap(strokes[i], strokes[j])
        if pair[(i, j)][0] <= TOUCH: comp[find(i)] = find(j)
stems = []
# Kruskal over the remaining gaps: shortest stems first, only between parts
for (i, j), (d, p, q) in sorted(pair.items(), key=lambda kv: kv[1][0]):
    if find(i) == find(j): continue
    comp[find(i)] = find(j)
    stems.append([list(p), list(q)])
    print(f"stem {d:.0f}px between strokes {i} and {j}")
json.dump({"strokes": strokes + stems}, open(OUT, "w"))
print(f"attach: {n} strokes, {len(stems)} stems added")
