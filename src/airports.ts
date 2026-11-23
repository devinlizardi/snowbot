/*
 * Where the roster's airports are, so the scout can say who could drive and
 * who has to fly without hardcoding it per spot. Only the airports config
 * actually uses; an airport missing here just means "fly".
 */
export const AIRPORT_COORDS: Record<string, { lat: number; lon: number }> = {
  JFK: { lat: 40.6413, lon: -73.7781 },
  LGA: { lat: 40.7769, lon: -73.874 },
  EWR: { lat: 40.6895, lon: -74.1745 },
  BUR: { lat: 34.2007, lon: -118.3587 },
  LAX: { lat: 33.9416, lon: -118.4085 },
  SNA: { lat: 33.6762, lon: -117.8675 },
  SFO: { lat: 37.6213, lon: -122.379 },
  OAK: { lat: 37.7126, lon: -122.2197 },
  SJC: { lat: 37.3639, lon: -121.9289 },
};

/** Great-circle distance, km. */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
