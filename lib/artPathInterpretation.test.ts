import assert from "node:assert/strict";
import { buildArtPathInterpretations } from "./artPathInterpretation";

const noisyHeart = [
  { x: 0.5, y: 0.9 },
  { x: 0.42, y: 0.82 },
  { x: 0.29, y: 0.7 },
  { x: 0.18, y: 0.55 },
  { x: 0.1, y: 0.38 },
  { x: 0.13, y: 0.24 },
  { x: 0.24, y: 0.15 },
  { x: 0.36, y: 0.18 },
  { x: 0.45, y: 0.31 },
  { x: 0.5, y: 0.43 },
  { x: 0.55, y: 0.31 },
  { x: 0.64, y: 0.18 },
  { x: 0.76, y: 0.15 },
  { x: 0.87, y: 0.24 },
  { x: 0.9, y: 0.38 },
  { x: 0.82, y: 0.55 },
  { x: 0.71, y: 0.7 },
  { x: 0.58, y: 0.82 },
  { x: 0.5, y: 0.9 },
];

const noisyOpenShape = [
  { x: 0.14, y: 0.72 },
  { x: 0.2, y: 0.58 },
  { x: 0.31, y: 0.54 },
  { x: 0.42, y: 0.33 },
  { x: 0.52, y: 0.46 },
  { x: 0.63, y: 0.28 },
  { x: 0.76, y: 0.44 },
  { x: 0.83, y: 0.7 },
];

const disconnectedLogoTrace = [
  { x: 0.15, y: 0.8 },
  { x: 0.15, y: 0.2 },
  { x: 0.35, y: 0.2 },
  { x: 0.35, y: 0.8 },
  { x: 0.15, y: 0.8 },
  { x: 0.86, y: 0.72 },
  { x: 0.78, y: 0.62 },
  { x: 0.8, y: 0.32 },
  { x: 0.7, y: 0.2 },
];

const heartVariants = buildArtPathInterpretations(noisyHeart);
assert(
  heartVariants.some((v) => v.id === "iconic-heart"),
  "heart-like art should get an iconic heart interpretation",
);
assert(
  heartVariants.find((v) => v.id === "iconic-heart")!.points.length <
    noisyHeart.length,
  "iconic heart should be simpler than the raw trace",
);

const genericVariants = buildArtPathInterpretations(noisyOpenShape);
assert(
  !genericVariants.some((v) => v.id === "iconic-heart"),
  "generic open art should not be classified as hearts",
);
assert(
  genericVariants.some((v) => v.id === "grid"),
  "generic art should still get a grid sketch interpretation",
);

const logoVariants = buildArtPathInterpretations(disconnectedLogoTrace);
assert.equal(
  logoVariants[0]?.id,
  "bold",
  "logo art should lead with the etch-a-sketch interpretation",
);
assert(
  logoVariants.some((v) => v.id === "bold"),
  "disconnected logo art should get an etch-a-sketch interpretation",
);
assert(
  !logoVariants.some((v) => v.id === "grid"),
  "disconnected logo art should not auto-offer a connector-distorting grid sketch",
);

console.log("artPathInterpretation tests ok");
