import assert from "node:assert";
import { normalizeSubjectLabel, subjectLabelsMatchLoose } from "./subjectMatch";

// Same words, different dress.
assert.ok(subjectLabelsMatchLoose("lightning bolt", "Lightning bolt"));
assert.ok(subjectLabelsMatchLoose("a dog", "Dog"));
assert.ok(subjectLabelsMatchLoose("A heart", "heart shape"));
assert.ok(subjectLabelsMatchLoose("Christmas tree", "a tree"));
assert.ok(subjectLabelsMatchLoose("peace sign", "peace symbol"));
assert.ok(subjectLabelsMatchLoose("martini glass", "a cocktail glass"));

// Word-containment (>= 4 chars both sides).
assert.ok(subjectLabelsMatchLoose("sailboat", "a boat"));
assert.ok(subjectLabelsMatchLoose("running shoe", "shoe"));

// Plural / singular.
assert.ok(subjectLabelsMatchLoose("stars", "a star"));

// Must NOT match.
assert.ok(!subjectLabelsMatchLoose("a monkey", "key"));
assert.ok(!subjectLabelsMatchLoose("a dog", "lightning bolt"));
assert.ok(!subjectLabelsMatchLoose("circle", "peace"));
assert.ok(!subjectLabelsMatchLoose("airplane", "cross"));
assert.ok(!subjectLabelsMatchLoose("", "dog"));

// "sign"/"symbol"/"shape" are filler, not evidence of a match.
assert.ok(!subjectLabelsMatchLoose("peace sign", "plus sign"));

// Normalizer basics.
assert.deepEqual(normalizeSubjectLabel("A Lightning-Bolt!"), ["lightning", "bolt"]);
assert.deepEqual(normalizeSubjectLabel("the stars"), ["star"]);

console.log("subjectMatch tests ok");
