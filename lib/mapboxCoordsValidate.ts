export type LatLngPair = [number, number];

export function isValidLatLng([lat, lng]: LatLngPair): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function parseLatLngArray(
  raw: unknown,
  maxLen: number,
): LatLngPair[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  if (raw.length > maxLen) return null;
  const out: LatLngPair[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) return null;
    const lat = Number(row[0]);
    const lng = Number(row[1]);
    if (!isValidLatLng([lat, lng])) return null;
    out.push([lat, lng]);
  }
  return out;
}
