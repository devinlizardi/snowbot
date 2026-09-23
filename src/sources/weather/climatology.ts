import type { Config, Destination } from '../../config.js';
import type { DB } from '../../db.js';
import type { Logger } from '../../logger.js';
import { cached } from '../_cache.js';
import { archive } from './archive.js';
import type { Coord } from './types.js';

/**
 * What the snow usually does during a trip window — the answer to "is this a
 * good week to be there?" when the trip is months past any forecast.
 *
 * Built from Open-Meteo's historical archive (ERA5 reanalysis): one request per
 * past season at the resort base, each cached for a year because a finished
 * season never changes. ERA5 is a ~25 km grid, so it smooths the mountains
 * away and undercounts how much falls — often badly. Its *amounts* are
 * therefore never exposed here. What survives the bias is:
 *
 *   - how often it snows (days with new snow, seasons that delivered)
 *   - ratios against itself (this window vs the season average, this season
 *     to date vs normal, which month peaks)
 *
 * The headline cm figure comes from the resort-reported average instead
 * (`resortSnowLookup` in lookup.ts). The two together are the dossier's snow
 * story when the forecast cannot see the trip yet.
 */

export type SeasonSpan = { start: string; end: string };

export type ArchiveDays = { date: string; snowfallCm: number | null }[];

export type SeasonRecord = {
  /** The calendar year the season starts in: 2014 is Dec 2014 – Apr 2015. */
  season: number;
  days: ArchiveDays;
};

export type Climatology = {
  source: 'open-meteo:archive';
  /** Seasons that had usable data for the window. */
  seasons: number;
  /** "2006–07" */
  firstSeason: string;
  lastSeason: string;
  windowDays: number;
  /** A day counts as a snow day at or above this much modelled new snow. */
  snowDayCm: number;
  /** Median count of snow days inside the window across the seasons. */
  typicalSnowDays: number;
  /** Seasons in which at least one day of the window saw new snow. */
  seasonsWithSnow: number;
  /** Seasons in which at least half the window's days saw new snow. */
  seasonsHalfSnowy: number;
  /** Window's daily snowfall rate over the season's, pooled across seasons. 1.2 = 20% snowier. */
  vsSeasonRatio: number | null;
  /** Same thing as a whole percentage, signed: 20 means "20% snowier than an average stretch". */
  vsSeasonPct: number | null;
  /** The snowiest month of the season by daily rate, e.g. "February". */
  peakMonth: string | null;
  /** The month the window starts in, and where it ranks (1 = snowiest) among the season's months. */
  windowMonth: string;
  windowMonthRank: number | null;
  seasonMonths: number;
  /** The season this window delivered most in, and least, with their snow-day counts. */
  bestSeason: { season: string; snowDays: number } | null;
  quietestSeason: { season: string; snowDays: number } | null;
  /** Only once the current season has started: snow so far against the same span in past seasons. */
  seasonToDate: { throughDate: string; pctOfNormal: number } | null;
  /** Always travels with the numbers so no reader mistakes them for a forecast. */
  caveat: string;
};

export const CLIMATOLOGY_CAVEAT =
  'Historical pattern from reanalysis, not a forecast. Counts and ratios only — the grid undercounts mountain snow, so no totals are taken from it.';

/** Fewer than this and the ratios are noise. */
const MIN_SEASONS = 5;
/** A day with data counts toward a season only if the window is mostly covered. */
const MIN_COVERAGE = 0.5;
/** Season-to-date needs a week in before it means anything. */
const MIN_SEASON_DAYS = 7;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/* ------------------------------------------------------------ seasons */

const wraps = (span: SeasonSpan) => span.start > span.end;

/** The season a date belongs to (or the one it would, if it sits between seasons). */
export function seasonOf(date: string, span: SeasonSpan): number {
  const y = Number(date.slice(0, 4));
  if (!wraps(span)) return y;
  return date.slice(5) >= span.start ? y : y - 1;
}

export function seasonDates(season: number, span: SeasonSpan): { start: string; end: string } {
  return {
    start: `${season}-${span.start}`,
    end: `${wraps(span) ? season + 1 : season}-${span.end}`,
  };
}

/** The most recent season whose last day is before `today`. */
export function lastCompleteSeason(today: string, span: SeasonSpan): number {
  let s = seasonOf(today, span);
  while (seasonDates(s, span).end >= today) s -= 1;
  return s;
}

export function seasonLabel(season: number): string {
  return `${season}–${String(season + 1).slice(2)}`;
}

/** Move a date from one season to the same MM-DD in another; null for a Feb 29 with no twin. */
export function shiftToSeason(date: string, from: number, to: number): string | null {
  const y = Number(date.slice(0, 4)) + (to - from);
  const out = `${y}${date.slice(4)}`;
  const t = Date.parse(`${out}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== out) return null;
  return out;
}

function datesIn(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); ; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > end) break;
    out.push(d);
  }
  return out;
}

/* ------------------------------------------------------------ summary */

export type ClimatologyInput = {
  window: { start: string; end: string };
  span: SeasonSpan;
  seasons: SeasonRecord[];
  /** The season in progress, when there is one: its days so far. */
  current?: SeasonRecord | null;
  snowDayCm: number;
};

type SeasonStats = {
  season: number;
  windowTotal: number;
  windowLen: number;
  snowDays: number;
  seasonTotal: number;
  seasonLen: number;
};

/** Pure. Everything the dossier and the ranking know about history comes from here. */
export function summarizeClimatology(input: ClimatologyInput): Climatology | null {
  const { window, span, snowDayCm } = input;
  const tripSeason = seasonOf(window.start, span);
  const windowDates = datesIn(window.start, window.end);
  const windowDays = windowDates.length;

  const stats: SeasonStats[] = [];
  const monthly = new Map<number, { total: number; days: number }>();

  for (const rec of input.seasons) {
    const byDate = new Map(rec.days.map((d) => [d.date, d.snowfallCm]));
    const { start, end } = seasonDates(rec.season, span);

    let seasonTotal = 0;
    let seasonLen = 0;
    for (const d of rec.days) {
      if (d.date < start || d.date > end || d.snowfallCm === null) continue;
      seasonTotal += d.snowfallCm;
      seasonLen += 1;
      const m = Number(d.date.slice(5, 7));
      const b = monthly.get(m) ?? { total: 0, days: 0 };
      b.total += d.snowfallCm;
      b.days += 1;
      monthly.set(m, b);
    }

    let windowTotal = 0;
    let windowLen = 0;
    let snowDays = 0;
    for (const d of windowDates) {
      const twin = shiftToSeason(d, tripSeason, rec.season);
      const v = twin === null ? undefined : byDate.get(twin);
      if (v === undefined || v === null) continue;
      windowTotal += v;
      windowLen += 1;
      if (v >= snowDayCm) snowDays += 1;
    }
    if (windowLen < windowDays * MIN_COVERAGE || seasonLen === 0) continue;
    stats.push({ season: rec.season, windowTotal, windowLen, snowDays, seasonTotal, seasonLen });
  }

  if (stats.length < MIN_SEASONS) return null;
  stats.sort((a, b) => a.season - b.season);

  const snowDayCounts = stats.map((s) => s.snowDays);
  const halfway = Math.ceil(windowDays / 2);

  const windowRate =
    stats.reduce((a, s) => a + s.windowTotal, 0) / stats.reduce((a, s) => a + s.windowLen, 0);
  const seasonRate =
    stats.reduce((a, s) => a + s.seasonTotal, 0) / stats.reduce((a, s) => a + s.seasonLen, 0);
  const ratio = seasonRate > 0 ? round2(windowRate / seasonRate) : null;

  const rates = [...monthly.entries()]
    .filter(([, b]) => b.days > 0)
    .map(([m, b]) => ({ m, rate: b.total / b.days }))
    .sort((a, b) => b.rate - a.rate);
  const windowMonthNum = Number(window.start.slice(5, 7));
  const rankIdx = rates.findIndex((r) => r.m === windowMonthNum);

  const byTotal = [...stats].sort(
    (a, b) => b.windowTotal / b.windowLen - a.windowTotal / a.windowLen,
  );
  const best = byTotal[0]!;
  const quiet = byTotal[byTotal.length - 1]!;

  return {
    source: 'open-meteo:archive',
    seasons: stats.length,
    firstSeason: seasonLabel(stats[0]!.season),
    lastSeason: seasonLabel(stats[stats.length - 1]!.season),
    windowDays,
    snowDayCm,
    typicalSnowDays: median(snowDayCounts),
    seasonsWithSnow: stats.filter((s) => s.snowDays >= 1).length,
    seasonsHalfSnowy: stats.filter((s) => s.snowDays >= halfway).length,
    vsSeasonRatio: ratio,
    vsSeasonPct: ratio === null ? null : Math.round((ratio - 1) * 100),
    peakMonth: rates.length ? MONTHS[rates[0]!.m - 1]! : null,
    windowMonth: MONTHS[windowMonthNum - 1]!,
    windowMonthRank: rankIdx === -1 ? null : rankIdx + 1,
    seasonMonths: rates.length,
    bestSeason: { season: seasonLabel(best.season), snowDays: best.snowDays },
    quietestSeason: { season: seasonLabel(quiet.season), snowDays: quiet.snowDays },
    seasonToDate: seasonToDate(input),
    caveat: CLIMATOLOGY_CAVEAT,
  };
}

/** This season so far against the same span of every past season, as a percentage of their mean. */
function seasonToDate(input: ClimatologyInput): Climatology['seasonToDate'] {
  const cur = input.current;
  if (!cur) return null;
  const { start } = seasonDates(cur.season, input.span);
  const have = cur.days.filter((d) => d.date >= start && d.snowfallCm !== null);
  if (have.length < MIN_SEASON_DAYS) return null;
  const through = have[have.length - 1]!.date;
  const total = have.reduce((a, d) => a + (d.snowfallCm ?? 0), 0);

  const normals: number[] = [];
  for (const rec of input.seasons) {
    const s = seasonDates(rec.season, input.span).start;
    const e = shiftToSeason(through, cur.season, rec.season);
    if (!e) continue;
    const span = rec.days.filter((d) => d.date >= s && d.date <= e && d.snowfallCm !== null);
    if (span.length < have.length * MIN_COVERAGE) continue;
    normals.push(span.reduce((a, d) => a + (d.snowfallCm ?? 0), 0));
  }
  if (normals.length < MIN_SEASONS) return null;
  const normal = normals.reduce((a, b) => a + b, 0) / normals.length;
  if (normal <= 0) return null;
  return { throughDate: through, pctOfNormal: Math.round((total / normal) * 100) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------- fetch */

export type ClimatologyContext = {
  cfg: Config;
  db: DB;
  now: Date;
  log: Pick<Logger, 'warn' | 'info'>;
};

export type ClimatologyOptions = {
  offline?: boolean;
  /** Wait after every live archive request. Open-Meteo's free tier is 600
   *  weighted calls a minute and one season is ~10 of them, so the first
   *  backfill of the whole board has to be paced; cache hits are free. */
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Fetch the past seasons (and the current one, if it has started) at the
 * resort base and summarise them for `window`. Null when there isn't enough
 * history to say anything — the dossier then says so in words.
 */
export async function fetchClimatology(
  ctx: ClimatologyContext,
  dest: Pick<Destination, 'id' | 'lat' | 'lon' | 'base_elevation_m'>,
  window: { start: string; end: string },
  opts: ClimatologyOptions = {},
): Promise<Climatology | null> {
  const { cfg, db, now, log } = ctx;
  const span = cfg.expedition.season;
  const c = cfg.weather.climatology;
  const pace = opts.paceMs ?? c.pace_ms;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const get = { offline: opts.offline ?? false, now };
  const coord: Coord = {
    lat: dest.lat,
    lon: dest.lon,
    label: 'base',
    elevationM: dest.base_elevation_m,
  };

  const today = now.toISOString().slice(0, 10);
  const last = Math.min(seasonOf(window.start, span) - 1, lastCompleteSeason(today, span));
  const seasons: SeasonRecord[] = [];
  for (let s = last - c.seasons + 1; s <= last; s += 1) {
    const range = seasonDates(s, span);
    try {
      const got = await cached(
        db,
        archive,
        { coord, ...range, ttlMinutes: cfg.weather.cache_ttl_minutes.climatology },
        get,
      );
      seasons.push({ season: s, days: got.value.days });
      if (!got.cached && pace > 0) await sleep(pace);
    } catch (err) {
      log.warn('climatology season unavailable', {
        destination: dest.id,
        season: seasonLabel(s),
        error: String(err),
      });
    }
  }

  let current: SeasonRecord | null = null;
  const cur = seasonOf(today, span);
  const curRange = seasonDates(cur, span);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (today >= curRange.start && today <= curRange.end && yesterday >= curRange.start) {
    try {
      const got = await cached(
        db,
        archive,
        {
          coord,
          start: curRange.start,
          end: yesterday,
          ttlMinutes: cfg.weather.cache_ttl_minutes.archive,
        },
        get,
      );
      current = { season: cur, days: got.value.days };
    } catch (err) {
      log.warn('season-to-date unavailable', { destination: dest.id, error: String(err) });
    }
  }

  return summarizeClimatology({ window, span, seasons, current, snowDayCm: c.snow_day_cm });
}
