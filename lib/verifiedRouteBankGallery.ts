import type { CuratedRun } from "./curatedManhattanRuns";
import { getVerifiedRouteBankExport } from "./verifiedRouteBankExports";
import { safeRouteCoords, safeRouteDistanceMeters } from "./routeExport";

/**
 * Gallery presentation for the verified route bank. Each entry's route data
 * (and its GPX download at /api/curated-gpx/<id>) comes straight from the
 * blind-judge-verified bank export — this module only adds the card copy.
 */
type BankCardCopy = {
  id: string;
  title: string;
  icon: string;
  areaName: string;
  blurb: string;
};

/**
 * Aug 11 re-verification: only routes that passed the blind instrument
 * 3/3 in BOTH re-verification rounds are shown publicly. Eight former
 * bank cards (sneaker, sailboat, LES heart, turtle, key, DC martini,
 * umbrella, trophy) failed and were pulled — verdicts archived in
 * tmp-gas-commission/reverify/. Their route data and GPX endpoints
 * remain; they are simply no longer advertised as verified.
 */
const BANK_CARD_COPY: BankCardCopy[] = [
  {
    id: "apple",
    title: "Midtown Apple",
    icon: "🍏",
    areaName: "Midtown",
    blurb:
      "An apple with a bite notch, stem and leaf, drawn on the Midtown grid. Re-verified Aug 2026: blind judges named it an apple 6 times out of 6.",
  },
];

/** Catalog routes that passed both Aug 11 re-verification rounds 3/3. */
export const REVERIFIED_CATALOG_IDS = [
  "catalog-heart",
  "catalog-elephant",
  "catalog-runner",
  "catalog-the-big-apple",
] as const;

export const VERIFIED_ROUTE_BANK_GALLERY_RUNS: CuratedRun[] = BANK_CARD_COPY.map(
  (copy) => {
    const entry = getVerifiedRouteBankExport(copy.id);
    if (!entry) throw new Error(`Verified route bank export missing: ${copy.id}`);
    const coords = safeRouteCoords(entry.route) as [number, number][];
    const distanceMeters = safeRouteDistanceMeters(entry.route) ?? 0;
    const distanceKm = Math.round((distanceMeters / 1000) * 10) / 10;
    return {
      id: copy.id,
      title: copy.title,
      icon: copy.icon,
      area: `${copy.areaName} · ${distanceKm} km, one continuous line`,
      blurb: copy.blurb,
      distanceKm,
      coords,
    };
  },
);
