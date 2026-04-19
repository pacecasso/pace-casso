/** Geographic context for map placement and freehand default view. */
export type CityPreset = {
  id: string;
  label: string;
  /** Short subtitle shown on the city picker (e.g. "New York" under "Manhattan"). */
  region?: string;
  /** One-line pitch for the city picker card. */
  tagline?: string;
  /** Default map center for placement and freehand draw. */
  defaultCenter: [number, number];
  /** Rough lat/lng extent for this preset. */
  searchBounds: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  /**
   * Street-grid bearings from north (degrees), for auto-find alignment bonus.
   * Manhattan's grid is ~29° / 119° from north; Chicago is a perfect cardinal
   * grid; SF's Mission is ~45° to cardinal. Omit for cities with no grid
   * (Boston, Paris, Tokyo) — auto-find falls back to flexible rotation.
   */
  dominantGridBearingsDeg?: number[];
};

export const MANHATTAN_PRESET: CityPreset = {
  id: "manhattan",
  label: "Manhattan",
  region: "New York City",
  tagline: "Tilted grid, dense avenues — letters and portraits shine here.",
  defaultCenter: [40.7831, -73.9712],
  // East edge stays west of the East River so the preset reads as Manhattan.
  searchBounds: {
    south: 40.698,
    west: -74.02,
    north: 40.882,
    east: -73.958,
  },
  dominantGridBearingsDeg: [29, 119],
};

export const BROOKLYN_PRESET: CityPreset = {
  id: "brooklyn",
  label: "Brooklyn",
  region: "New York City",
  tagline: "Multiple grids, more breathing room — sprawling silhouettes.",
  defaultCenter: [40.682, -73.975],
  searchBounds: {
    south: 40.57,
    west: -74.03,
    north: 40.74,
    east: -73.855,
  },
  // Brooklyn's main grid (Park Slope, Crown Heights, Bed-Stuy) sits ~30° off
  // north; Williamsburg flirts with cardinal. We list both as acceptable.
  dominantGridBearingsDeg: [30, 120],
};

export const CHICAGO_PRESET: CityPreset = {
  id: "chicago",
  label: "Chicago",
  region: "Illinois",
  tagline: "Near-perfect cardinal grid — the purest letter canvas in the US.",
  defaultCenter: [41.8781, -87.6298],
  searchBounds: {
    south: 41.79,
    west: -87.74,
    north: 41.99,
    east: -87.58,
  },
  // Chicago's grid is famously cardinal. Minor variation near the river.
  dominantGridBearingsDeg: [0, 90],
};

export const SAN_FRANCISCO_PRESET: CityPreset = {
  id: "sf",
  label: "San Francisco",
  region: "California",
  tagline: "Tilted Mission grid + diagonal Market St — good for bold shapes.",
  defaultCenter: [37.77, -122.425],
  searchBounds: {
    south: 37.73,
    west: -122.52,
    north: 37.81,
    east: -122.385,
  },
  // Mission / SOMA grid is ~45° off cardinal; Richmond/Sunset are cardinal.
  dominantGridBearingsDeg: [45, 135],
};

export const DC_PRESET: CityPreset = {
  id: "dc",
  label: "Washington DC",
  region: "District of Columbia",
  tagline:
    "Cardinal grid plus diagonal avenues — a unique mix for clever routes.",
  defaultCenter: [38.905, -77.035],
  searchBounds: {
    south: 38.82,
    west: -77.12,
    north: 38.99,
    east: -76.91,
  },
  // DC has a cardinal base grid + radiating diagonals (NW/NE ~60° bearings).
  dominantGridBearingsDeg: [0, 90],
};

export const CITY_PRESETS: Record<string, CityPreset> = {
  manhattan: MANHATTAN_PRESET,
  brooklyn: BROOKLYN_PRESET,
  chicago: CHICAGO_PRESET,
  sf: SAN_FRANCISCO_PRESET,
  dc: DC_PRESET,
};

export const DEFAULT_CITY_ID = "manhattan" as const;

/** Ordered list for UI display. Manhattan stays first — original city. */
export const CITY_PRESETS_ORDERED: CityPreset[] = [
  MANHATTAN_PRESET,
  BROOKLYN_PRESET,
  CHICAGO_PRESET,
  SAN_FRANCISCO_PRESET,
  DC_PRESET,
];
