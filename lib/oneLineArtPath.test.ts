import assert from "node:assert";
import { joinPolylinesAsOneLine } from "./oneLineArtPath";

{
  const joined = joinPolylinesAsOneLine([
    [
      [20, 0],
      [10, 0],
    ],
    [
      [0, 0],
      [5, 0],
    ],
  ]);
  assert.deepEqual(joined, [
    [0, 0],
    [5, 0],
    [10, 0],
    [20, 0],
  ]);
}

{
  const joined = joinPolylinesAsOneLine([
    [
      [0, 0],
      [10, 0],
    ],
    [
      [20, 0],
      [12, 0],
    ],
  ]);
  assert.deepEqual(joined, [
    [0, 0],
    [10, 0],
    [12, 0],
    [20, 0],
  ]);
}

{
  const joined = joinPolylinesAsOneLine(
    [
      [
        [0, 0],
        [1, 0],
      ],
      [
        [10, 0],
        [12, 0],
        [12, 2],
        [10, 2],
        [10, 0],
      ],
    ],
    { closedLoopThreshold: 0.01 },
  );
  assert.deepEqual(joined.slice(0, 4), [
    [0, 0],
    [1, 0],
    [10, 0],
    [12, 0],
  ]);
  assert.deepEqual(joined.at(-1), [10, 0]);
}

console.log("oneLineArtPath tests ok");
