import assert from "node:assert/strict";
import {
  clearFinalizedRoutes,
  loadFinalizedRoutes,
  saveFinalizedRoute,
} from "./finalizedRouteMemory";

const store = new Map<string, string>();
const storageKey = "pacecasso-finalized-routes-v1";

const fakeLocalStorage = {
  getItem(key: string) {
    return store.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    store.set(key, value);
  },
  removeItem(key: string) {
    store.delete(key);
  },
};

(globalThis as unknown as { window: unknown }).window = {
  localStorage: fakeLocalStorage,
};
(globalThis as unknown as { localStorage: unknown }).localStorage =
  fakeLocalStorage;

clearFinalizedRoutes();

store.set(
  storageKey,
  JSON.stringify([
    {
      center: [40, -73],
      rotationDeg: 12,
      scale: 1.2,
      distanceKm: 8.4,
      savedAt: "2026-06-17T12:00:00.000Z",
    },
    {
      center: [120, -73],
      rotationDeg: 12,
      scale: 1.2,
      distanceKm: 8.4,
      savedAt: "2026-06-17T12:00:00.000Z",
    },
    {
      center: [40, -73],
      rotationDeg: 12,
      scale: 0,
      distanceKm: 8.4,
      savedAt: "2026-06-17T12:00:00.000Z",
    },
    {
      center: [40, -73],
      rotationDeg: 12,
      scale: 1.2,
      distanceKm: 0,
      savedAt: "2026-06-17T12:00:00.000Z",
    },
    {
      center: [40, -73],
      rotationDeg: 12,
      scale: 1.2,
      distanceKm: 8.4,
      savedAt: "not a date",
    },
  ]),
);

const loaded = loadFinalizedRoutes();
assert.equal(loaded.length, 1);
assert.deepEqual(loaded[0]?.center, [40, -73]);

clearFinalizedRoutes();
saveFinalizedRoute({
  center: [95, -73],
  rotationDeg: 0,
  scale: 1,
  distanceKm: 5,
});
assert.equal(loadFinalizedRoutes().length, 0);

saveFinalizedRoute({
  center: [40, -73],
  rotationDeg: 0,
  scale: 1,
  distanceKm: 5,
});
saveFinalizedRoute({
  center: [40.0005, -73.0005],
  rotationDeg: 3,
  scale: 1.02,
  distanceKm: 5.2,
});
assert.equal(
  loadFinalizedRoutes().length,
  1,
  "near-identical finalized placements should be deduped",
);

clearFinalizedRoutes();

console.log("finalizedRouteMemory tests ok");
