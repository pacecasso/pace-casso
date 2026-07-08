import assert from "node:assert";
import {
  dailyBudgetAllow,
  sameOriginAllowed,
  shieldExpensiveRoute,
  trustedClientIp,
} from "./apiShield";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://pacecasso.com/api/test", { headers });
}

// trustedClientIp prefers the proxy-set x-real-ip over spoofable x-forwarded-for
assert.equal(
  trustedClientIp(
    reqWith({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 1.2.3.4" }),
  ),
  "1.2.3.4",
);
assert.equal(
  trustedClientIp(reqWith({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" })),
  "5.6.7.8",
);
assert.equal(trustedClientIp(reqWith({})), "unknown");

// same-origin gate: Origin matching Host passes
assert.equal(
  sameOriginAllowed(
    reqWith({ host: "pacecasso.com", origin: "https://pacecasso.com" }),
  ),
  true,
);
// Referer fallback passes
assert.equal(
  sameOriginAllowed(
    reqWith({ host: "pacecasso.com", referer: "https://pacecasso.com/create" }),
  ),
  true,
);
// cross-origin blocked
assert.equal(
  sameOriginAllowed(
    reqWith({ host: "pacecasso.com", origin: "https://evil.example" }),
  ),
  false,
);
// bare scripts (no origin, no referer) blocked
assert.equal(sameOriginAllowed(reqWith({ host: "pacecasso.com" })), false);
// preview deployments: host and origin still match each other
assert.equal(
  sameOriginAllowed(
    reqWith({
      host: "pace-casso-abc123.vercel.app",
      origin: "https://pace-casso-abc123.vercel.app",
    }),
  ),
  true,
);

// daily budget: counts up to the cap, then blocks
for (let i = 0; i < 5; i++) {
  assert.equal(dailyBudgetAllow("test-route", 5), true, `call ${i} allowed`);
}
assert.equal(dailyBudgetAllow("test-route", 5), false, "6th call blocked");
assert.equal(dailyBudgetAllow("other-route", 5), true, "separate buckets");

// combined shield
const ok = shieldExpensiveRoute(
  reqWith({ host: "pacecasso.com", origin: "https://pacecasso.com" }),
  "shield-test",
  10,
);
assert.equal(ok.ok, true);
const blocked = shieldExpensiveRoute(reqWith({ host: "pacecasso.com" }), "shield-test", 10);
assert.equal(blocked.ok, false);
if (!blocked.ok) assert.equal(blocked.status, 403);

console.log("apiShield tests passed");
