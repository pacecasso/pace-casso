import assert from "node:assert";
import { matchVerifiedBankRun } from "./refusalOfframp";

// Aug 11 re-verification demoted every bank subject except the apple —
// the offramp may only offer routes that currently pass the blind bar.
assert.equal(matchVerifiedBankRun(["an apple with a bite"])?.id, "apple");
assert.equal(matchVerifiedBankRun(["apple.png"])?.id, "apple");

// Demoted subjects must no longer be offered as verified.
assert.equal(matchVerifiedBankRun(["running shoe with laces"]), null);
assert.equal(matchVerifiedBankRun(["a sailboat at sea"]), null);
assert.equal(matchVerifiedBankRun(["my-trophy_v2.png"]), null);
assert.equal(matchVerifiedBankRun(["umbrella.webp"]), null);
assert.equal(matchVerifiedBankRun(["martini glass"], "dc"), null);

// Word-boundary matching still holds: "pineapple" must not match "apple".
assert.equal(matchVerifiedBankRun(["a monkey drawing"]), null);
assert.equal(matchVerifiedBankRun(["pineapple"]), null);

// No text, no match.
assert.equal(matchVerifiedBankRun([]), null);
assert.equal(matchVerifiedBankRun([null, undefined, ""]), null);

console.log("refusalOfframp tests ok");
