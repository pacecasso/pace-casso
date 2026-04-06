/** Geographic context for map placement and freehand default view. */
export type CityPreset = {
  id: string;
  label: string;
  /** Default map center for placement and freehand draw. */
  defaultCenter: [number, number];
  /** Rough lat/lng extent for this preset (shown on city step). */
  searchBounds: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
};

export const MANHATTAN_PRESET: CityPreset = {
  id: "manhattan",
  label: "Manhattan",
  defaultCenter: [40.7831, -73.9712],
  // East edge stays west of the East River so the preset reads as Manhattan.
  searchBounds: {
    south: 40.698,
    west: -74.02,
    north: 40.882,
    east: -73.958,
  },
};

export const CITY_PRESETS: Record<string, CityPreset> = {
  manhattan: MANHATTAN_PRESET,
};

export const DEFAULT_CITY_ID = "manhattan" as const;
