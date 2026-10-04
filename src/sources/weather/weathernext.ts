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

/**
 * The forecast query's job options. `initTime` must be a Date: the Node client
 * turns a string declared as TIMESTAMP into a parameter with a type and no
 * value, so the query became `init_time = NULL`, pruned every partition and
 * returned nothing.
 */
export function forecastJobOptions(
  table: string,
  lookbackHours: number,
  initTime: string,
  coord: Coord,
  hours: number,
  maxBytes: number,
) {
  return {
    query: buildQuery(table, lookbackHours),
    params: { initTime: new Date(initTime), box: boxAround(coord), hours },
    types: { initTime: 'TIMESTAMP', box: 'STRING', hours: 'INT64' },
    maximumBytesBilled: String(maxBytes),
  };
}

/**
 * Only the 00/06/12/18Z cycles run the full 360h; the hourly runs in between
 * stop at 48. A run shows up in the table about seven hours after its init.
 */
export const LONG_RUN_EVERY_HOURS = 6;
export const PUBLISH_LAG_HOURS = 7;
/**
 * Partition-pruning window for the forecast query. The fallback candidate can
 * be up to 19h old (7h lag + up to 6h into the cycle + one cycle back).
 */
export const LOOKBACK_HOURS = 24;
/** How long a source instance trusts the run it settled on. */
const RESOLVED_TTL_MS = 60 * 60_000;

/**
 * The run to ask for, derived from the clock instead of `SELECT MAX(init_time)`
 * (which scans ~247 MB and would also pick a 48-step hourly run): the newest
 * long cycle that should have published, then the one before it in case this
 * one is late.
 */
export function candidateInitTimes(now: Date): [string, string] {
  const cycleMs = LONG_RUN_EVERY_HOURS * 3_600_000;
  const newest = Math.floor((now.getTime() - PUBLISH_LAG_HOURS * 3_600_000) / cycleMs) * cycleMs;
  return [new Date(newest).toISOString(), new Date(newest - cycleMs).toISOString()];
}

export type QueryRunner = (
  opts: ReturnType<typeof forecastJobOptions>,
) => Promise<{ rows: Record<string, unknown>[]; bytes: number }>;

export type WeatherNextDeps = {
  /** Tests stub this; production runs the job in BigQuery. */
  runQuery?: QueryRunner;
  now?: () => Date;
};

/**
 * One instance per job. The first spot settles which run to use (trying the
 * clock's newest long cycle, then the one before); every other spot, including
 * ones already waiting concurrently, reuses that answer, so a 16-spot snapshot
 * costs 16 forecast queries and no lookups.
 */
export function weathernextSource(
  cfg: Config,
  deps: WeatherNextDeps = {},
): Source<WeatherNextParams, WeatherNextForecast> {
  const { projectId, datasetId, table } = cfg.bigquery;
  const fq = `${projectId}.${datasetId}.${table}`;
  const maxBytes = cfg.weather.bigquery.max_bytes_billed;
  const now = deps.now ?? (() => new Date());
  let resolved: { initTime: Promise<string>; at: number } | null = null;

  const runQuery: QueryRunner =
    deps.runQuery ??
    (async (opts) => {
      const bq = new BigQuery({ projectId });
      const [job] = await bq.createQueryJob(opts);
      const [rows] = await job.getQueryResults();
      const bytes = Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
      return { rows: rows as Record<string, unknown>[], bytes };
    });

  const forecast = async (initTime: string, p: WeatherNextParams) => {
    const res = await runQuery(
      forecastJobOptions(fq, LOOKBACK_HOURS, initTime, p.coord, p.hours, maxBytes),
    );
    log.info('weathernext query', {
      initTime,
      rows: res.rows.length,
      megabytesProcessed: Math.round(res.bytes / 1e5) / 10,
    });
    return res;
  };

  return {
    name: 'weathernext:bigquery',
    key: (p) => `${p.coord.lat.toFixed(3)},${p.coord.lon.toFixed(3)}:${p.hours}h`,
    ttlMinutes: (p) => p.ttlMinutes,
    async fetch(p) {
      if (!projectId || !datasetId) {
        throw new Error('GCP_PROJECT_ID / GCP_DATASET_ID are not set — cannot query WeatherNext');
      }

      const t = now();
      let first: { rows: Record<string, unknown>[]; bytes: number } | undefined;
      if (!resolved || t.getTime() - resolved.at > RESOLVED_TTL_MS) {
        const candidates = candidateInitTimes(t);
        const entry = {
          at: t.getTime(),
          initTime: (async () => {
            for (const init of candidates) {
              const res = await forecast(init, p);
              if (res.rows.length > 0) {
                first = res;
                return init;
              }
              log.warn('weathernext run not published yet — trying the previous cycle', {
                initTime: init,
              });
            }
            throw new Error(
              `no WeatherNext long run found (tried ${candidates.join(', ')}) — is the subscription still live?`,
            );
          })(),
        };
        // A failure is not remembered: the next spot tries again. (An
        // unpublished run's partition is empty, so retrying it costs 0 bytes.)
        entry.initTime.catch(() => {
          if (resolved === entry) resolved = null;
        });
        resolved = entry;
      }
      const initTime = await resolved.initTime;
      const res = first ?? (await forecast(initTime, p));
      return parseRows(res.rows, p.coord, initTime, res.bytes);
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
