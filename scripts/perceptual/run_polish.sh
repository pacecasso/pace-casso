#!/usr/bin/env bash
cd /c/users/ralph/desktop/pace-casso
PY="C:/Users/ralph/AppData/Local/Temp/claude/C--users-ralph-desktop-pace-casso/41e29e12-b2f8-4b1d-af8d-e9b84620287a/scratchpad/clipenv/Scripts/python"
fit() {
  TURN_M=300 DEV_W=0.4 KM_W=0.004 SUBJECT_TEXT="$3" \
    "$PY" -u scripts/perceptual/streetfit.py "tmp-perceptual/$2.png" \
      "tmp-perceptual/bp_$1.json" "tmp-perceptual/polish-$1" 200 70 \
      > "tmp-perceptual/polish-$1.log" 2>&1
}
fit catpic ink_catpic "a cat seen from behind with pointed ears and a curled tail" &
fit Red-simple-heart-symbol-only ink_Red-simple-heart-symbol-only "a heart" &
fit strava ink_strava "the Strava logo of two chevrons" &
wait
echo POLISH-DONE
grep -h FINAL tmp-perceptual/polish-*.log
