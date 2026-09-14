import type { Source } from '../types.js';
import { ARCHIVE_URL, getJson, type RawResponse } from './openMeteo.js';
import type { Coord, ObservedSnow } from './types.js';

export type ArchiveParams = {
  coord: Coord;
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  end: string;
  ttlMinutes: number;
};

/**
 * What actually fell, as opposed to what was forecast.
 *
 * This is the honesty check on the whole weather stack: it is what lets a post
 * say "18cm forecast, 4cm fell" instead of quietly moving on, and it feeds the
 * `observed_snow_7d` term in destination ranking.
 */
export const archive: Source<ArchiveParams, ObservedSnow> = {
  name: 'open-meteo:archive',
  key: (p) => `${p.coord.lat.toFixed(4)},${p.coord.lon.toFixed(4)}:${p.start}..${p.end}`,
  ttlMinutes: (p) => p.ttlMinutes,
  async fetch(p) {
    const json = await getJson(ARCHIVE_URL, {
      latitude: p.coord.lat,
      longitude: p.coord.lon,
      start_date: p.start,
      end_date: p.end,
      daily: 'snowfall_sum',
      timezone: 'auto',
    });
    return parseArchive(json, p.coord);
  },
};

export function parseArchive(json: RawResponse, coord: Coord): ObservedSnow {
  const dates: string[] = json.daily?.time ?? [];
  const sums = (json.daily?.snowfall_sum as (number | null)[] | undefined) ?? [];
  const days = dates.map((date, i) => ({
    date,
    snowfallCm: typeof sums[i] === 'number' ? (sums[i] as number) : null,
  }));
  const last7 = days.slice(-7);
  return {
    coord,
    days,
    trailing7dCm: Math.round(last7.reduce((a, d) => a + (d.snowfallCm ?? 0), 0) * 10) / 10,
  };
}

/** The seven days ending yesterday — the archive has no value for today. */
export function trailingWeek(now: Date): { start: string; end: string } {
  const end = new Date(now.getTime() - 24 * 3600_000);
  const start = new Date(end.getTime() - 6 * 24 * 3600_000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return { start: d(start), end: d(end) };
}
