import { deriveSnowfall, type DerivedSnowDay } from './snowfall.js';
import type { ModelForecast } from './types.js';
import type { WeatherNextForecast } from './weathernext.js';

/**
 * Merge every forecast we hold for a resort into one `SnowReport`.
 *
 * Two rules shape everything here, both from PLAN.md §3:
 *
 *   1. Snow totals come only from models that predict snowfall (ECMWF IFS,
 *      AIFS, ICON, GFS, NAM). They sit in `models` and are the only numbers a
 *      post may quote as a forecast.
 *   2. WeatherNext has no snow variable. Its precipitation, converted through
 *      `deriveSnowfall`, lives in `derived` — a separate field, stamped
 *      `source: 'derived'` — and feeds scoring and the rain-risk check, never a
 *      quoted total. `formatSnowLine` cannot print it and
 *      `assertNoDerivedInQuoted` proves that for any report.
 *
 * WeatherNext's real contribution is its 64-member spread on precipitation,
 * which — together with how far the snowfall models sit from each other —
 * decides the confidence label.
 *
 * Pure: no network, no database, no clock.
 */

export type DateWindow = { start: string; end: string };

export type QuotedTotal = {
  model: string;
  totalCm: number;
  /** Always 'modelled' here. The literal type is the point: a `DerivedTotal`
   *  cannot be assigned into `models` without the compiler objecting. */
  source: 'modelled';
};

export type DerivedTotal = {
  totalCm: number;
  p10: number;
  p90: number;
  source: 'derived';
  days: DerivedSnowDay[];
};

export type SnowDay = {
  date: string;
  /** Snowfall cm per model at the base coordinate; null where the model had no value. */
  base: Record<string, number | null>;
  /** Same at the summit coordinate, or null when no summit forecasts were supplied. */
  summit: Record<string, number | null> | null;
};

export type EnsembleBand = {
  p10Mm: number;
  meanMm: number;
  p90Mm: number;
  /** (p90 − p10) / mean, with a floor on the mean so a dry window does not
   *  read as chaos. Under NARROW_BAND is tight; over WIDE_BAND is wide open. */
  relativeWidth: number;
};

export type Confidence = 'high' | 'medium' | 'low';

export type SnowReport = {
  window: DateWindow;
  days: SnowDay[];
  /** Quoted totals at the base — the only numbers a post may call a forecast. */
  models: QuotedTotal[];
  /** Quoted totals at the summit, when summit forecasts were supplied. */
  summitModels: QuotedTotal[];
  /** WeatherNext-derived estimate. Never quoted; see module comment. */
  derived?: DerivedTotal;
  /** 1 − coefficient of variation of the modelled totals, clipped to [0, 1].
   *  null when fewer than two models reported — one opinion is not agreement. */
  agreement: number | null;
  /** null when no WeatherNext run was supplied. */
  ensembleBand: EnsembleBand | null;
  confidence: Confidence;
  /** One sentence a person could read aloud in the channel. */
  explanation: string;
  tempRange: { minC: number; maxC: number } | null;
  /** Any model's midday freezing level above the base, or a WeatherNext day
   *  warm enough that its precipitation falls as rain. */
  rainRiskAtBase: boolean;
  maxGustKmh: number | null;
  /** What we can honestly say about the summit given what was supplied. */
  summitNote: string;
  asOf: {
    contributing: string[];
    missing: { model: string; reason: string }[];
    summitContributing: string[];
    weathernext: { initTime: string } | null;
  };
};

export type BuildSnowReportInput = {
  window: DateWindow;
  base: ModelForecast[];
  summit?: ModelForecast[];
  weathernext?: WeatherNextForecast;
  utcOffsetHours?: number;
  baseElevationM: number;
  summitElevationM: number;
};

/* Tunables. Kept together so the confidence rule can be read in one place. */

/** Below this the models are close enough to call it agreement. */
export const AGREE_THRESHOLD = 0.75;
/** Below this the models are telling different stories. */
export const DISAGREE_THRESHOLD = 0.5;
/** Relative p10–p90 width at or under which the ensemble is "tight". */
export const NARROW_BAND = 0.75;
/** Relative p10–p90 width at or over which the ensemble is "wide open". */
export const WIDE_BAND = 1.75;
/** cm. Totals smaller than this are dustings; disagreement about a dusting is
 *  not disagreement, so the CV denominator is floored here. */
const AGREEMENT_FLOOR_CM = 5;
/** mm over the window; same idea for the ensemble band on a dry forecast. */
const BAND_FLOOR_MM = 5;
/** Standard atmosphere lapse rate, °C per metre, for the summit note. */
const LAPSE_RATE_C_PER_M = 0.0065;

export function buildSnowReport(input: BuildSnowReportInput): SnowReport {
  const { window, baseElevationM, summitElevationM } = input;
  const offset = input.utcOffsetHours ?? 0;
  const summit = input.summit ?? [];

  const dates = datesIn(window);
  const baseTotals = quoteTotals(input.base, window);
  const summitTotals = quoteTotals(summit, window);

  const days: SnowDay[] = dates.map((date) => ({
    date,
    base: perModel(input.base, date, baseTotals.quoted),
    summit: summit.length ? perModel(summit, date, summitTotals.quoted) : null,
  }));

  const derived = input.weathernext ? deriveTotal(input.weathernext, window, offset) : undefined;
  const ensembleBand = input.weathernext ? bandFor(input.weathernext, window, offset) : null;
  const agreement = agreementOf(baseTotals.quoted.map((m) => m.totalCm));
  const confidence = decideConfidence(baseTotals.quoted.length, agreement, ensembleBand);

  const inWindow = input.base.flatMap((f) => f.days.filter((d) => inside(d.date, window)));
  const lows = nums(inWindow.map((d) => d.tempMinC));
  const highs = nums(inWindow.map((d) => d.tempMaxC));
  const gusts = nums(inWindow.map((d) => d.gustMaxKmh ?? d.windMaxKmh));
  const rainRiskAtBase =
    inWindow.some((d) => d.freezingLevelM !== null && d.freezingLevelM > baseElevationM) ||
    (derived?.days.some((d) => d.fallsAsRain) ?? false);

  const report: SnowReport = {
    window,
    days,
    models: baseTotals.quoted,
    summitModels: summitTotals.quoted,
    ...(derived ? { derived } : {}),
    agreement,
    ensembleBand,
    confidence,
    explanation: '',
    tempRange:
      lows.length && highs.length ? { minC: Math.min(...lows), maxC: Math.max(...highs) } : null,
    rainRiskAtBase,
    maxGustKmh: gusts.length ? Math.round(Math.max(...gusts)) : null,
    summitNote: summitNoteFor(summitTotals.quoted, baseElevationM, summitElevationM),
    asOf: {
      contributing: baseTotals.quoted.map((m) => m.model),
      missing: baseTotals.missing,
      summitContributing: summitTotals.quoted.map((m) => m.model),
      weathernext: input.weathernext ? { initTime: input.weathernext.initTime } : null,
    },
  };
  report.explanation = explain(report);
  return report;
}

/**
 * The confidence rule.
 *
 *   - Nothing reported → low. There is no forecast to be confident about.
 *   - One model → never high. Medium if WeatherNext's band is tight, else low:
 *     a single run has nothing to corroborate it.
 *   - Agreement under DISAGREE_THRESHOLD, or a band at or over WIDE_BAND → low.
 *   - Agreement at or over AGREE_THRESHOLD and the band at or under NARROW_BAND
 *     → high. Without WeatherNext, high needs three or more models agreeing —
 *     two runs from the same family (IFS and AIFS) agreeing is not enough.
 *   - Everything else → medium.
 */
export function decideConfidence(
  modelCount: number,
  agreement: number | null,
  band: EnsembleBand | null,
): Confidence {
  if (modelCount === 0) return 'low';
  const narrow = band !== null && band.relativeWidth <= NARROW_BAND;
  const wide = band !== null && band.relativeWidth >= WIDE_BAND;
  if (modelCount === 1 || agreement === null) return narrow ? 'medium' : 'low';
  if (agreement < DISAGREE_THRESHOLD || wide) return 'low';
  if (agreement >= AGREE_THRESHOLD && (narrow || (band === null && modelCount >= 3))) {
    return 'high';
  }
  return 'medium';
}

/** 1 − CV, clipped. A floor on the mean keeps "2cm vs 4cm" from scoring as a split. */
export function agreementOf(totals: number[]): number | null {
  if (totals.length < 2) return null;
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const variance = totals.reduce((a, t) => a + (t - mean) ** 2, 0) / totals.length;
  const cv = Math.sqrt(variance) / Math.max(mean, AGREEMENT_FLOOR_CM);
  return round2(Math.min(1, Math.max(0, 1 - cv)));
}

/** The line a post prints. Built only from `models`, so `derived` cannot leak. */
export function formatSnowLine(report: SnowReport): string {
  const when = describeWindow(report.window);
  if (report.models.length === 0) {
    return `${when}: no snowfall model reported for this window`;
  }
  const base = report.models.map(quote).join(' / ');
  const summit = report.summitModels.length
    ? ` (summit ${report.summitModels.map(quote).join(' / ')})`
    : '';
  const rain = report.rainRiskAtBase ? ', rain risk at the base' : '';
  return `${when}: ${base}${summit} — ${report.confidence} confidence${rain}`;
}

/**
 * The invariant the whole module exists to keep. Throws if a derived number
 * has found its way into the quoted totals or the printed line. Tests call it
 * on every fixture; jobs may call it before posting.
 */
export function assertNoDerivedInQuoted(report: SnowReport): void {
  for (const m of [...report.models, ...report.summitModels]) {
    if ((m.source as string) !== 'modelled') {
      throw new Error(`quoted total for ${m.model} is ${String(m.source)}, not modelled`);
    }
  }
  const line = formatSnowLine(report);
  if (/derived|weathernext/i.test(line)) {
    throw new Error(`snow line mentions a non-model source: ${line}`);
  }
  const allowed = new Set(
    [...report.models, ...report.summitModels].map((m) => Math.round(m.totalCm)),
  );
  for (const [, n] of line.matchAll(/(\d+)cm/g)) {
    if (!allowed.has(Number(n))) {
      throw new Error(`snow line prints ${n}cm, which is not a modelled total: ${line}`);
    }
  }
}

/* ---- internals ---- */

function quoteTotals(
  forecasts: ModelForecast[],
  window: DateWindow,
): { quoted: QuotedTotal[]; missing: { model: string; reason: string }[] } {
  const quoted: QuotedTotal[] = [];
  const missing: { model: string; reason: string }[] = [];
  for (const f of forecasts) {
    if (f.missingVariables.includes('snowfall_sum')) {
      missing.push({ model: f.model, reason: 'model does not report snowfall' });
      continue;
    }
    const days = f.days.filter((d) => inside(d.date, window));
    if (days.length === 0) {
      missing.push({ model: f.model, reason: 'no days inside the window' });
      continue;
    }
    const values = nums(days.map((d) => d.snowfallCm));
    if (values.length === 0) {
      missing.push({ model: f.model, reason: 'snowfall null on every day in the window' });
      continue;
    }
    quoted.push({
      model: f.model,
      totalCm: round1(values.reduce((a, b) => a + b, 0)),
      source: 'modelled',
    });
  }
  return { quoted, missing };
}

function perModel(
  forecasts: ModelForecast[],
  date: string,
  quoted: QuotedTotal[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const q of quoted) {
    const f = forecasts.find((x) => x.model === q.model);
    out[q.model] = f?.days.find((d) => d.date === date)?.snowfallCm ?? null;
  }
  return out;
}

function deriveTotal(wn: WeatherNextForecast, window: DateWindow, offset: number): DerivedTotal {
  const days = deriveSnowfall(wn, offset).filter((d) => inside(d.date, window));
  const sum = (pick: (d: DerivedSnowDay) => number) =>
    round1(days.reduce((a, d) => a + pick(d), 0));
  return {
    totalCm: sum((d) => d.snowCm),
    p10: sum((d) => d.snowCmP10),
    p90: sum((d) => d.snowCmP90),
    source: 'derived',
    days,
  };
}

function bandFor(wn: WeatherNextForecast, window: DateWindow, offset: number): EnsembleBand | null {
  let p10 = 0;
  let mean = 0;
  let p90 = 0;
  let steps = 0;
  for (const s of wn.steps) {
    const date = localDate(s.time, offset);
    if (date === null || !inside(date, window)) continue;
    steps += 1;
    p10 += s.precipitation1hrMm.p10 ?? 0;
    mean += s.precipitation1hrMm.mean ?? 0;
    p90 += s.precipitation1hrMm.p90 ?? 0;
  }
  if (steps === 0) return null;
  return {
    p10Mm: round1(p10),
    meanMm: round1(mean),
    p90Mm: round1(p90),
    relativeWidth: round2(Math.max(0, p90 - p10) / Math.max(mean, BAND_FLOOR_MM)),
  };
}

function summitNoteFor(summit: QuotedTotal[], baseM: number, summitM: number): string {
  if (summit.length) {
    return `Summit totals are the models' own forecasts at the summit point (${summitM}m).`;
  }
  const dropC = Math.round((summitM - baseM) * LAPSE_RATE_C_PER_M);
  return (
    `Base only (${baseM}m): no summit forecast was supplied, and a 9km grid cannot ` +
    `tell base from summit. The summit is ${summitM - baseM}m higher, so expect it ` +
    `roughly ${dropC}°C colder and more of the precipitation to fall as snow — but no ` +
    `summit total is being quoted.`
  );
}

function explain(r: SnowReport): string {
  if (r.models.length === 0) {
    return 'No snowfall model reported for this window, so there is no total to quote — low confidence.';
  }
  const list = r.models.map(quote).join(' / ');
  const band =
    r.ensembleBand === null
      ? 'no WeatherNext run to check the spread against'
      : r.ensembleBand.relativeWidth <= NARROW_BAND
        ? "WeatherNext's ensemble is tight"
        : r.ensembleBand.relativeWidth >= WIDE_BAND
          ? "WeatherNext's ensemble is wide open"
          : "WeatherNext's ensemble is middling";
  const rain = r.rainRiskAtBase ? ' with a rain risk at the base' : '';

  if (r.models.length === 1) {
    return `${list} — only one model reported and ${band}, so this cannot be better than medium; ${r.confidence} confidence${rain}.`;
  }
  const agree =
    r.agreement !== null && r.agreement >= AGREE_THRESHOLD
      ? 'models agree'
      : r.agreement !== null && r.agreement >= DISAGREE_THRESHOLD
        ? 'models broadly agree'
        : 'models disagree';
  return `${list} — ${agree} and ${band}, ${r.confidence} confidence${rain}.`;
}

const DISPLAY_NAMES: Record<string, string> = {
  ecmwf_ifs025: 'ECMWF',
  ecmwf_aifs025: 'AIFS',
  icon_eu: 'ICON-EU',
  icon_global: 'ICON',
  gfs_seamless: 'GFS',
  ncep_nam_conus: 'NAM',
};

function quote(m: QuotedTotal): string {
  return `${DISPLAY_NAMES[m.model] ?? m.model} ${Math.round(m.totalCm)}cm`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jan 24–26" or "Jan 30–Feb 2". Parsed by hand so no timezone can shift a day. */
function describeWindow(w: DateWindow): string {
  const [, sm, sd] = w.start.split('-').map(Number);
  const [, em, ed] = w.end.split('-').map(Number);
  const start = `${MONTHS[(sm ?? 1) - 1]} ${sd}`;
  if (w.start === w.end) return start;
  return sm === em ? `${start}–${ed}` : `${start}–${MONTHS[(em ?? 1) - 1]} ${ed}`;
}

function datesIn(w: DateWindow): string[] {
  const out: string[] = [];
  const start = Date.parse(`${w.start}T00:00:00Z`);
  const end = Date.parse(`${w.end}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let t = start; t <= end; t += 24 * 3600_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function localDate(time: string, offset: number): string | null {
  const t = Date.parse(time);
  if (Number.isNaN(t)) return null;
  return new Date(t + offset * 3600_000).toISOString().slice(0, 10);
}

function inside(date: string, w: DateWindow): boolean {
  return date >= w.start && date <= w.end;
}

function nums(xs: (number | null)[]): number[] {
  return xs.filter((x): x is number => x !== null);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
