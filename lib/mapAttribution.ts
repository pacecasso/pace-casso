/**
 * Basemap tiles for every interactive map view.
 *
 * We previously pointed straight at tile.openstreetmap.org. OSM's public tile
 * servers actively throttle/block production apps (usage policy:
 * https://operations.osmfoundation.org/policies/tiles/), which showed up on
 * the live site as maps with big missing patches. CARTO's OSM-based basemap
 * CDN is built for exactly this use and stays reliable under app traffic.
 *
 * Keep attribution identical on every map view. The export names keep the
 * legacy "OSM_" prefix so all six map components pick this up unchanged.
 */
export const OSM_TILE_URL =
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

export const OSM_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
