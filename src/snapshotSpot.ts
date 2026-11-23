import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Logger } from './logger.js';
import { passCheck, type PassCheck } from './passCheck.js';
import {
  addDays,
  clip,
  clock,
  composeSnapshot,
  DISCORD_MAX_CHARS,
  GLYPH,
  gatherSnapshot,
  metres,
  rangeText,
  SNAPSHOT_DAYS,
  snapshotSpots,
  sqliteUtcToIso,
  weekday,
  type GatherOptions,
  type SnapshotFetch,
  type Spot,
  type SpotSnapshot,
} from './snapshot.js';
import { cached } from './sources/_cache.js';
import type { PassAccess } from './sources/lookup.js';
import { archive, trailingWeek } from './sources/weather/archive.js';
import { modelName, NARROW_BAND, WIDE_BAND } from './sources/weather/consensus.js';
import type { ModelForecast, ObservedSnow } from './sources/weather/types.js';

/*
 * `/snapshot spot:<id>` — one spot, day by day. Same sources and the same
 * cache rows as the board-wide snapshot; adds what fell last week (the ERA5
 * archive) and, when the pass lookup has already answered, the pass line.
 * Templated, no LLM, and audited like the snapshot: every cm printed is a
 * modelled value or the archive's.
 */

export type SpotDay = {
  date: string;
  /** Low–high of the models' snowfall that day, cm; null when none had a value. */
  snow: { lowCm: number; highCm: number } | null;
  tempLowC: number | null;
  tempHighC: number | null;
  gustKmh: number | null;
  freezingLevelM: number | null;
};

export type SpotDetail = {
  row: SpotSnapshot;
  days: SpotDay[];
  observed: ObservedSnow | null;
  pass: PassCheck | null;
  sources: string[];
  oldestFetch: string | null;
  timezone: string;
};

export type SpotDetailContext = { cfg: Config; db: DB; log: Logger; now: Date };

export type SpotDetailOptions = GatherOptions & {
  /** What the pass lookup said, if it has answered before. Never fetched here. */
  passAccess?: PassAccess | null;
};

export const SPOT_UNKNOWN = (id: string) =>
  `"${id}" isn't a spot the bot tracks — try one from the list.`;

export async function runSpotSnapshot(
  ctx: SpotDetailContext,
  spotId: string,
  opts: SpotDetailOptions,
): Promise<{ ok: boolean; text: string; detail: SpotDetail | null }> {
  const spot = snapshotSpots(ctx.cfg).find((s) => s.id === spotId);
  if (!spot) return { ok: false, text: SPOT_UNKNOWN(spotId), detail: null };

  const inputs = await gatherSnapshot(ctx, { ...opts, only: [spot.id] });
  const input = inputs.spots[0]!;
  const row = composeSnapshot(inputs).spots[0]!;
  if (row.snow === null) {
    return {
      ok: false,
      text: `Couldn't reach any forecast for ${spot.label} just now — try again in a few minutes.`,
      detail: null,
    };
  }

  const fetch: SnapshotFetch =
    opts.fetch ??
    ((source, params) => cached(ctx.db, source, params, { offline: opts.offline, now: ctx.now }));
  let observed: ObservedSnow | null = null;
  const fetchedAt = [...input.fetchedAt];
  try {
    const got = await fetch(archive, {
      coord: spot.base,
      ...trailingWeek(ctx.now),
      ttlMinutes: ctx.cfg.weather.cache_ttl_minutes.archive,
    });
    observed = got.value;
    fetchedAt.push(got.fetchedAt);
  } catch (err) {
    ctx.log.warn('spot snapshot: archive unavailable', { spot: spot.id, error: String(err) });
  }

  const pass =
    spot.id === 'aspen' || ctx.cfg.group.pass === 'none'
      ? null
      : opts.passAccess
        ? passCheck({ name: spot.label }, row.window, opts.passAccess, ctx.cfg.group.pass, {
            checkDayLimit: false,
          })
        : null;

  const detail: SpotDetail = {
    row,
    days: spotDays(input.models, row),
    observed,
    pass,
    sources: [...(row.snow.asOf.contributing ?? []), ...(row.conditions?.sources ?? [])]
      .filter((m, i, a) => a.indexOf(m) === i)
      .map(modelName),
    oldestFetch: fetchedAt.map(sqliteUtcToIso).sort()[0] ?? null,
    timezone: ctx.cfg.timezone,
  };
  const text = renderSpotDetail(detail);
  assertSpotHonest(detail, text);
  return { ok: true, text, detail };
}

/* -------------------------------------------------------------- compose */

export function spotDays(models: readonly ModelForecast[], row: SpotSnapshot): SpotDay[] {
  const out: SpotDay[] = [];
  for (let i = 0; i < SNAPSHOT_DAYS; i += 1) {
    const date = addDays(row.window.start, i);
    const day = (m: ModelForecast) => m.days.find((d) => d.date === date);
    const snowByModel = row.snow?.days.find((d) => d.date === date)?.base ?? {};
    const snow = Object.values(snowByModel)
      .filter((v): v is number => v !== null)
      .map(Math.round);
    out.push({
      date,
      snow: snow.length ? { lowCm: Math.min(...snow), highCm: Math.max(...snow) } : null,
      tempLowC: median(models.map((m) => day(m)?.tempMinC)),
      tempHighC: median(models.map((m) => day(m)?.tempMaxC)),
      gustKmh: median(models.map((m) => day(m)?.gustMaxKmh)),
      freezingLevelM: median(models.map((m) => day(m)?.freezingLevelM)),
    });
  }
  return out;
}

function median(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/* --------------------------------------------------------------- render */

const COLS = { day: 7, snow: 7, temp: 9, gust: 5, frz: 7 } as const;

export function renderSpotDetail(d: SpotDetail): string {
  const { row } = d;
  const spot = row.spot;
  const agree = row.agreement
    ? ` · ${GLYPH[row.agreement]} models ${row.agreement === 'agree' ? 'agree' : row.agreement === 'partly' ? 'partly agree' : 'split'}`
    : '';
  const head = `❄️ **${spot.label}** · next ${SNAPSHOT_DAYS} days${agree}`;

  const lines = [
    ''.padEnd(COLS.day) +
      'SNOW'.padStart(COLS.snow) +
      '°C lo/hi'.padStart(COLS.temp) +
      'GUST'.padStart(COLS.gust) +
      'FRZ m'.padStart(COLS.frz),
  ];
  for (const day of d.days) {
    const label = `${weekday(day.date)} ${day.date.slice(8)}`;
    const snow = day.snow ? rangeText(day.snow) : '—';
    const temp =
      day.tempLowC !== null && day.tempHighC !== null
        ? `${Math.round(day.tempLowC)}/${Math.round(day.tempHighC)}`
        : '—';
    const gust = day.gustKmh !== null ? String(Math.round(day.gustKmh)) : '—';
    const frz =
      day.freezingLevelM !== null ? String(Math.round(day.freezingLevelM / 100) * 100) : '—';
    lines.push(
      clip(
        label.padEnd(COLS.day) +
          (snow.length <= COLS.snow ? snow : snow.replace(/cm$/, '')).padStart(COLS.snow) +
          temp.padStart(COLS.temp) +
          gust.padStart(COLS.gust) +
          frz.padStart(COLS.frz),
      ),
    );
  }

  const out = [head, '```', lines.join('\n'), '```'];
  const totals = row.snow?.models ?? [];
  if (totals.length) {
    out.push(
      `**${SNAPSHOT_DAYS}-day totals:** ` +
        [...totals]
          .sort((a, b) => b.totalCm - a.totalCm)
          .map((m) => `${modelName(m.model)} ${Math.round(m.totalCm)}cm`)
          .join(' · '),
    );
  }
  out.push(freezingLine(d));
  out.push(weathernextLine(d));
  out.push(
    d.observed
      ? `**Fell last 7 days:** ${Math.round(d.observed.trailing7dCm)}cm, per the ERA5 archive (it undercounts mountain snow).`
      : '**Fell last 7 days:** archive unavailable.',
  );
  if (d.pass) out.push(`🎟️ ${d.pass.summary}`);
  const bits = [
    '°C, km/h, freezing level at the base point',
    `base ${metres(spot.baseElevationM)}`,
  ];
  if (d.sources.length) bits.push(d.sources.join(', '));
  if (d.oldestFetch) bits.push(`as of ${clock(new Date(d.oldestFetch), d.timezone)}`);
  out.push(`-# ${bits.join(' · ')}`);

  const text = out.join('\n');
  return text.length > DISCORD_MAX_CHARS ? text.slice(0, DISCORD_MAX_CHARS - 1) + '…' : text;
}

function freezingLine(d: SpotDetail): string {
  const spot: Spot = d.row.spot;
  const known = d.days.filter((x) => x.freezingLevelM !== null);
  if (!known.length) return '**Freezing level:** no model reported one.';
  const low = known.reduce((a, b) => (b.freezingLevelM! < a.freezingLevelM! ? b : a));
  const lvl = low.freezingLevelM!;
  const where =
    lvl <= spot.baseElevationM
      ? 'below the base — snow all the way down'
      : lvl < spot.summitElevationM
        ? `between the base and the ${metres(spot.summitElevationM)} summit — snow up high`
        : `above the ${metres(spot.summitElevationM)} summit all week`;
  return `**Freezing level:** lowest ${metres(lvl)} ${weekday(low.date)}, ${where}.`;
}

function weathernextLine(d: SpotDetail): string {
  const band = d.row.snow?.ensembleBand ?? null;
  if (!band) return '**WeatherNext:** not in this report.';
  const words =
    band.relativeWidth <= NARROW_BAND
      ? 'tight — its 64 runs mostly agree on the precipitation'
      : band.relativeWidth >= WIDE_BAND
        ? 'wide open — its 64 runs range from little to a lot'
        : "middling — its 64 runs don't settle it";
  return `**WeatherNext:** ${words}.`;
}

/* ---------------------------------------------------------------- audit */

/** Every cm printed is a modelled day or total, or the archive's figure. */
export function assertSpotHonest(d: SpotDetail, text: string): void {
  const allowed = new Set<number>();
  for (const m of d.row.snow?.models ?? []) allowed.add(Math.round(m.totalCm));
  for (const day of d.row.snow?.days ?? []) {
    for (const v of Object.values(day.base)) if (v !== null) allowed.add(Math.round(v));
  }
  if (d.observed) allowed.add(Math.round(d.observed.trailing7dCm));
  for (const [, a, b] of text.matchAll(/(\d+)(?:–(\d+))?cm\b/g)) {
    for (const n of [a, b]) {
      if (n !== undefined && !allowed.has(Number(n))) {
        throw new Error(`spot snapshot prints ${n}cm, which no model or archive said`);
      }
    }
  }
}

/** Discord's autocomplete for `spot:` — Aspen and the board, matching what's typed. */
export function spotChoices(cfg: Config, typed: string): { name: string; value: string }[] {
  const q = typed.trim().toLowerCase();
  return snapshotSpots(cfg)
    .map((s) => ({
      name:
        s.id === 'aspen'
          ? 'Aspen (Snowmass)'
          : (cfg.board.find((d) => d.id === s.id)?.name ?? s.label),
      value: s.id,
    }))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q))
    .slice(0, 25);
}
