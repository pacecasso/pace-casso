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

const BANK_CARD_COPY: BankCardCopy[] = [
  {
    id: "sneaker",
    title: "Downtown Sneaker",
    icon: "👟",
    areaName: "Lower East Side & Chinatown",
    blurb:
      "A low-top sneaker the size of a neighborhood — heel, toe, lace comb and sole drawn street by street. Verified against the route bank's blind proof.",
  },
  {
    id: "sailboat",
    title: "Midtown Sailboat",
    icon: "⛵",
    areaName: "Midtown & the Garment District",
    blurb:
      "Hull, mast, mainsail and jib sailing across Midtown blocks. Verified against the route bank's blind proof.",
  },
  {
    id: "heart",
    title: "Lower East Side Heart",
    icon: "❤️",
    areaName: "Lower East Side",
    blurb:
      "A compact pixel heart with clean lobes and a pointed tip — the shortest verified route in the bank, perfect for an easy morning run.",
  },
  {
    id: "turtle",
    title: "Chelsea Turtle",
    icon: "🐢",
    areaName: "Chelsea",
    blurb:
      "Shell, four legs, head and tail plodding through Chelsea. Verified against the route bank's blind proof.",
  },
  {
    id: "apple",
    title: "Midtown Apple",
    icon: "🍏",
    areaName: "Midtown",
    blurb:
      "An apple with a bite notch, stem and leaf, drawn on the Midtown grid. Verified against the route bank's blind proof.",
  },
  {
    id: "key",
    title: "Flatiron Key",
    icon: "🗝️",
    areaName: "Chelsea & Flatiron",
    blurb:
      "A key with a square bow, inner hole, long shaft and stepped teeth. Verified against the route bank's blind proof.",
  },
  {
    id: "martini-dc",
    title: "Dupont Martini",
    icon: "🍸",
    areaName: "Dupont Circle · Washington, DC",
    blurb:
      "A cocktail glass with a triangular bowl, stem and base — the bank's first route outside New York. Verified against the route bank's blind proof.",
  },
  {
    id: "umbrella",
    title: "Midtown Umbrella",
    icon: "☂️",
    areaName: "Midtown East",
    blurb:
      "An umbrella with an arched canopy, scalloped edge, shaft and handle. Verified against the route bank's blind proof.",
  },
  {
    id: "trophy",
    title: "Midtown Trophy",
    icon: "🏆",
    areaName: "Midtown South",
    blurb:
      "A trophy cup with a broad bowl, side handles, stem and stepped base. Verified against the route bank's blind proof.",
  },
];

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
