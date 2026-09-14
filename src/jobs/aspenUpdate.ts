import type { Config } from '../config.js';
import { optionalSecret } from '../config.js';
import type { DB } from '../db.js';
import { kvGet, kvSet } from '../db.js';
import { renderAnchor, upsertAnchor, type AnchorStatus } from '../discord/anchor.js';
import { isQuiet } from '../discord/commands.js';
import type { CompleteOptions } from '../llm/client.js';
import {
  ASPEN_BODY_MAX_CHARS,
  ASPEN_SYSTEM_PROMPT,
  dayLabel,
  fallbackRender,
  renderAspenPrompt,
  unquotedSnowNumbers,
  type Arrival,
  type AspenBriefing,
  type AspenCadence,
  type BriefingDay,
} from '../llm/prompts/aspen.js';
import { cached } from '../sources/_cache.js';
import { baseDepthLookup, type BaseDepth, type LookupResult } from '../sources/lookup.js';
import type { Fetched, Source } from '../sources/types.js';
import { archive, trailingWeek } from '../sources/weather/archive.js';
import {
  assertNoDerivedInQuoted,
  buildSnowReport,
  formatSnowLine,
  type DateWindow,
  type SnowReport,
} from '../sources/weather/consensus.js';
import { crosscheckFor } from '../sources/weather/crosscheck.js';
import { ecmwfAifs, ecmwfIfs, ECMWF_IFS, type ForecastParams } from '../sources/weather/ecmwf.js';
import { seasonal } from '../sources/weather/seasonal.js';
import type {
  Coord,
  ModelForecast,
  ObservedSnow,
  SeasonalOutlook,
} from '../sources/weather/types.js';
import { weathernextSource, type WeatherNextForecast } from '../sources/weather/weathernext.js';
import type { Job, JobContext } from './_runner.js';

/**
 * The Aspen trip-ops job (PLAN.md §1A). Runs from cron every day; the cadence
 * resolver decides whether today is a monthly, weekly, daily or on-trip day,
 * and a kv watermark per tier makes a re-run on the same day a no-op.
 *
 * Every run that fires edits the pinned anchor. A new root message is posted
 * only when the story changed: the window total moved by MATERIAL_SWING_CM,
 * the confidence label flipped, or this is the first post of a new tier.
 */

export type Cadence = AspenCadence;

export type AspenDeps = {
  /** Every source goes through here, so tests can answer by `source.name`. */
  fetch<P, R>(source: Source<P, R>, params: P, opts: { offline: boolean }): Promise<Fetched<R>>;
  /** Haiku, in production; a stub or a thrower in tests. */
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
};

/** Move in the window's mean modelled total that earns a new root post. */
export const MATERIAL_SWING_CM = 15;
/** Open-Meteo's forecast horizon; also how far a "next 15 days" window reaches. */
const HORIZON_DAYS = 15;
/** Aspen is on Mountain Time. Only WeatherNext's UTC steps need this, to bucket
 *  them into resort-local days; Open-Meteo already answers in local dates. */
const ASPEN_UTC_OFFSET_HOURS = -7;
const WEATHERNEXT_HOURS = 360;

export const KV_LAST_BRIEFING = 'aspen:last_briefing';
export const kvLastPostKey = (cadence: Cadence) => `aspen:last_post_${cadence}`;

/* --------------------------------------------------------------- cadence */

/**
 * Which tier today falls in. Tiers are contiguous date ranges from config;
 * within a tier the weekday/day-of-month picks the firing days, and after
 * `window_end` the whole thing goes quiet until someone edits the config.
 */
export function resolveCadence(aspen: Config['aspen'], now: Date, timezone = 'UTC'): Cadence {
  const today = localDate(now, timezone);
  const { monthly_from, weekly_from, daily_from } = aspen.cadence;
  if (today > aspen.window_end) return 'off';
  if (today >= aspen.window_start) return 'trip';
  if (today >= daily_from) return 'daily';
  if (today >= weekly_from) return weekdayOf(today) === 1 ? 'weekly' : 'off';
  if (today >= monthly_from) return today.endsWith('-01') ? 'monthly' : 'off';
  return 'off';
}

/** At most one post per tier per local day; the resolver already picked the day. */
export function isDue(cadence: Cadence, now: Date, lastRunIso?: string, timezone = 'UTC'): boolean {
  if (cadence === 'off') return false;
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  if (Number.isNaN(last.getTime())) return true;
  return localDate(last, timezone) !== localDate(now, timezone);
}

/** The dates the forecast numbers describe: the trip window once the models
 *  reach it, otherwise the next 15 days so a weekly post still has something
 *  concrete to say. Monthly always looks at the next 15 days. */
export function reportWindow(cadence: Cadence, today: string, aspen: Config['aspen']): DateWindow {
  const horizonEnd = addDays(today, HORIZON_DAYS - 1);
  if (cadence !== 'monthly' && aspen.window_start <= horizonEnd) {
    return {
      start: today > aspen.window_start ? today : aspen.window_start,
      end: aspen.window_end < horizonEnd ? aspen.window_end : horizonEnd,
    };
  }
  return { start: today, end: horizonEnd };
}

/* ------------------------------------------------------------- composing */

export type ComposeInputs = {
  cfg: Config;
  cadence: Exclude<Cadence, 'off'>;
  now: Date;
  today: string;
  report: SnowReport | null;
  /** ECMWF IFS at base and summit, for the per-day rows. */
  ifsBase: ModelForecast | null;
  ifsSummit: ModelForecast | null;
  observed: ObservedSnow | null;
  seasonal: SeasonalOutlook | null;
  baseDepth: BaseDepth | null;
  arrivals: Arrival[];
  sources: { contributing: string[]; missing: string[]; stale: string[] };
};

export function composeBriefing(i: ComposeInputs): AspenBriefing {
  const { cfg, report } = i;
  const aspen = cfg.aspen;
  const tripWindow = { start: aspen.window_start, end: aspen.window_end };
  const days = report ? dayRows(report, i.ifsBase, i.ifsSummit) : [];

  return {
    cadence: i.cadence,
    resort: aspen.name,
    asOf: i.now.toISOString(),
    today: i.today,
    tripWindow,
    daysOut: daysBetween(i.today, aspen.window_start),
    forecastWindow: report && report.models.length ? report.window : null,
    snowLine: report && report.models.length ? formatSnowLine(report) : null,
    confidence: report?.confidence ?? 'low',
    explanation: report?.explanation ?? 'No forecast sources were available for this run.',
    models: report?.models.map((m) => ({ model: m.model, totalCm: m.totalCm })) ?? [],
    summitModels: report?.summitModels.map((m) => ({ model: m.model, totalCm: m.totalCm })) ?? [],
    days,
    temps: report?.tempRange ?? null,
    maxGustKmh: report?.maxGustKmh ?? null,
    rainRiskAtBase: report?.rainRiskAtBase ?? false,
    observed7dCm: i.observed?.trailing7dCm ?? null,
    baseDepthCm: i.baseDepth?.baseDepthCm ?? null,
    seasonalNote: i.cadence === 'monthly' ? seasonalNote(i.seasonal, tripWindow) : null,
    packing: packingList({
      minC: report?.tempRange?.minC ?? null,
      maxGustKmh: report?.maxGustKmh ?? null,
      rainRiskAtBase: report?.rainRiskAtBase ?? false,
      biggestDayCm: biggestDay(days)?.cm ?? null,
      totalCm: report && report.models.length ? meanTotal(report) : null,
    }),
    arrivals: i.arrivals,
    groundNote: groundNote(aspen.airports, i.arrivals),
    sources: i.sources,
  };
}

export type PackingInputs = {
  minC: number | null;
  maxGustKmh: number | null;
  rainRiskAtBase: boolean;
  biggestDayCm: number | null;
  totalCm: number | null;
};

/** Rules, not vibes: each line names the number that put it there. */
export function packingList(p: PackingInputs): string[] {
  const out: string[] = [];
  if (p.maxGustKmh !== null && p.maxGustKmh > 50) {
    out.push(
      `Goggles with a low-light lens and a face cover — gusts to ${Math.round(p.maxGustKmh)} km/h`,
    );
  }
  if (p.minC !== null && p.minC < -15) {
    out.push(`Heavier layers and mitts over gloves — lows to ${Math.round(p.minC)}°C`);
  } else if (p.minC !== null && p.minC < -5) {
    out.push(`A real mid-layer — lows to ${Math.round(p.minC)}°C`);
  }
  if (p.rainRiskAtBase) {
    out.push('Waterproof shell, not just a windproof one — rain risk at the base');
  }
  if (p.biggestDayCm !== null && p.biggestDayCm >= 20) {
    out.push(`The wider board — a ${Math.round(p.biggestDayCm)}cm day is in the forecast`);
  }
  if (p.totalCm !== null && p.totalCm < 5 && !p.rainRiskAtBase) {
    out.push('Dark lens and sunscreen — a dry window at 2,400m+ is a sunburn');
  }
  return out;
}

export function composeStatus(b: AspenBriefing, timezone: string): AnchorStatus {
  const big = biggestDay(b.days);
  const sections: { title: string; body: string }[] = [];
  if (b.packing.length) {
    sections.push({ title: 'Pack', body: b.packing.map((l) => `• ${l}`).join('\n') });
  }
  if (b.cadence === 'daily' || b.cadence === 'trip') {
    sections.push({
      title: 'Arrivals',
      body: (b.arrivals.length ? renderArrivals(b.arrivals) + '\n' : '') + b.groundNote,
    });
  }
  return {
    daysOut: b.daysOut,
    ...(b.baseDepthCm !== null ? { baseDepthIn: b.baseDepthCm / 2.54 } : {}),
    ...(big && big.cm >= 5
      ? { nextStorm: { day: dayLabel(big.date).slice(0, 3), cm: big.cm, confidence: b.confidence } }
      : {}),
    updatedAt: new Date(b.asOf),
    timezone,
    sections,
  };
}

export function renderArrivals(rows: readonly Arrival[]): string {
  const cells = rows.map((r) => [
    r.member,
    dayLabel(r.date).slice(4),
    r.flight,
    `${r.origin}→${r.dest}`,
    r.status ?? '',
  ]);
  const header = ['who', 'date', 'flight', 'route', 'status'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return ['```', line(header), ...cells.map(line), '```'].join('\n');
}

/* -------------------------------------------------------- material change */

/** What we keep between runs to decide whether the next one is news. */
export type BriefingSnapshot = {
  cadence: Cadence;
  totalCm: number | null;
  confidence: AspenBriefing['confidence'];
  at: string;
};

export function snapshotOf(b: AspenBriefing): BriefingSnapshot {
  const totals = b.models.map((m) => m.totalCm);
  return {
    cadence: b.cadence,
    totalCm: totals.length ? round1(totals.reduce((a, c) => a + c, 0) / totals.length) : null,
    confidence: b.confidence,
    at: b.asOf,
  };
}

export function materialChange(
  prev: BriefingSnapshot | null,
  next: BriefingSnapshot,
): string | null {
  if (!prev) return 'first post';
  if (prev.cadence !== next.cadence) return `first ${next.cadence} post`;
  if (prev.confidence !== next.confidence)
    return `confidence ${prev.confidence} → ${next.confidence}`;
  if (prev.totalCm !== null && next.totalCm !== null) {
    const delta = next.totalCm - prev.totalCm;
    if (Math.abs(delta) >= MATERIAL_SWING_CM) {
      return `forecast moved ${delta > 0 ? '+' : ''}${Math.round(delta)}cm`;
    }
  } else if (prev.totalCm !== next.totalCm) {
    return next.totalCm === null ? 'forecast dropped out of reach' : 'forecast now in reach';
  }
  return null;
}

/* ----------------------------------------------------------------- the job */

export async function runAspenUpdate(ctx: JobContext, deps: AspenDeps): Promise<void> {
  const { cfg, db, poster, now, log } = ctx;
  const tz = cfg.timezone;
  const cadence = resolveCadence(cfg.aspen, now, tz);
  if (cadence === 'off') {
    log.info('quiet — not a posting day', { today: localDate(now, tz) });
    return;
  }
  const last = kvGet(db, kvLastPostKey(cadence));
  if (!isDue(cadence, now, last, tz)) {
    log.info('already posted today', { cadence, last });
    return;
  }

  const offline = ctx.dryRun && !optionalSecret('OPEN_METEO_LIVE');
  if (offline) log.warn('dry run without OPEN_METEO_LIVE — serving cache only');
  const today = localDate(now, tz);
  const window = reportWindow(cadence, today, cfg.aspen);
  const g = new Gatherer(ctx, deps, offline);

  const base = coord(cfg.aspen.base, 'base');
  const summit = coord(cfg.aspen.summit, 'summit');
  const fp = (c: Coord): ForecastParams => ({
    coord: c,
    forecastDays: cfg.weather.open_meteo.forecast_days,
    ttlMinutes: cfg.weather.cache_ttl_minutes.forecast,
  });

  const baseModels = (
    await Promise.all(
      [ecmwfIfs, ecmwfAifs, ...crosscheckFor('US')].map((s) =>
        g.get(s, fp(base), `${s.name}@base`),
      ),
    )
  ).filter(notNull);
  const summitModels = (
    await Promise.all([ecmwfIfs, ecmwfAifs].map((s) => g.get(s, fp(summit), `${s.name}@summit`)))
  ).filter(notNull);

  const week = trailingWeek(now);
  const observed = await g.get<
    { coord: Coord; start: string; end: string; ttlMinutes: number },
    ObservedSnow
  >(
    archive,
    { coord: base, ...week, ttlMinutes: cfg.weather.cache_ttl_minutes.archive },
    'archive',
  );

  let outlook: SeasonalOutlook | null = null;
  if (cadence === 'monthly') {
    outlook = await g.get(
      seasonal,
      {
        coord: base,
        forecastDays: seasonalDays(today, cfg.aspen.window_end),
        ttlMinutes: cfg.weather.cache_ttl_minutes.seasonal,
      },
      'seasonal',
    );
  }

  let weathernext: WeatherNextForecast | null = null;
  if (cfg.bigquery.projectId && optionalSecret('GOOGLE_APPLICATION_CREDENTIALS')) {
    weathernext = await g.get(
      weathernextSource(cfg),
      { coord: base, hours: WEATHERNEXT_HOURS, ttlMinutes: cfg.weather.cache_ttl_minutes.forecast },
      'weathernext',
    );
  } else {
    log.info('weathernext skipped — no GCP project or credentials in env');
  }

  let baseDepth: BaseDepth | null = null;
  if (cadence !== 'monthly') {
    const found = await g.get<{ resort: string }, LookupResult<BaseDepth>>(
      baseDepthLookup(ctx.llm),
      { resort: cfg.aspen.name },
      'base-depth',
    );
    baseDepth = found?.data ?? null;
  }

  let report: SnowReport | null = null;
  if (baseModels.length) {
    report = buildSnowReport({
      window,
      base: baseModels,
      summit: summitModels,
      ...(weathernext ? { weathernext } : {}),
      utcOffsetHours: ASPEN_UTC_OFFSET_HOURS,
      baseElevationM: cfg.aspen.base.elevation_m,
      summitElevationM: cfg.aspen.summit.elevation_m,
    });
    assertNoDerivedInQuoted(report);
  }

  const briefing = composeBriefing({
    cfg,
    cadence,
    now,
    today,
    report,
    ifsBase: baseModels.find((m) => m.model === ECMWF_IFS) ?? null,
    ifsSummit: summitModels.find((m) => m.model === ECMWF_IFS) ?? null,
    observed,
    seasonal: outlook,
    baseDepth,
    arrivals: loadArrivals(db, cfg.aspen),
    sources: g.summary(),
  });

  const body = await writeBody(ctx, deps, briefing);
  const status = { ...composeStatus(briefing, tz), headline: body };
  const anchor = await upsertAnchor({ poster, db, cfg, log }, renderAnchor(status));

  const prev = readSnapshot(db);
  const next = snapshotOf(briefing);
  const reason = materialChange(prev, next);
  if (reason && !anchor.created) {
    if (isQuiet(db, now)) {
      log.info('quiet mode — anchor edited, root post held back', { reason });
    } else {
      const label = cadence === 'trip' ? 'on the mountain' : `${cadence} update`;
      const note = [
        `❄️ **Aspen — ${label}** · ${reason}`,
        briefing.snowLine ?? briefing.explanation,
        '_Full status in the pinned message._',
      ].join('\n');
      const posted = await poster.postRoot(note);
      if (posted.suppressed) log.warn('news root suppressed', { reason: posted.reason });
    }
  } else {
    log.info(
      anchor.created ? 'anchor created — no separate root' : 'no material change — edit only',
    );
  }

  kvSet(db, KV_LAST_BRIEFING, JSON.stringify(next));
  kvSet(db, kvLastPostKey(cadence), now.toISOString());
}

/** Daily. The cadence resolver decides whether today is a posting day. */
export const aspenUpdateJob: Job = {
  name: 'aspenUpdate',
  run: (ctx) =>
    runAspenUpdate(ctx, {
      fetch: (source, params, { offline }) =>
        cached(ctx.db, source, params, { offline, now: ctx.now }),
      complete: (prompt, opts) => ctx.llm.complete(prompt, opts),
    }),
};

/* ---------------------------------------------------------------- helpers */

/** Wraps `deps.fetch` so a missing source is a log line, not a failed job,
 *  and remembers who answered for the "as of" line. */
class Gatherer {
  private readonly contributing: string[] = [];
  private readonly missing: string[] = [];
  private readonly stale: { label: string; fetchedAt: string }[] = [];

  constructor(
    private readonly ctx: JobContext,
    private readonly deps: AspenDeps,
    private readonly offline: boolean,
  ) {}

  async get<P, R>(source: Source<P, R>, params: P, label: string): Promise<R | null> {
    try {
      const got = await this.deps.fetch(source, params, { offline: this.offline });
      this.contributing.push(label);
      if (got.cached && this.offline) this.stale.push({ label, fetchedAt: got.fetchedAt });
      return got.value;
    } catch (err) {
      this.missing.push(label);
      this.ctx.log.warn(
        this.offline ? 'nothing cached, skipping source' : 'source failed, skipping',
        {
          source: label,
          error: String(err),
        },
      );
      return null;
    }
  }

  /** Offline, everything is cached; one line saying how old the oldest is beats six. */
  summary() {
    const stale: string[] = [];
    if (this.stale.length) {
      const oldest = this.stale.map((s) => s.fetchedAt).sort()[0];
      stale.push(
        `${this.stale.length} source${this.stale.length === 1 ? '' : 's'} from cache, oldest ${oldest}`,
      );
    }
    return { contributing: [...this.contributing], missing: [...this.missing], stale };
  }
}

/** Haiku when we can, the deterministic body when we can't or it misbehaves. */
async function writeBody(ctx: JobContext, deps: AspenDeps, b: AspenBriefing): Promise<string> {
  if (ctx.dryRun && !optionalSecret('ANTHROPIC_API_KEY')) {
    ctx.log.info('dry run without ANTHROPIC_API_KEY — using the fallback body');
    return fallbackRender(b);
  }
  try {
    const text = await deps.complete(renderAspenPrompt(b), {
      model: 'fast',
      system: ASPEN_SYSTEM_PROMPT,
      maxTokens: 1024,
    });
    const bad = unquotedSnowNumbers(text, b);
    if (bad.length) {
      ctx.log.warn('model quoted snow numbers not in the briefing — using fallback', { bad });
      return fallbackRender(b);
    }
    if (!text.trim()) throw new Error('empty completion');
    return text.length <= ASPEN_BODY_MAX_CHARS
      ? text
      : text.slice(0, ASPEN_BODY_MAX_CHARS - 1) + '…';
  } catch (err) {
    ctx.log.warn('llm failed — using fallback body', { error: String(err) });
    return fallbackRender(b);
  }
}

function readSnapshot(db: DB): BriefingSnapshot | null {
  const raw = kvGet(db, KV_LAST_BRIEFING);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BriefingSnapshot;
  } catch {
    return null;
  }
}

/** Everyone's flights landing the day before the window through its end. */
function loadArrivals(db: DB, aspen: Config['aspen']): Arrival[] {
  const rows = db
    .prepare(
      `SELECT m.name AS member, f.airline, f.number, f.date, f.origin, f.dest, f.last_status
       FROM flights f JOIN members m ON m.id = f.member_id
       WHERE f.date >= ? AND f.date <= ?
       ORDER BY f.date, m.name`,
    )
    .all(addDays(aspen.window_start, -1), aspen.window_end) as {
    member: string;
    airline: string;
    number: string;
    date: string;
    origin: string;
    dest: string;
    last_status: string | null;
  }[];
  return rows.map((r) => {
    let status: string | null = null;
    if (r.last_status) {
      try {
        status = (JSON.parse(r.last_status) as { status?: string }).status ?? null;
      } catch {
        status = null;
      }
    }
    return {
      member: r.member,
      flight: `${r.airline}${r.number}`,
      date: r.date,
      origin: r.origin,
      dest: r.dest,
      status,
    };
  });
}

function groundNote(airports: string[], arrivals: readonly Arrival[]): string {
  const into = new Map<string, string[]>();
  for (const a of arrivals) into.set(a.dest, [...(into.get(a.dest) ?? []), a.member]);
  const parts = [...into.entries()].map(([ap, who]) => `${who.join(', ')} into ${ap}`);
  const order = `Airports by convenience: ${airports.join(' > ')}.`;
  if (parts.length === 0)
    return `${order} No flights on file yet — \`/flight add\` to appear here.`;
  return `${order} ${parts.join('; ')} — anyone landing at the same airport shares the ride up.`;
}

function dayRows(
  report: SnowReport,
  ifsBase: ModelForecast | null,
  ifsSummit: ModelForecast | null,
): BriefingDay[] {
  return report.days.map((d) => {
    const b = ifsBase?.days.find((x) => x.date === d.date);
    const s = ifsSummit?.days.find((x) => x.date === d.date);
    return {
      date: d.date,
      baseCm: d.base[ECMWF_IFS] ?? null,
      summitCm: d.summit?.[ECMWF_IFS] ?? null,
      tempMinC: b?.tempMinC ?? null,
      tempMaxC: b?.tempMaxC ?? null,
      gustKmh: b?.gustMaxKmh ?? b?.windMaxKmh ?? s?.gustMaxKmh ?? null,
    };
  });
}

function biggestDay(days: readonly BriefingDay[]): { date: string; cm: number } | null {
  let best: { date: string; cm: number } | null = null;
  for (const d of days) {
    const cm = Math.max(d.baseCm ?? 0, d.summitCm ?? 0);
    if (cm > 0 && (best === null || cm > best.cm)) best = { date: d.date, cm };
  }
  return best;
}

function meanTotal(report: SnowReport): number {
  return round1(report.models.reduce((a, m) => a + m.totalCm, 0) / report.models.length);
}

/** CFS is worth one sentence about the trip month, and only one. */
function seasonalNote(outlook: SeasonalOutlook | null, window: DateWindow): string | null {
  if (!outlook) return null;
  const month = window.start.slice(0, 7);
  const m = outlook.months.find((x) => x.month === month);
  if (!m || (m.tempMeanC === null && m.precipitationMm === null)) return null;
  const bits: string[] = [];
  if (m.tempMeanC !== null) bits.push(`a mean of ${m.tempMeanC}°C`);
  if (m.precipitationMm !== null) bits.push(`${m.precipitationMm}mm of precipitation`);
  return `Seasonal (CFS) has ${monthName(month)} at the base running ${bits.join(' and ')} — a weak signal, worth a sentence and no more.`;
}

function seasonalDays(today: string, windowEnd: string): number {
  // Reach the end of the trip with a week's slack; Open-Meteo caps the seasonal call at 183 days.
  return Math.min(183, Math.max(45, daysBetween(today, windowEnd) + 7));
}

function coord(p: Config['aspen']['base'], label: string): Coord {
  return { lat: p.lat, lon: p.lon, label, elevationM: p.elevation_m };
}

const notNull = <T>(x: T | null): x is T => x !== null;

/** YYYY-MM-DD in a zone. `en-CA` is the locale whose default date format is ISO. */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

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
function monthName(yyyyMm: string): string {
  return MONTHS[Number(yyyyMm.slice(5, 7)) - 1] ?? yyyyMm;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
