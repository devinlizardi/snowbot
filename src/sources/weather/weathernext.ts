import { BigQuery } from '@google-cloud/bigquery';
import type { Config } from '../../config.js';
import { log } from '../../logger.js';
import type { Source } from '../types.js';
import type { Coord } from './types.js';

/**
 * WeatherNext 3 via BigQuery.
 *
 * ⚠️ WeatherNext does NOT predict snowfall. The 0.1° table carries 2m
 * temperature, dewpoint, wind, cloud, pressure and *total precipitation* — and
 * nothing snow-specific. So this source returns precipitation and temperature
 * with their ensemble percentiles, and snowfall is derived downstream
 * (`deriveSnowfall`) and labelled as derived. It is never presented as a
 * modelled snow total the way ECMWF's is.
 *
 * What WeatherNext uniquely gives us is the 64-member spread. That spread, not
 * the central value, is the thing worth having: it is what turns "18cm
 * Thursday" into "18cm Thursday, and the ensemble agrees" or "…and a third of
 * the members say it misses".
 */

export type WeatherNextParams = {
  coord: Coord;
  /** Forecast horizon in hours; the 6-hourly cycles run to 360. */
  hours: number;
  ttlMinutes: number;
};

export type Percentiles = {
  mean: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
};

export type WeatherNextStep = {
  /** Valid time, UTC. */
  time: string;
  leadHours: number;
  /** °C, converted from the Kelvin the table stores. */
  temperature2mC: Percentiles;
  dewpoint2mC: Percentiles;
  /** mm, converted from the metres the table stores. */
  precipitation1hrMm: Percentiles;
  windSpeed10mMs: Percentiles;
};

export type WeatherNextForecast = {
  model: 'weathernext_3';
  coord: Coord;
  /** Which model run this came from. Every number is only as fresh as this. */
  initTime: string;
  steps: WeatherNextStep[];
  /** What the query actually cost, so Packet 15 can audit it. */
  bytesProcessed: number;
};

const PERCENTILES = ['mean', 'p10', 'p25', 'p50', 'p75', 'p90'] as const;
const VARIABLES = [
  'temperature_2m',
  'dewpoint_temperature_2m',
  'total_precipitation_1hr',
  'wind_speed_10m',
] as const;

/** A small box around the point, since geography_polygon holds cell boundaries. */
function boxAround(coord: Coord, pad = 0.03): string {
  const { lat, lon } = coord;
  const [w, e, s, n] = [lon - pad, lon + pad, lat - pad, lat + pad];
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

export function buildQuery(table: string, lookbackHours: number): string {
  const cols = VARIABLES.flatMap((v) => PERCENTILES.map((p) => `      f.${v}_${p}`)).join(',\n');
  return `
    SELECT
      t.init_time,
      f.time AS forecast_time,
      f.hours AS lead_hours,
${cols}
    FROM \`${table}\` AS t, t.forecast AS f
    WHERE
      -- Partition pruning. Without this the query scans the whole table, which
      -- is the single most expensive mistake available in this project.
      t.init_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookbackHours HOUR)
      AND t.init_time = @initTime
      -- Cluster pruning on geography.
      AND ST_INTERSECTS(t.geography_polygon, ST_GEOGFROMTEXT(@box))
      AND f.hours <= @hours
    ORDER BY f.hours ASC`.replace('@lookbackHours', String(lookbackHours));
}

/** The most recent run available, found without scanning history. */
export function buildInitTimeQuery(table: string, lookbackHours: number): string {
  return `
    SELECT MAX(init_time) AS init_time
    FROM \`${table}\`
    WHERE init_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${lookbackHours} HOUR)`;
}

export function weathernextSource(cfg: Config): Source<WeatherNextParams, WeatherNextForecast> {
  const { projectId, datasetId, table } = cfg.bigquery;
  const fq = `${projectId}.${datasetId}.${table}`;
  const maxBytes = cfg.weather.bigquery.max_bytes_billed;
  // WeatherNext initialises hourly, so a 12h window always contains a run even
  // if the most recent few are still publishing.
  const LOOKBACK_HOURS = 12;

  return {
    name: 'weathernext:bigquery',
    key: (p) => `${p.coord.lat.toFixed(3)},${p.coord.lon.toFixed(3)}:${p.hours}h`,
    ttlMinutes: (p) => p.ttlMinutes,
    async fetch(p) {
      if (!projectId || !datasetId) {
        throw new Error('GCP_PROJECT_ID / GCP_DATASET_ID are not set — cannot query WeatherNext');
      }
      const bq = new BigQuery({ projectId });

      const [initJob] = await bq.createQueryJob({
        query: buildInitTimeQuery(fq, LOOKBACK_HOURS),
        maximumBytesBilled: String(maxBytes),
      });
      const [initRows] = await initJob.getQueryResults();
      const initTime = (initRows[0] as { init_time?: { value?: string } | string } | undefined)?.init_time;
      const initValue = typeof initTime === 'string' ? initTime : initTime?.value;
      if (!initValue) {
        throw new Error(`no WeatherNext run in the last ${LOOKBACK_HOURS}h — is the subscription still live?`);
      }

      const [job] = await bq.createQueryJob({
        query: buildQuery(fq, LOOKBACK_HOURS),
        params: { initTime: initValue, box: boxAround(p.coord), hours: p.hours },
        types: { initTime: 'TIMESTAMP', box: 'STRING', hours: 'INT64' },
        maximumBytesBilled: String(maxBytes),
      });
      const [rows] = await job.getQueryResults();
      const bytes = Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);

      log.info('weathernext query', {
        initTime: initValue,
        rows: rows.length,
        megabytesProcessed: Math.round(bytes / 1e5) / 10,
      });

      return parseRows(rows as Record<string, unknown>[], p.coord, initValue, bytes);
    },
  };
}

export function parseRows(
  rows: Record<string, unknown>[],
  coord: Coord,
  initTime: string,
  bytesProcessed = 0,
): WeatherNextForecast {
  const pct = (prefix: string, row: Record<string, unknown>, convert: (n: number) => number): Percentiles => {
    const out = {} as Percentiles;
    for (const p of PERCENTILES) {
      const v = row[`${prefix}_${p}`];
      out[p] = typeof v === 'number' ? round2(convert(v)) : null;
    }
    return out;
  };

  const steps: WeatherNextStep[] = rows.map((row) => ({
    time: timeValue(row.forecast_time),
    leadHours: Number(row.lead_hours ?? 0),
    temperature2mC: pct('temperature_2m', row, kelvinToC),
    dewpoint2mC: pct('dewpoint_temperature_2m', row, kelvinToC),
    precipitation1hrMm: pct('total_precipitation_1hr', row, metresToMm),
    windSpeed10mMs: pct('wind_speed_10m', row, (n) => n),
  }));

  return { model: 'weathernext_3', coord, initTime, steps, bytesProcessed };
}

export const kelvinToC = (k: number): number => k - 273.15;
export const metresToMm = (m: number): number => m * 1000;

function timeValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'value' in v) return String((v as { value: unknown }).value);
  return '';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
