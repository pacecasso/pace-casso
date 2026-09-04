
import assert from "node:assert/strict";
import { classifySnapReadiness } from "./snapReadiness";

assert.equal(
  classifySnapReadiness({
    hasRoute: true,
    cleanLineScore: 12,
    interpretationScore: 8,
    routeSource: "image",
    verifiedRoute: true,
  }).title,
  "Verified runnable GPS art",
);
assert.equal(
  classifySnapReadiness({
    hasRoute: false,
    cleanLineScore: null,
    interpretationScore: null,
    routeSource: "image",
  }).tone,
  "blocked",
);

assert.equal(
  classifySnapReadiness({
    hasRoute: true,
    cleanLineScore: 20,
    interpretationScore: 80,
    routeSource: "image",
  }).title,
  "Route is not runnable art yet",
);

assert.equal(
  classifySnapReadiness({
    hasRoute: true,
    cleanLineScore: 42,
    interpretationScore: 80,
    routeSource: "image",
  }).title,
  "Route needs a look",
);

assert.equal(
  classifySnapReadiness({
    hasRoute: true,
    cleanLineScore: 90,
    interpretationScore: 42,
    routeSource: "image",
  }).title,
  "Shape does not read yet",
);

assert.equal(
  classifySnapReadiness({
    hasRoute: true,
    cleanLineScore: 90,
    interpretationScore: 60,
    routeSource: "image",
  }).title,
  "Shape may not read",
);

assert.equal(
  classifySnapReadiness({
    hasRoute: true,
    cleanLineScore: 90,
    interpretationScore: 20,
    routeSource: "freehand",
  }).tone,
  "ready",
  "freehand sketches should not be blocked by image-art interpretation thresholds",
);

{
  const draft = classifySnapReadiness({
    hasRoute: true,
    cleanLineScore: 13,
    interpretationScore: 99,
    routeSource: "image",
    verifiedRoute: false,
    draftRoute: true,
  });
  assert.equal(draft.tone, "check", "a first draft is never blocked and never ready");
  assert.ok(/first draft/i.test(draft.title), "a first draft says so");
  assert.ok(!/verified/i.test(draft.title), "a first draft is never called verified");
}

console.log("snapReadiness tests ok");
