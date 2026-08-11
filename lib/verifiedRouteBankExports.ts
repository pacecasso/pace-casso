import { curatedApple2RouteLine } from "./curatedInterpretiveManhattanRoutes";
import type { RouteLineString } from "./routeTypes";
import { safeRouteCoords, safeRouteDistanceMeters } from "./routeExport";

export type VerifiedRouteBankExport = {
  id: string;
  title: string;
  description: string;
  route: RouteLineString;
};

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Aug 11 re-verification: only routes that passed the blind instrument in
 * both re-verification rounds may be exported under a "Verified" title.
 * Eight former exports (sneaker, sailboat, LES heart, turtle, key,
 * DC martini, umbrella, trophy) were demoted — see
 * verifiedRouteBankManifest.ts and tmp-gas-commission/reverify/.
 */
const VERIFIED_ROUTE_BANK_EXPORTS: VerifiedRouteBankExport[] = [
  {
    id: "apple",
    title: "Verified apple Manhattan v1",
    description: "Apple outline with bite notch, stem, and leaf.",
    route: curatedApple2RouteLine(),
  },
];

export function listVerifiedRouteBankExports(): VerifiedRouteBankExport[] {
  return VERIFIED_ROUTE_BANK_EXPORTS.slice();
}

export function getVerifiedRouteBankExport(id: string): VerifiedRouteBankExport | undefined {
  return VERIFIED_ROUTE_BANK_EXPORTS.find((entry) => entry.id === id);
}

export function verifiedRouteBankExportToGpx(entry: VerifiedRouteBankExport): string {
  const coords = safeRouteCoords(entry.route);
  const distanceMeters = safeRouteDistanceMeters(entry.route);
  const distanceKm = distanceMeters == null ? null : distanceMeters / 1000;
  const pts = coords
    .map(
      ([lat, lng]) =>
        `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  const distanceText = distanceKm == null ? "unknown distance" : `${distanceKm.toFixed(2)} km`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso verified route bank" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${xmlEscape(entry.title)}</name>
    <desc>${xmlEscape(`${entry.description} ${distanceText}. Verified runnable route bank export.`)}</desc>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}
