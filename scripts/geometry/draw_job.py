"""Drop-in for the /draw worker: one upload -> routes.json in the exact shape
worker.ts posts ({ routes: [{km, points:[[lat,lng],...], label}], note }).

  python draw_job.py <upload> <jobdir> [--text=keep|drop]

Lanes: 'pick' (~20 km), 'short' (~10 km), 'alt' (~35 km). The scale budget can
refuse a lane: if the picture's main parts cannot stay readable at a lane's
length the lane is grown to the smallest readable size, and if that lands
over MAX_KM it is dropped with a note. Nothing calls a paid API or the GPU.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fit as F
import plan as P

MAX_KM = 65.0
LANES = [("pick", 20.0), ("short", 10.0), ("alt", 35.0)]

def main():
    src, out = sys.argv[1], sys.argv[2]
    text_mode = next((a.split("=", 1)[1] for a in sys.argv[3:] if a.startswith("--text=")), "drop")
    os.makedirs(out, exist_ok=True)
    mask, F.PARTS = P.ink_parts(src)
    routes, notes, seen = [], [], set()
    for label, km in LANES:
        res = F.fit_lane(mask, km, text_mode)
        if res is None: continue
        if res["km"] > MAX_KM:
            notes.append(f"No readable version under {MAX_KM:.0f} km."); continue
        if res["plan"].get("bumped_from_H") and label == "short":
            notes.append(f"This picture does not read under {km:.0f} km; the shortest readable version is {res['km']:.1f} km.")
        key = round(res["km"])
        if key in seen: continue          # a bumped lane can duplicate another
        seen.add(key)
        F.save(res, out, label, label)
        routes.append({"km": res["km"], "label": label,
                       "points": [[float(F.C.lat[n]), float(F.C.lng[n])] for n in res["route"]]})
    if P.find_text(mask).any() and text_mode == "drop":
        notes.append("The lettering was left out: text needs roughly 40+ km to read on streets.")
    json.dump({"routes": routes, "note": " ".join(notes) or None}, open(os.path.join(out, "routes.json"), "w"))
    print(f"{len(routes)} routes: " + ", ".join(f"{r['label']} {r['km']} km" for r in routes))

if __name__ == "__main__":
    main()
