/**
 * Google's encoded polyline format (precision 5), for use with Mapbox Static
 * Images path overlays. Takes `[lat, lng]` pairs; emits a compact ASCII string
 * that any Mapbox tooling accepts.
 */

function encodeSignedNumber(num: number): string {
  let sgn = num < 0 ? ~(num << 1) : num << 1;
  let out = "";
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}

/**
 * Encode `[lat, lng]` coords to a Google-style polyline string.
 * Precision 5 → ~1 meter resolution, which is far finer than what Mapbox static
 * rendering will ever show.
 */
export function encodePolyline(coords: [number, number][]): string {
  let lastLat = 0;
  let lastLng = 0;
  let out = "";
  for (const [lat, lng] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    out += encodeSignedNumber(latE5 - lastLat);
    out += encodeSignedNumber(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return out;
}
