"""Export a fitted draft into the site's edit format.

The shipped edit step (app/api/stroke-route, 42-170 ms) takes
{strokes, center, scale, rot} in the same unit space as lib/streetGraphTrace
place(). This writes exactly that, so today's drafts can be edited in the
browser instead of only existing as GPX.

usage: export_to_site.py seat.json plan.json out.json [kind]
"""
import sys, json
R = 224
seat = json.load(open(sys.argv[1]))
plan = json.load(open(sys.argv[2]))
kind = sys.argv[4] if len(sys.argv) > 4 else "outline"
cx, cy, H, rot = seat["placement"]
strokes = []
for s in plan["strokes"]:
    pts = [[(x / R) * 2 - 1, 1 - (y / R) * 2] for x, y in s]
    closed = abs(pts[0][0] - pts[-1][0]) < 1e-9 and abs(pts[0][1] - pts[-1][1]) < 1e-9
    strokes.append({"kind": kind if closed else "thin", "pts": pts, "closed": bool(closed)})
json.dump({"strokes": strokes, "center": seat["center_latlng"], "scale": H, "rot": rot},
          open(sys.argv[3], "w"))
print(f"{len(strokes)} strokes, center {seat['center_latlng']}, scale {H:.0f}, rot {rot:.1f}")
