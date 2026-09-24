#!/usr/bin/env bash
# Run street fits a few at a time. Seven at once exhausted RAM (each process
# holds its own copy of the 500k-node graph, ~1.8 GB).
cd /c/users/ralph/desktop/pace-casso
PY="C:/Users/ralph/AppData/Local/Temp/claude/C--users-ralph-desktop-pace-casso/41e29e12-b2f8-4b1d-af8d-e9b84620287a/scratchpad/clipenv/Scripts/python"
SEATS=${SEATS:-200}
ROUNDS=${ROUNDS:-40}
LANES=${LANES:-3}

fit() {  # name  target_png  subject_text
  TURN_M=150 DEV_W=0.6 KM_W=0.004 SUBJECT_TEXT="$3" \
    "$PY" -u scripts/perceptual/streetfit.py "tmp-perceptual/$2.png" \
      "tmp-perceptual/bp_$1.json" "tmp-perceptual/final-$1" "$SEATS" "$ROUNDS" \
      > "tmp-perceptual/final-$1.log" 2>&1
}

jobs_running() { jobs -rp | wc -l; }

while IFS='|' read -r name target subject; do
  [ -z "$name" ] && continue
  while [ "$(jobs_running)" -ge "$LANES" ]; do sleep 15; done
  echo "start $name"
  fit "$name" "$target" "$subject" &
done <<'LIST'
catpic|ink_catpic|a cat seen from behind with pointed ears and a curled tail
Red-simple-heart-symbol-only|ink_Red-simple-heart-symbol-only|a heart
strava|ink_strava|the Strava logo of two chevrons
chanel-cc|ink_chanel-cc|the Chanel logo of two interlocking C letters
gas|gas_ink|a gas pump and a man wearing headphones
stones|ink_stones|the Rolling Stones tongue and lips logo
pacelogo|ink_pacelogo|an oval badge with a running figure
LIST
wait
echo ALL-DONE
grep -h "FINAL" tmp-perceptual/final-*.log
