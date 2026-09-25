#!/usr/bin/env bash
# ONE command, upload -> runnable route, no per-logo flags and no hand caption.
# This is the pipeline behind the Sep 23 routes with every hand step removed:
#   autoprep (ink + CLIP's own name) -> blockplan -> streetfit -> connect -> verify_legs
#
#   scripts/perceptual/auto.sh <upload> [outdir]
set -e
cd /c/users/ralph/desktop/pace-casso
PY=${PY:-"C:/Users/ralph/pacecasso-gpu-env/Scripts/python"}
SRC="$1"; NAME=$(basename "${SRC%.*}"); OUT=${2:-tmp-auto/$NAME}
mkdir -p "$OUT"
"$PY" -u scripts/perceptual/autoprep.py "$SRC" "$OUT/ink.png" 2>/dev/null | tee "$OUT/prep.log"
SUBJECT=$(grep '^SUBJECT=' "$OUT/prep.log" | cut -d= -f2-)
if [ "${PLAN:-part}" = part ]; then "$PY" -u scripts/perceptual/partplan.py "$OUT/ink.png" "$OUT/plan.json" --preview="$OUT/plan.png"; else "$PY" -u scripts/perceptual/blockplan.py "$OUT/ink.png" "$OUT/plan.json" --preview="$OUT/plan.png"; fi
TURN_M=150 DEV_W=0.6 KM_W=0.004 SUBJECT_TEXT="$SUBJECT" \
  "$PY" -u scripts/perceptual/streetfit.py "$OUT/ink.png" "$OUT/plan.json" "$OUT/fit" "${SEATS:-200}" "${ROUNDS:-40}" 2>/dev/null
for i in 0 1 2; do
  [ -f "$OUT/fit/seat$i.json" ] && "$PY" -u scripts/perceptual/connect.py "$OUT/fit/seat$i.json" "$OUT/route$i"
done
"$PY" -u scripts/perceptual/verify_legs.py "$OUT"/route*.gpx || true
echo "DONE $NAME"
