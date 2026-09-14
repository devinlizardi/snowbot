import { log } from '../../logger.js';
import type { Coord, DailyWeather, ModelForecast } from './types.js';

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
export const SEASONAL_URL = 'https://seasonal-api.open-meteo.com/v1/seasonal';

/** Available from every model we use. */
const CORE_DAILY = [
  'snowfall_sum',
  'precipitation_sum',
  'temperature_2m_max',
  'temperature_2m_min',
  'temperature_2m_mean',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
] as const;

/**
 * Not every model carries these. Requesting an unsupported variable makes
 * Open-Meteo reject the whole call, so they go in a second request that is
 * allowed to fail: a missing freezing level costs us one line of a packing
 * note, and is never worth losing the snow totals over.
 */
const OPTIONAL_HOURLY = ['snow_depth', 'freezing_level_height'] as const;

export type OpenMeteoError = { error: true; reason: string };

/** Open-Meteo's response is a bag of parallel arrays whose keys depend on what
 *  was asked for, so it is typed loosely here and narrowed at the point of use. */
export type RawSeries = { time?: string[] } & Record<string, unknown>;
export type RawResponse = {
  latitude?: number;
  longitude?: number;
  elevation?: number;
  daily?: RawSeries;
  hourly?: RawSeries;
};

export async function getJson(url: string, params: Record<string, string | number>): Promise<RawResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const full = `${url}?${qs}`;
  const res = await fetch(full);
  const body = (await res
    .json()
    .catch(() => ({ error: true, reason: `non-JSON response (${res.status})` }))) as RawResponse & Partial<OpenMeteoError>;
  if (!res.ok || body.error) {
    throw new Error(`open-meteo ${res.status}: ${body.reason ?? 'unknown'} [${url}]`);
  }
  return body;
}

/**
 * One request per model rather than Open-Meteo's multi-model form.
 *
 * The multi-model response renames every key by appending the model
 * (`snowfall_sum_ecmwf_ifs025`), and the exact suffix isn't documented. Since
 * the API is free and uncapped, N small requests with stable key names beat one
 * request whose parsing depends on an undocumented naming rule.
 */
export async function fetchModelForecast(
  model: string,
  coord: Coord,
  forecastDays: number,
): Promise<ModelForecast> {
  const base = {
    latitude: coord.lat,
    longitude: coord.lon,
    models: model,
    daily: CORE_DAILY.join(','),
    forecast_days: forecastDays,
    timezone: 'auto',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
  };

  const missingVariables: string[] = [];
  const json = await getJson(FORECAST_URL, { ...base, hourly: OPTIONAL_HOURLY.join(',') }).catch(
    async (err) => {
      log.warn('model lacks optional hourly variables, retrying without them', {
        model,
        error: String(err),
      });
      missingVariables.push(...OPTIONAL_HOURLY);
      return getJson(FORECAST_URL, base);
    },
  );

  return parseForecast(json, model, coord, missingVariables);
}

export function parseForecast(
  json: RawResponse,
  model: string,
  coord: Coord,
  missingVariables: string[] = [],
): ModelForecast {
  const daily: RawSeries = json.daily ?? {};
  const dates: string[] = daily.time ?? [];
  const col = (name: string): (number | null)[] => (daily[name] as (number | null)[] | undefined) ?? [];

  const hourlyByDate = aggregateHourly(json.hourly);

  const days: DailyWeather[] = dates.map((date, i) => {
    const h = hourlyByDate.get(date);
    return {
      date,
      snowfallCm: at(col('snowfall_sum'), i),
      precipitationMm: at(col('precipitation_sum'), i),
      tempMaxC: at(col('temperature_2m_max'), i),
      tempMinC: at(col('temperature_2m_min'), i),
      tempMeanC: at(col('temperature_2m_mean'), i),
      windMaxKmh: at(col('wind_speed_10m_max'), i),
      gustMaxKmh: at(col('wind_gusts_10m_max'), i),
      freezingLevelM: h?.freezingLevelM ?? null,
      snowDepthM: h?.snowDepthM ?? null,
    };
  });

  // Report anything the API answered with an all-null column, so a post can
  // stay quiet about it rather than printing a confident zero.
  for (const name of CORE_DAILY) {
    const c = col(name);
    if (c.length === 0 || c.every((v) => v === null)) missingVariables.push(name);
  }

  return {
    model,
    coord,
    modelElevationM: typeof json.elevation === 'number' ? json.elevation : null,
    days,
    missingVariables: [...new Set(missingVariables)],
  };
}

/**
 * Collapse the hourly series to one value per day.
 *
 * Freezing level is taken at local midday — the number that decides whether the
 * afternoon falls as snow or rain — rather than a daily mean, which averages a
 * cold night into a warm day and reads colder than the mountain actually is.
 * Snow depth is the day's maximum, i.e. settled depth after the storm.
 */
export function aggregateHourly(
  hourly: RawSeries | undefined,
): Map<string, { snowDepthM: number | null; freezingLevelM: number | null }> {
  const out = new Map<string, { snowDepthM: number | null; freezingLevelM: number | null }>();
  const times = hourly?.time ?? [];
  if (times.length === 0) return out;

  const depths = (hourly?.snow_depth as (number | null)[] | undefined) ?? [];
  const levels = (hourly?.freezing_level_height as (number | null)[] | undefined) ?? [];

  const byDate = new Map<string, { depth: number[]; midday: number | null }>();
  times.forEach((t, i) => {
    const [date, clock] = t.split('T');
    if (!date) return;
    const slot = byDate.get(date) ?? { depth: [], midday: null };
    const d = depths[i];
    if (typeof d === 'number') slot.depth.push(d);
    if (clock?.startsWith('12')) {
      const l = levels[i];
      slot.midday = typeof l === 'number' ? l : null;
    }
    byDate.set(date, slot);
  });

  for (const [date, slot] of byDate) {
    out.set(date, {
      snowDepthM: slot.depth.length ? Math.max(...slot.depth) : null,
      freezingLevelM: slot.midday,
    });
  }
  return out;
}

function at(col: (number | null)[], i: number): number | null {
  const v = col[i];
  return typeof v === 'number' ? v : null;
}
