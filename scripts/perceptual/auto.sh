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
# Size: the seat search samples a half-size from H_CHOICES (metres) and charges KM_W per km.
# Oct 12 re-fit (size-oct12.png): the old menu 2500..9000 never tried anything under 5 km wide,
# so every draft came back 30-80 km. 1000..3200 with KM_W 0.02 halved cat/heart with no loss.
H_CHOICES=${H_CHOICES:-"1000,1400,1800,2400,3200"} \
TURN_M=${TURN_M:-150} DEV_W=${DEV_W:-0.6} KM_W=${KM_W:-0.02} SUBJECT_TEXT="$SUBJECT" \
  "$PY" -u scripts/perceptual/streetfit.py "$OUT/ink.png" "$OUT/plan.json" "$OUT/fit" "${SEATS:-200}" "${ROUNDS:-40}" 2>/dev/null
# all four finalists are connected; the worker (scripts/perceptual/worker.ts) picks up to three
# by the fit's own score, so a dropped scribble is replaced by seat3 instead of leaving a gap
for i in 0 1 2 3; do
  [ -f "$OUT/fit/seat$i.json" ] && "$PY" -u scripts/perceptual/connect.py "$OUT/fit/seat$i.json" "$OUT/route$i"
done
"$PY" -u scripts/perceptual/verify_legs.py "$OUT"/route*.gpx || true
echo "DONE $NAME"
