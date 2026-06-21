import { routeQualityScore } from "./routeQuality";
import type { RouteLineString } from "./routeTypes";
import { haversineMeters } from "./haversine";

export type ExportWalkingCue = {
  lat: number;
  lng: number;
  instruction: string;
  street: string | null;
};

export type StreetLabelPolicy = (
  instruction: string,
  street: string | null | undefined,
) => boolean;

export type RouteExportMetadata = {
  artworkConnectorCount?: number;
  artworkMatchScore?: number;
};

function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

function defaultShouldAppendStreetLabel(
  _instruction: string,
  street: string | null | undefined,
): boolean {
  return Boolean(street?.trim());
}

export function safeRouteCoords(route: RouteLineString): [number, number][] {
  return (route.coordinates ?? []).filter(
    (c): c is [number, number] =>
      Array.isArray(c) &&
      isValidLatLng(c[0], c[1]),
  );
}

export function safeRouteBlockWaypoints(route: RouteLineString): [number, number][] {
  return (route.blockWaypoints ?? []).filter(
    (c): c is [number, number] =>
      Array.isArray(c) &&
      isValidLatLng(c[0], c[1]),
  );
}

export function safeExportWalkingCues(
  cues: ExportWalkingCue[],
): ExportWalkingCue[] {
  const out: ExportWalkingCue[] = [];
  for (const c of cues) {
    if (!isValidLatLng(c.lat, c.lng)) continue;
    if (typeof c.instruction !== "string") continue;
    const instruction = c.instruction.trim();
    if (!instruction) continue;
    const street =
      typeof c.street === "string" && c.street.trim()
        ? c.street.trim()
        : null;
    out.push({ lat: c.lat, lng: c.lng, instruction, street });
  }
  return out;
}

export function safeDistanceMeters(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function measuredRouteDistanceMeters(route: RouteLineString): number | null {
  const coords = safeRouteCoords(route);
  if (coords.length < 2) return null;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return total > 0 ? total : null;
}

export function safeRouteDistanceMeters(route: RouteLineString): number | null {
  const rawDistance = safeDistanceMeters(route.distanceMeters);
  const measuredDistance = measuredRouteDistanceMeters(route);
  if (measuredDistance == null) return null;
  if (rawDistance != null && rawDistance > 0) return rawDistance;
  return measuredDistance;
}

export function routeToGeoJSONFeature(
  route: RouteLineString,
  metadata: RouteExportMetadata = {},
) {
  const coords = safeRouteCoords(route);
  const blockWaypoints = safeRouteBlockWaypoints(route);
  const cleanLineScore = routeQualityScore(coords);
  const connectorCount = Math.max(0, metadata.artworkConnectorCount ?? 0);
  const artworkMatchScore =
    typeof metadata.artworkMatchScore === "number" &&
    Number.isFinite(metadata.artworkMatchScore)
      ? Math.max(0, Math.min(100, Math.round(metadata.artworkMatchScore)))
      : null;
  return {
    type: "Feature" as const,
    properties: {
      name: "PaceCasso walking route",
      distanceMeters: safeRouteDistanceMeters(route),
      waypointCount: blockWaypoints.length || null,
      pathVertexCount: coords.length,
      cleanLineScore,
      cleanLineVerdict:
        cleanLineScore >= 78
          ? "clean"
          : cleanLineScore >= 55
            ? "some route clutter"
            : "heavy route clutter",
      artworkConnectorCount: connectorCount,
      artworkMatchScore,
    },
    geometry: {
      type: "LineString" as const,
      coordinates: coords.map(([lat, lng]) => [lng, lat] as [number, number]),
    },
  };
}

export function routeToGeoJSONFeatureCollection(
  route: RouteLineString,
  cues: ExportWalkingCue[],
  metadata: RouteExportMetadata = {},
) {
  const features: Record<string, unknown>[] = [
    routeToGeoJSONFeature(route, metadata),
  ];
  const safeCues = safeExportWalkingCues(cues);
  safeCues.forEach((c, i) => {
    features.push({
      type: "Feature",
      properties: {
        name: `Cue ${i + 1}`,
        instruction: c.instruction,
        street: c.street,
      },
      geometry: {
        type: "Point",
        coordinates: [c.lng, c.lat] as [number, number],
      },
    });
  });
  return { type: "FeatureCollection" as const, features };
}

export function routeToGpx(
  route: RouteLineString,
  cues: ExportWalkingCue[],
  shouldAppendStreetLabel: StreetLabelPolicy = defaultShouldAppendStreetLabel,
  metadata: RouteExportMetadata = {},
): string {
  const coords = safeRouteCoords(route);
  const cleanLineScore = routeQualityScore(coords);
  const connectorCount = Math.max(0, metadata.artworkConnectorCount ?? 0);
  const artworkMatchScore =
    typeof metadata.artworkMatchScore === "number" &&
    Number.isFinite(metadata.artworkMatchScore)
      ? Math.max(0, Math.min(100, Math.round(metadata.artworkMatchScore)))
      : null;
  const descParts = [`Clean line score: ${cleanLineScore}%`];
  if (artworkMatchScore != null) {
    descParts.push(`Artwork match score: ${artworkMatchScore}%`);
  }
  if (connectorCount > 0) {
    descParts.push(
      `Artwork connector strokes: ${connectorCount}`,
    );
  }
  const pts = coords
    .map(
      ([lat, lng]) =>
        `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  const safeCues = safeExportWalkingCues(cues);
  const wptBlock =
    safeCues.length > 0
      ? `${safeCues
          .map((c) => {
            const desc =
              c.street && shouldAppendStreetLabel(c.instruction, c.street)
                ? `\n    <desc>${escapeXml(c.street)}</desc>`
                : "";
            return `  <wpt lat="${c.lat.toFixed(7)}" lon="${c.lng.toFixed(7)}">
    <name>${escapeXml(c.instruction)}</name>${desc}
  </wpt>`;
          })
          .join("\n")}\n`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
${wptBlock}  <trk>
    <name>PaceCasso route</name>
    <desc>${escapeXml(descParts.join("; "))}</desc>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function cuesToPlainText(
  cues: ExportWalkingCue[],
  shouldAppendStreetLabel: StreetLabelPolicy = defaultShouldAppendStreetLabel,
): string {
  return safeExportWalkingCues(cues)
    .map((c, i) => {
      const extra =
        c.street && shouldAppendStreetLabel(c.instruction, c.street)
          ? ` (${c.street})`
          : "";
      return `${i + 1}. ${c.instruction}${extra}`;
    })
    .join("\n");
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
