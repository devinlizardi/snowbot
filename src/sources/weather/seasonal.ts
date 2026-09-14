import type { Source } from '../types.js';
import { SEASONAL_URL, getJson, type RawResponse } from './openMeteo.js';
import type { Coord, SeasonalOutlook } from './types.js';

export type SeasonalParams = {
  coord: Coord;
  /** How far ahead to look. The Aspen monthly post wants the trip month. */
  forecastDays: number;
  ttlMinutes: number;
};

/**
 * NOAA CFS, via Open-Meteo. Feeds the monthly Aspen outlook only.
 *
 * Seasonal skill is genuinely weak — this is worth a sentence about whether the
 * season is trending warm or wet, and nothing more specific. Anything that
 * quotes a seasonal number as a day-level expectation is misreading it.
 */
export const seasonal: Source<SeasonalParams, SeasonalOutlook> = {
  name: 'open-meteo:seasonal',
  key: (p) => `${p.coord.lat.toFixed(4)},${p.coord.lon.toFixed(4)}:${p.forecastDays}d`,
  ttlMinutes: (p) => p.ttlMinutes,
  async fetch(p) {
    const json = await getJson(SEASONAL_URL, {
      latitude: p.coord.lat,
      longitude: p.coord.lon,
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
      forecast_days: p.forecastDays,
      timezone: 'auto',
    });
    return parseSeasonal(json, p.coord);
  },
};

export function parseSeasonal(json: RawResponse, coord: Coord): SeasonalOutlook {
  const num = (name: string): (number | null)[] =>
    (json.daily?.[name] as (number | null)[] | undefined) ?? [];
  const dates: string[] = json.daily?.time ?? [];
  const max = num('temperature_2m_max');
  const min = num('temperature_2m_min');
  const precip = num('precipitation_sum');

  const buckets = new Map<string, { temps: number[]; precip: number[] }>();
  dates.forEach((date, i) => {
    const month = date.slice(0, 7);
    const b = buckets.get(month) ?? { temps: [], precip: [] };
    const hi = max[i];
    const lo = min[i];
    if (typeof hi === 'number' && typeof lo === 'number') b.temps.push((hi + lo) / 2);
    const pr = precip[i];
    if (typeof pr === 'number') b.precip.push(pr);
    buckets.set(month, b);
  });

  return {
    coord,
    months: [...buckets.entries()].map(([month, b]) => ({
      month,
      tempMeanC: b.temps.length ? round1(b.temps.reduce((x, y) => x + y, 0) / b.temps.length) : null,
      precipitationMm: b.precip.length ? round1(b.precip.reduce((x, y) => x + y, 0)) : null,
    })),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
