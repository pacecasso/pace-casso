import assert from "node:assert";
import { filledSilhouetteToLineArtMask } from "./filledSilhouetteToLineArtMask";

{
  const w = 20;
  const h = 20;
  const filled = new Uint8Array(w * h);
  for (let y = 5; y < 15; y++) {
    for (let x = 5; x < 15; x++) {
      filled[y * w + x] = 255;
    }
  }
  const line = filledSilhouetteToLineArtMask(filled, w, h, 2);
  let ink = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i]! > 80) ink++;
  }
  assert.ok(ink < 10 * 10, "line art should be thinner than filled square");
  assert.ok(ink > 30, "line art should still have visible stroke");
}

console.log("filledSilhouetteToLineArtMask tests ok");
