import assert from "node:assert/strict";
import { reviewStreetDesignSketch } from "./streetDesignSketch";

const streetIcon = reviewStreetDesignSketch([
  { x: 0.18, y: 0.82 },
  { x: 0.18, y: 0.18 },
  { x: 0.46, y: 0.18 },
  { x: 0.46, y: 0.56 },
  { x: 0.62, y: 0.56 },
  { x: 0.74, y: 0.42 },
  { x: 0.68, y: 0.24 },
  { x: 0.82, y: 0.18 },
]);

assert.equal(streetIcon.pass, true, "bold icon-like street sketch should pass");
assert(
  streetIcon.score >= 70,
  `bold street sketch should score well, got ${streetIcon.score}`,
);

const tinyScribble = reviewStreetDesignSketch([
  { x: 0.48, y: 0.48 },
  { x: 0.49, y: 0.48 },
  { x: 0.49, y: 0.49 },
  { x: 0.48, y: 0.49 },
  { x: 0.48, y: 0.48 },
]);

assert.equal(
  tinyScribble.pass,
  false,
  "drafts collapsed into tiny details should not burn route attempts",
);

const tangled = reviewStreetDesignSketch([
  { x: 0.15, y: 0.15 },
  { x: 0.85, y: 0.85 },
  { x: 0.15, y: 0.85 },
  { x: 0.85, y: 0.15 },
  { x: 0.2, y: 0.5 },
  { x: 0.8, y: 0.5 },
  { x: 0.15, y: 0.15 },
]);

assert.equal(
  tangled.pass,
  false,
  "over-crossed sketches should be rejected as visually noisy",
);

console.log("streetDesignSketch tests ok");
