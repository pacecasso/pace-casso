#!/usr/bin/env bash
# The second lane behind /draw: refit a job's ink + plan so the drawing comes in
# UNDER a distance cap, for the runner who will not do the 35 km "our pick".
# Reuses the job's autoprep + partplan output; writes to <jobdir>/short/.
# The worker (scripts/perceptual/worker.ts) only runs this when the free search
# produced nothing readable under the cap, and only keeps a result that passes
# the same recognition test as the free drafts.
#
#   scripts/perceptual/fit-short.sh <jobdir> <cap_km>
set -e
cd /c/users/ralph/desktop/pace-casso
PY=${PY:-"C:/Users/ralph/pacecasso-gpu-env/Scripts/python"}
DIR="$1"; CAP="$2"; OUT="$DIR/short"
mkdir -p "$OUT"
SUBJECT=$(grep '^SUBJECT=' "$DIR/prep.log" | cut -d= -f2-)
# sizes at or below the implied size, and going over the cap is charged hard:
# this lane exists to come in under the number, the free lane covers the rest
TARGET_KM="$CAP" H_MULTS="0.55,0.7,0.85,1.0,1.15" TARGET_W_OVER=3 TARGET_W_UNDER=0.1 \
TURN_M=${TURN_M:-150} DEV_W=${DEV_W:-0.6} SUBJECT_TEXT="$SUBJECT" \
  "$PY" -u scripts/perceptual/streetfit.py "$DIR/ink.png" "$DIR/plan.json" "$OUT/fit" "${SEATS:-200}" "${ROUNDS:-40}" 2>/dev/null
for i in 0 1 2 3; do
  [ -f "$OUT/fit/seat$i.json" ] && "$PY" -u scripts/perceptual/connect.py "$OUT/fit/seat$i.json" "$OUT/route$i"
done
echo "DONE short $CAP"
