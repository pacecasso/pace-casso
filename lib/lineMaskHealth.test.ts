import assert from "node:assert";
import { describeLineMaskHealth } from "./lineMaskHealth";

{
  const w = 12;
  const h = 12;
  const mask = new Uint8Array(w * h);
  const h0 = describeLineMaskHealth(mask, w, h);
  assert.strictEqual(h0.inkBlobCount, 0);
  assert.ok(h0.hint.length > 10);
}

{
  const w = 8;
  const h = 8;
  const mask = new Uint8Array(w * h);
  mask[10] = 200;
  mask[11] = 200;
  mask[18] = 200;
  const h1 = describeLineMaskHealth(mask, w, h);
  assert.strictEqual(h1.inkBlobCount, 1);
  assert.ok(h1.largestBlobShare > 0.9);
}

console.log("lineMaskHealth tests ok");
