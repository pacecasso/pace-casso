/** Shared route shape for Mapbox snap output and GPX export. */
export type RouteLineString = {
  coordinates: [number, number][];
  distanceMeters?: number;
  blockWaypoints?: [number, number][];
};
