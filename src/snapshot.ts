import type { Config, Destination } from './config.js';
import { optionalSecret } from './config.js';
import type { DB } from './db.js';
import type { Logger } from './logger.js';
import { cached } from './sources/_cache.js';
import type { Fetched, Source } from './sources/types.js';
import {
  buildConditions,
  WEATHERNEXT,
  type Agreement,
  type ConditionsReport,
} from './sources/weather/conditions.js';
import {
  buildSnowReport,
  DISAGREE_THRESHOLD,
  modelName,
  NARROW_BAND,
  WIDE_BAND,
  type DateWindow,
  type SnowReport,
} from './sources/weather/consensus.js';
import { crosscheckFor, type Region } from './sources/weather/crosscheck.js';
import { ecmwfAifs, ecmwfIfs, type ForecastParams } from './sources/weather/ecmwf.js';
import { utcOffsetHoursOf, type Coord, type ModelForecast } from './sources/weather/types.js';
import {
  weathernextSource,
  type WeatherNextForecast,
  type WeatherNextParams,
} from './sources/weather/weathernext.js';

/*
 * `/snapshot` — the weather at every spot the bot tracks, next 7 days, in one
 * message. Its job is to show the thing no single weather app shows: where the
 * models agree and where they don't. Snow is a low–high range across the
 * snowfall models (both ends are real modelled totals); temperature is a
 * median across those models and WeatherNext; every row carries an agreement
 * mark built from both.
 *
 *   gatherSnapshot   the only I/O: every source through `cached()`, with the
 *                    params the builder and Aspen update already use, so their
 *                    cache rows are shared
 *   composeSnapshot  pure: numbers, cells, regions, callouts
 *   renderSnapshot   pure: the Discord message, ≤2,000 chars, a 36-column
 *                    code block that doesn't scroll sideways on a phone
 *
 * No LLM: the copy is templated, so it is instant, free, and cannot invent a
 * number. `assertSnapshotHonest` checks the one rule that matters most —
 * every snow number printed is a modelled total.
 */

export const SNAPSHOT_DAYS = 7;
export const DISCORD_MAX_CHARS = 2000;
/** Widest code-block line that fits a phone without sideways scrolling. */
export const BLOCK_MAX_COLS = 36;
/** Callouts below the table. */
const MAX_CALLOUTS = 3;
/** cm. A snow callout or a split needs at least this much in some model. */
const NOTABLE_SNOW_CM = 5;
/** km/h. Median daily gust at which lifts start to hold. */
const WIND_HOLD_KMH = 70;
const OPEN_METEO_CONCURRENCY = 6;
const BIGQUERY_CONCURRENCY = 4;

const COLS = { name: 13, snow: 7, temp: 9, gust: 5 } as const;
const GLYPH: Record<Agreement, string> = { agree: '●', partly: '◐', split: '○' };
const REGION_TITLE: Record<Region, string> = {
  JP: 'JAPAN',
  CA: 'CANADA',
  US: 'USA',
  EU: 'EUROPE',
};
/** Board names are long ("Fernie Alpine Resort"); the table has 11 columns. */
const SHORT_NAMES: Record<string, string> = {
  niseko: 'Niseko',
  rusutsu: 'Rusutsu',
  hakuba: 'Hakuba',
  nozawa: 'Nozawa',
  whistler: 'Whistler',
  revelstoke: 'Revelstoke',
  banff: 'Banff/LL',
  fernie: 'Fernie',
  jackson: 'Jackson',
  'big-sky': 'Big Sky',
  'alta-snowbird': 'Snowbird',
  palisades: 'Palisades',
  chamonix: 'Chamonix',
  zermatt: 'Zermatt',
  'st-anton': 'St. Anton',
};

/* ---------------------------------------------------------------- types */

export type Spot = {
  id: string;
  /** What the table and callouts call it; ≤11 characters. */
  label: string;
  /** 'ASPEN' sits above the regions as its own row. */
  group: 'ASPEN' | Region;
  /** Which regional cross-check models cover it. */
  region: Region;
  base: Coord;
  baseElevationM: number;
  summitElevationM: number;
};

export type SpotInputs = {
  spot: Spot;
  models: ModelForecast[];
  weathernext: WeatherNextForecast | null;
  /** Display names of sources that failed for this spot. */
  missing: string[];
  /** `fetchedAt` of every value used, for the "as of" line. */
  fetchedAt: string[];
};

export type SnapshotInputs = {
  now: Date;
  timezone: string;
  aspenWindow: DateWindow;
  spots: SpotInputs[];
};

export type SnowCell =
  { kind: 'range'; lowCm: number; highCm: number } | { kind: 'rain' | 'trace' | 'dry' | 'none' };

export type SpotSnapshot = {
  spot: Spot;
  window: DateWindow;
  snow: SnowReport | null;
  conditions: ConditionsReport | null;
  cell: SnowCell;
  /** Worse of snow confidence and temperature agreement; null with no data. */
  agreement: Agreement | null;
  missing: string[];
};

export type Snapshot = {
  generatedAt: string;
  timezone: string;
  aspenLabel: string;
  spots: SpotSnapshot[];
  regions: { region: Region; pattern: string }[];
  callouts: string[];
  /** Display names of every source that contributed, in a stable order. */
  sources: string[];
  /** Sources that failed, with how many spots they failed for. */
  missing: { source: string; spots: number }[];
  /** The oldest value used, ISO UTC; null when nothing was fetched. */
  oldestFetch: string | null;
};

export type SnapshotResult = { ok: boolean; text: string; snapshot: Snapshot | null };

/* ---------------------------------------------------------------- spots */

/** Aspen first, then the board in config order. */
export function snapshotSpots(cfg: Config): Spot[] {
  const aspen: Spot = {
    id: 'aspen',
    label: 'Aspen',
    group: 'ASPEN',
    region: 'US',
    base: {
      lat: cfg.aspen.base.lat,
      lon: cfg.aspen.base.lon,
      label: 'base',
      elevationM: cfg.aspen.base.elevation_m,
    },
    baseElevationM: cfg.aspen.base.elevation_m,
    summitElevationM: cfg.aspen.summit.elevation_m,
  };
  return [aspen, ...cfg.board.map(boardSpot)];
}

function boardSpot(d: Destination): Spot {
  const short = SHORT_NAMES[d.id] ?? d.name;
  return {
    id: d.id,
    label: short.length > 11 ? short.slice(0, 10) + '…' : short,
    group: d.region,
    region: d.region,
    base: { lat: d.lat, lon: d.lon, label: 'base', elevationM: d.base_elevation_m },
    baseElevationM: d.base_elevation_m,
    summitElevationM: d.summit_elevation_m,
  };
}

/* --------------------------------------------------------------- gather */

export type SnapshotFetch = <P, R>(source: Source<P, R>, params: P) => Promise<Fetched<R>>;

export type GatherContext = { cfg: Config; db: DB; log: Logger; now: Date };

export type GatherOptions = {
  offline: boolean;
  /** Whether to ask WeatherNext at all. Defaults to `weathernextAvailable(cfg)`. */
  weathernext?: boolean;
  /** Tests answer by source name; production goes through `cached()`. */
  fetch?: SnapshotFetch;
};

/** Same gate as the Aspen update: a project id and credentials in env. */
export function weathernextAvailable(cfg: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(cfg.bigquery.projectId && optionalSecret('GOOGLE_APPLICATION_CREDENTIALS', env));
}

export async function gatherSnapshot(
  ctx: GatherContext,
  opts: GatherOptions,
): Promise<SnapshotInputs> {
  const { cfg, db, log, now } = ctx;
  const fetch: SnapshotFetch =
    opts.fetch ?? ((source, params) => cached(db, source, params, { offline: opts.offline, now }));
  const useWn = opts.weathernext ?? weathernextAvailable(cfg);
  if (!useWn) log.info('snapshot: weathernext skipped — no GCP project or credentials in env');

  const forecastDays = cfg.weather.open_meteo.forecast_days;
  const ttl = cfg.weather.cache_ttl_minutes.forecast;
  const openMeteo = pool(OPEN_METEO_CONCURRENCY);
  const bigquery = pool(BIGQUERY_CONCURRENCY);
  const wnSource = useWn ? weathernextSource(cfg) : null;

  const spots = snapshotSpots(cfg);
  const gathered = await Promise.all(
    spots.map(async (spot): Promise<SpotInputs> => {
      const missing: string[] = [];
      const fetchedAt: string[] = [];
      // Identical params to the builder, pre-rank and Aspen update, so a
      // snapshot taken after any of them is served from their cache rows.
      const fp: ForecastParams = { coord: spot.base, forecastDays, ttlMinutes: ttl };

      const modelSources = [ecmwfIfs, ecmwfAifs, ...crosscheckFor(spot.region)];
      const models = (
        await Promise.all(
          modelSources.map((src) =>
            openMeteo(async () => {
              try {
                const got = await fetch(src, fp);
                fetchedAt.push(got.fetchedAt);
                return got.value;
              } catch (err) {
                missing.push(modelName(src.name.replace(/^open-meteo:/, '')));
                log.warn('snapshot source unavailable', {
                  spot: spot.id,
                  source: src.name,
                  error: String(err),
                });
                return null;
              }
            }),
          ),
        )
      ).filter((m): m is ModelForecast => m !== null);

      let weathernext: WeatherNextForecast | null = null;
      if (wnSource) {
        const params: WeatherNextParams = {
          coord: spot.base,
          hours: forecastDays * 24,
          ttlMinutes: ttl,
        };
        weathernext = await bigquery(async () => {
          try {
            const got = await fetch(wnSource, params);
            fetchedAt.push(got.fetchedAt);
            return got.value;
          } catch (err) {
            missing.push(modelName(WEATHERNEXT));
            log.warn('snapshot source unavailable', {
              spot: spot.id,
              source: wnSource.name,
              error: String(err),
            });
            return null;
          }
        });
      }

      return { spot, models, weathernext, missing, fetchedAt };
    }),
  );

  return {
    now,
    timezone: cfg.timezone,
    aspenWindow: { start: cfg.aspen.window_start, end: cfg.aspen.window_end },
    spots: gathered,
  };
}

/* -------------------------------------------------------------- compose */

export function composeSnapshot(inputs: SnapshotInputs): Snapshot {
  const spots = inputs.spots.map((s) => composeSpot(s, inputs.now));

  const regions: Snapshot['regions'] = [];
  for (const region of ['JP', 'CA', 'US', 'EU'] as const) {
    const rows = spots.filter((s) => s.spot.group === region);
    if (rows.length) regions.push({ region, pattern: regionPattern(rows) });
  }

  const contributing = new Set<string>();
  for (const s of spots) {
    for (const m of s.snow?.asOf.contributing ?? []) contributing.add(m);
    for (const m of s.conditions?.sources ?? []) contributing.add(m);
  }
  const missing = new Map<string, number>();
  for (const name of inputs.spots.flatMap((s) => [...new Set(s.missing)])) {
    missing.set(name, (missing.get(name) ?? 0) + 1);
  }
  const fetched = inputs.spots
    .flatMap((s) => s.fetchedAt)
    .map(sqliteUtcToIso)
    .sort();

  return {
    generatedAt: inputs.now.toISOString(),
    timezone: inputs.timezone,
    aspenLabel: aspenLabel(inputs.now, inputs.timezone, inputs.aspenWindow),
    spots,
    regions,
    callouts: pickCallouts(spots),
    sources: SOURCE_ORDER.filter((m) => contributing.has(m)).map(modelName),
    missing: [...missing].map(([source, spots]) => ({ source, spots })),
    oldestFetch: fetched[0] ?? null,
  };
}

const SOURCE_ORDER = [
  'ecmwf_ifs025',
  'ecmwf_aifs025',
  'icon_global',
  'icon_eu',
  'gfs_seamless',
  'ncep_nam_conus',
  WEATHERNEXT,
];

function composeSpot(input: SpotInputs, now: Date): SpotSnapshot {
  const { spot, models } = input;
  const offset = utcOffsetHoursOf(models, spot.base.lon);
  const start = new Date(now.getTime() + offset * 3600_000).toISOString().slice(0, 10);
  const window: DateWindow = { start, end: addDays(start, SNAPSHOT_DAYS - 1) };

  if (models.length === 0) {
    return {
      spot,
      window,
      snow: null,
      conditions: null,
      cell: { kind: 'none' },
      agreement: null,
      missing: input.missing,
    };
  }

  const wn = input.weathernext ? { weathernext: input.weathernext } : {};
  const snow = buildSnowReport({
    window,
    base: models,
    ...wn,
    utcOffsetHours: offset,
    baseElevationM: spot.baseElevationM,
    summitElevationM: spot.summitElevationM,
  });
  const conditions = buildConditions({
    window,
    base: models,
    ...wn,
    utcOffsetHours: offset,
    baseElevationM: spot.baseElevationM,
    summitElevationM: spot.summitElevationM,
  });

  return {
    spot,
    window,
    snow,
    conditions,
    cell: snowCell(snow, conditions),
    agreement: worst([fromConfidence(snow.confidence), conditions.tempAgreement]),
    missing: input.missing,
  };
}

/** A range of real model totals when anything falls as snow; otherwise what does fall. */
export function snowCell(snow: SnowReport, c: ConditionsReport): SnowCell {
  const totals = snow.models.map((m) => Math.round(m.totalCm));
  if (totals.length && Math.max(...totals) >= 1) {
    return { kind: 'range', lowCm: Math.min(...totals), highCm: Math.max(...totals) };
  }
  if (c.rainDays.length) return { kind: 'rain' };
  if (c.precipMm !== null && c.precipMm >= 1) return { kind: 'trace' };
  return { kind: 'dry' };
}

function fromConfidence(c: SnowReport['confidence']): Agreement {
  return c === 'high' ? 'agree' : c === 'medium' ? 'partly' : 'split';
}

const RANK: Record<Agreement, number> = { agree: 0, partly: 1, split: 2 };
function worst(xs: (Agreement | null)[]): Agreement | null {
  const known = xs.filter((x): x is Agreement => x !== null);
  if (!known.length) return null;
  return known.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** A few words for a region, from a fixed vocabulary — never free text. */
export function regionPattern(rows: readonly SpotSnapshot[]): string {
  const live = rows.filter((r) => r.conditions !== null);
  if (!live.length) return 'no data';
  const half = live.length / 2;
  const snowy = live.filter((r) => r.cell.kind === 'range' && r.cell.highCm >= NOTABLE_SNOW_CM);
  const rainy = live.filter((r) => (r.conditions?.rainDays.length ?? 0) > 0);
  const upHigh = live.filter((r) => r.conditions?.snowUpHigh);
  const split = live.filter((r) => r.agreement === 'split');

  const wet =
    snowy.length >= half
      ? 'snowing'
      : snowy.length
        ? 'snow in spots'
        : upHigh.length
          ? 'snow up high'
          : rainy.length >= half
            ? 'wet'
            : rainy.length
              ? 'showers'
              : 'dry';

  if (split.length >= half) return `${wet}, models split`;
  const highs = live
    .map((r) => r.conditions?.tempHighC?.value)
    .filter((v): v is number => v !== undefined);
  const mid = highs.sort((a, b) => a - b)[Math.floor(highs.length / 2)];
  if (mid === undefined) return wet;
  const feel = mid >= 15 ? 'warm' : mid >= 5 ? 'mild' : mid >= -5 ? 'cold' : 'deep cold';
  return `${wet}, ${feel}`;
}

/** Up to three, most useful first. Every number in them is a field. */
export function pickCallouts(rows: readonly SpotSnapshot[]): string[] {
  const out: string[] = [];
  const named = new Set<string>();

  // 1. The split: the models telling different stories about real snow.
  const splits = rows
    .filter(
      (r) =>
        r.snow !== null &&
        r.snow.models.length >= 2 &&
        r.snow.agreement !== null &&
        r.snow.agreement < DISAGREE_THRESHOLD &&
        Math.max(...r.snow.models.map((m) => m.totalCm)) >= NOTABLE_SNOW_CM,
    )
    .sort((a, b) => (a.snow!.agreement ?? 1) - (b.snow!.agreement ?? 1));
  const split = splits[0];
  if (split?.snow) {
    const sorted = [...split.snow.models].sort((a, b) => b.totalCm - a.totalCm);
    const hi = sorted[0]!;
    const lo = sorted[sorted.length - 1]!;
    out.push(
      `⚠️ **${split.spot.label} is a coin flip** — ${modelName(hi.model)} ${Math.round(hi.totalCm)}cm, ` +
        `${modelName(lo.model)} ${Math.round(lo.totalCm)}cm${ensemblePhrase(split.snow)}.`,
    );
    named.add(split.spot.id);
  }

  // 2. The most snow the models are willing to stand behind.
  const snowy = rows
    .filter(
      (r) =>
        !named.has(r.spot.id) &&
        r.cell.kind === 'range' &&
        r.cell.highCm >= NOTABLE_SNOW_CM &&
        r.agreement !== 'split',
    )
    .sort((a, b) => cellHigh(b) - cellHigh(a));
  const best = snowy[0];
  if (best && best.cell.kind === 'range') {
    const words = best.agreement === 'agree' ? 'models agree' : 'models roughly agree';
    out.push(`❄️ **Most snow: ${best.spot.label}** — ${rangeText(best.cell)}, ${words}.`);
    named.add(best.spot.id);
  }

  // 3. Snow up high: the freezing level dipping below a summit on a wet day.
  const high = rows
    .filter((r) => !named.has(r.spot.id) && r.conditions?.snowUpHigh)
    .sort(
      (a, b) =>
        b.spot.summitElevationM -
        b.conditions!.snowUpHigh!.freezingLevelM -
        (a.spot.summitElevationM - a.conditions!.snowUpHigh!.freezingLevelM),
    )[0];
  if (high?.conditions?.snowUpHigh) {
    const s = high.conditions.snowUpHigh;
    out.push(
      `🏔️ **Snow up high at ${high.spot.label}** — freezing level down to ${metres(s.freezingLevelM)} ` +
        `${weekday(s.date)} (summit ${metres(high.spot.summitElevationM)}).`,
    );
    named.add(high.spot.id);
  }

  // 4. Snow in the table but rain at the base too — the table can't show both.
  const mixed = rows.filter(
    (r) => r.cell.kind === 'range' && (r.conditions?.rainDays.length ?? 0) > 0,
  );
  if (mixed.length) {
    const list = mixed
      .slice(0, 3)
      .map((r) => `${r.spot.label} (${r.conditions!.rainDays.map(weekday).join(', ')})`)
      .join(', ');
    out.push(`🌧️ **Rain at the base too:** ${list}.`);
  }

  // 5. Wind that holds lifts.
  const windy = rows
    .filter((r) => (r.conditions?.peakGust?.kmh ?? 0) >= WIND_HOLD_KMH)
    .sort((a, b) => b.conditions!.peakGust!.kmh - a.conditions!.peakGust!.kmh)[0];
  if (windy?.conditions?.peakGust) {
    const g = windy.conditions.peakGust;
    out.push(
      `💨 **${windy.spot.label} gusts to ${g.kmh} km/h ${weekday(g.date)}** — lift-hold territory.`,
    );
  }

  if (!out.length) {
    out.push('🧊 **Nothing standing out** — no big snow, no model splits, no lift-holding wind.');
  }
  return out.slice(0, MAX_CALLOUTS);
}

function ensemblePhrase(r: SnowReport): string {
  if (r.ensembleBand === null) return '';
  if (r.ensembleBand.relativeWidth >= WIDE_BAND) return ", and WeatherNext's 64 runs are wide open";
  if (r.ensembleBand.relativeWidth <= NARROW_BAND)
    return ", though WeatherNext's 64 runs are tight";
  return ", and WeatherNext's 64 runs don't settle it";
}

function cellHigh(r: SpotSnapshot): number {
  return r.cell.kind === 'range' ? r.cell.highCm : 0;
}

function aspenLabel(now: Date, timezone: string, w: DateWindow): string {
  const today = localDate(now, timezone);
  if (today < w.start) return `ASPEN · ${daysBetween(today, w.start)}d`;
  if (today <= w.end) return 'ASPEN · now';
  return 'ASPEN';
}

/* --------------------------------------------------------------- render */

export function renderSnapshot(s: Snapshot): string {
  const block = renderTable(s);
  const live = s.spots.filter((r) => r.snow !== null).length;
  const head = `❄️ **Snapshot** · next ${SNAPSHOT_DAYS} days · ${live} spot${live === 1 ? '' : 's'} · ${s.sources.length} source${s.sources.length === 1 ? '' : 's'}`;
  const foot = footer(s);

  const callouts = [...s.callouts];
  const compose = () => [head, '```', block, '```', ...callouts, foot].join('\n');
  let text = compose();
  while (text.length > DISCORD_MAX_CHARS && callouts.length) {
    callouts.pop();
    text = compose();
  }
  return text.length > DISCORD_MAX_CHARS ? text.slice(0, DISCORD_MAX_CHARS - 1) + '…' : text;
}

export function renderTable(s: Snapshot): string {
  const lines: string[] = [];
  lines.push(
    ''.padEnd(COLS.name) +
      'SNOW 7d'.padStart(COLS.snow) +
      '°C lo/hi'.padStart(COLS.temp) +
      'GUST'.padStart(COLS.gust),
  );
  const aspen = s.spots.find((r) => r.spot.group === 'ASPEN');
  if (aspen) lines.push(row(s.aspenLabel, aspen));
  for (const { region, pattern } of s.regions) {
    lines.push(clip(`${REGION_TITLE[region]} · ${pattern}`));
    for (const r of s.spots.filter((x) => x.spot.group === region)) {
      lines.push(row(` ${r.spot.label}`, r));
    }
  }
  return lines.join('\n');
}

function row(label: string, r: SpotSnapshot): string {
  const c = r.conditions;
  const lo = c?.tempLowC?.value;
  const hi = c?.tempHighC?.value;
  const temp = lo !== undefined && hi !== undefined ? `${Math.round(lo)}/${Math.round(hi)}` : '—';
  const gust = c?.peakGust ? String(c.peakGust.kmh) : '—';
  const glyph = r.agreement ? GLYPH[r.agreement] : '';
  return (
    label.slice(0, COLS.name - 1).padEnd(COLS.name) +
    cellText(r.cell).padStart(COLS.snow) +
    temp.padStart(COLS.temp) +
    gust.padStart(COLS.gust) +
    (glyph ? ` ${glyph}` : '')
  ).trimEnd();
}

export function cellText(cell: SnowCell): string {
  switch (cell.kind) {
    case 'range': {
      const t = rangeText(cell);
      // Three-digit totals drop the unit to keep the column; the header says cm.
      return t.length <= COLS.snow ? t : t.replace(/cm$/, '');
    }
    case 'none':
      return '—';
    default:
      return cell.kind;
  }
}

function rangeText(cell: { lowCm: number; highCm: number }): string {
  return cell.lowCm === cell.highCm ? `${cell.highCm}cm` : `${cell.lowCm}–${cell.highCm}cm`;
}

function footer(s: Snapshot): string {
  const bits = ['ranges = low–high across models', '● agree ◐ partly ○ split'];
  if (s.sources.length) bits.push(s.sources.join(', '));
  bits.push('°C, km/h at the base');
  if (s.oldestFetch) bits.push(`as of ${clock(new Date(s.oldestFetch), s.timezone)}`);
  if (s.missing.length) {
    const all = s.spots.length;
    const list = s.missing.map((m) =>
      m.spots >= all ? m.source : `${m.source} at ${m.spots} spot${m.spots === 1 ? '' : 's'}`,
    );
    bits.push(`missing: ${list.join(', ')}`);
  }
  return `-# ${bits.join(' · ')}`;
}

function clip(line: string): string {
  return line.length <= BLOCK_MAX_COLS ? line : line.slice(0, BLOCK_MAX_COLS - 1) + '…';
}

/* ---------------------------------------------------------------- audit */

/**
 * The invariant the snapshot exists to keep: every snow number it prints is a
 * real modelled total for that spot, and nothing derived from WeatherNext ever
 * appears as one. Throws; `runSnapshot` calls it before replying.
 */
export function assertSnapshotHonest(s: Snapshot, text: string): void {
  const allowed = new Set<number>();
  for (const r of s.spots) {
    const totals = new Set((r.snow?.models ?? []).map((m) => Math.round(m.totalCm)));
    totals.forEach((t) => allowed.add(t));
    if (r.cell.kind === 'range') {
      for (const n of [r.cell.lowCm, r.cell.highCm]) {
        if (!totals.has(n)) {
          throw new Error(`${r.spot.id}: snow cell prints ${n}cm, which is not a modelled total`);
        }
      }
    }
  }
  for (const [, n] of text.matchAll(/(\d+)cm\b/g)) {
    if (!allowed.has(Number(n))) {
      throw new Error(`snapshot prints ${n}cm, which is not any spot's modelled total`);
    }
  }
}

/* ------------------------------------------------------------------ run */

export const SNAPSHOT_UNAVAILABLE =
  "Couldn't reach any forecast source just now — try `/snapshot` again in a few minutes.";

/** Gather, compose, render, audit. What `/snapshot` and the CLI job both call. */
export async function runSnapshot(
  ctx: GatherContext,
  opts: GatherOptions,
): Promise<SnapshotResult> {
  const started = Date.now();
  const inputs = await gatherSnapshot(ctx, opts);
  const snapshot = composeSnapshot(inputs);
  const live = snapshot.spots.filter((r) => r.snow !== null).length;
  if (live === 0) {
    ctx.log.warn('snapshot: no spot had any forecast');
    return { ok: false, text: SNAPSHOT_UNAVAILABLE, snapshot };
  }
  const text = renderSnapshot(snapshot);
  assertSnapshotHonest(snapshot, text);
  ctx.log.info('snapshot', {
    spots: live,
    sources: snapshot.sources,
    missing: snapshot.missing,
    chars: text.length,
    ms: Date.now() - started,
  });
  return { ok: true, text, snapshot };
}

/* -------------------------------------------------------------- helpers */

/** At most `n` of the wrapped calls in flight at once. */
export function pool(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekday(date: string): string {
  return DOW[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function metres(m: number): string {
  return `${(Math.round(m / 100) * 100).toLocaleString('en-US')}m`;
}

function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function clock(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
  return parts.replace(',', '');
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `source_cache` stores 'YYYY-MM-DD HH:MM:SS' in UTC. */
function sqliteUtcToIso(s: string): string {
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
}
