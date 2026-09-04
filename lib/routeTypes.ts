/** Shared route shape for Mapbox snap output and GPX export. */
export type RouteLineString = {
  coordinates: [number, number][];
  distanceMeters?: number;
  blockWaypoints?: [number, number][];
  /** Preserve explicit blockWaypoints when reopening in the route editor. */
  preserveBlockWaypoints?: boolean;
  /**
   * True ONLY when independent judges actually recognized this route.
   * Downstream screens used to infer "verified" from
   * preserveBlockWaypoints, which is set on every street-native hand-off
   * INCLUDING refused best-effort drafts — so a route the judges called
   * "nothing recognizable" got a "Verified runnable GPS art" banner two
   * screens later (caught by the Aug 30 user audit).
   */
  verified?: boolean;
  /**
   * The stroke painter's instant first draft: street-native and runnable,
   * but no stranger has named it. Never "verified"; downstream banners say
   * "first draft" instead.
   */
  draft?: boolean;
};
