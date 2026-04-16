/**
 * Synthetic checks for out-and-back spur hints (no Mapbox).
 * Run: npx --yes tsx lib/outAndBackSpurHints.test.ts
 */
import assert from "node:assert/strict";
import {
  annotateOutAndBackSpurs,
  assignAlongRouteMeters,
  stripAlongRouteMeters,
} from "./outAndBackSpurHints";
import type { CueLike } from "./outAndBackSpurHints";

function main() {
  const line: [number, number][] = [
    [40.78, -73.98],
    [40.781, -73.981],
    [40.782, -73.98],
  ];

  const cues: CueLike[] = [
    {
      lat: 40.78,
      lng: -73.98,
      instruction: "Continue on West End Avenue",
      street: "West End Avenue",
    },
    {
      lat: 40.7805,
      lng: -73.9805,
      instruction: "Turn left onto West 73rd Street",
      street: "West 73rd Street",
      stepDistanceM: 50,
    },
    {
      lat: 40.7815,
      lng: -73.9805,
      instruction: "Continue on West 73rd Street",
      street: "West 73rd Street",
      stepDistanceM: 80,
    },
    {
      lat: 40.782,
      lng: -73.98,
      instruction: "Turn right onto West End Avenue",
      street: "West End Avenue",
      stepDistanceM: 50,
    },
  ];

  assignAlongRouteMeters(cues, line);
  const out = stripAlongRouteMeters(annotateOutAndBackSpurs(cues));

  assert.match(out[1]?.instruction ?? "", /out-and-back/i);
  assert.match(out[1]?.instruction ?? "", /West End Avenue/i);
  assert.equal(out[1]?.alongRouteM, undefined);

  const noHint = stripAlongRouteMeters(
    annotateOutAndBackSpurs([
      {
        lat: 40,
        lng: -73,
        instruction: "Continue on Main Street",
        street: "Main Street",
      },
      {
        lat: 40.001,
        lng: -73.001,
        instruction: "Turn left onto Oak Avenue",
        street: "Oak Avenue",
        stepDistanceM: 5000,
      },
      {
        lat: 40.05,
        lng: -73.05,
        instruction: "Turn right onto Main Street",
        street: "Main Street",
        stepDistanceM: 100,
      },
    ]),
  );
  assert.ok(!noHint[1]?.instruction.includes("out-and-back"));

  console.log("outAndBackSpurHints.test.ts: ok");
}

main();
