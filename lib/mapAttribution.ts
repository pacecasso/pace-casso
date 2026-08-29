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
//
// Aug 29 2026: CARTO began serving its free basemap tiles with an
// "API KEY REQUIRED" watermark burned into every tile (identical bytes for
// any referer), which made every map in production look broken. Esri's
// World Street Map is a keyless raster basemap with a real CDN and full
// street labels at all editing zooms. Follow-up: a free CARTO API key
// restores the cleaner Voyager style — swap the URL back with the key.
export const OSM_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";

export const OSM_TILE_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
