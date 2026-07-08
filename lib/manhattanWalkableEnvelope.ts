/** Rough Manhattan walkable envelope — rejects Hudson / East River. */
export function isOnManhattanWalkable(lat: number, lng: number): boolean {
  if (lat < 40.705 || lat > 40.875) return false;
  if (lng < -74.02 || lng > -73.91) return false;
  if (lat < 40.715) {
    if (lng < -74.012 || lng > -73.975) return false;
  } else if (lat < 40.74) {
    if (lng < -74.01 || lng > -73.972) return false;
  } else if (lat < 40.765) {
    if (lng < -74.008 || lng > -73.968) return false;
  } else {
    if (lng < -74.005 || lng > -73.955) return false;
  }
  return true;
}
