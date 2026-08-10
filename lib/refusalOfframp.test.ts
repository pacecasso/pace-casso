import assert from "node:assert";
import { matchVerifiedBankRun } from "./refusalOfframp";

// Subject text from the AI redraw matches the bank by feature words.
assert.equal(matchVerifiedBankRun(["running shoe with laces"])?.id, "sneaker");
assert.equal(matchVerifiedBankRun([null, "a sailboat at sea"])?.id, "sailboat");
assert.equal(matchVerifiedBankRun(["heart"])?.id, "heart");

// Filenames normalize: extension and separators stripped.
assert.equal(matchVerifiedBankRun(["my-trophy_v2.png"])?.id, "trophy");
assert.equal(matchVerifiedBankRun(["umbrella.webp"])?.id, "umbrella");

// Word-boundary matching: "monkey" must not match "key".
assert.equal(matchVerifiedBankRun(["a monkey drawing"]), null);

// More feature hits wins over fewer.
assert.equal(
  matchVerifiedBankRun(["key with a bow, shaft and teeth"])?.id,
  "key",
);

// DC subjects only match when asked for DC (martini lives in the DC bank).
assert.equal(matchVerifiedBankRun(["martini glass"]), null);
assert.equal(matchVerifiedBankRun(["martini glass"], "dc")?.id, "martini-dc");

// No text, no match.
assert.equal(matchVerifiedBankRun([]), null);
assert.equal(matchVerifiedBankRun([null, undefined, ""]), null);

console.log("refusalOfframp tests ok");
