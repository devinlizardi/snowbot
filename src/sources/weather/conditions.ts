import type { DateWindow } from './consensus.js';
import { RAIN_THRESHOLD_C, WET_DAY_MM } from './snowfall.js';
import type { ModelForecast } from './types.js';
import type { WeatherNextForecast } from './weathernext.js';

/**
 * Everything but snow — temperature, wind, rain and the freezing level —
 * merged across every source that actually predicts it.
 *
 * Snow lives in `consensus.ts` because of the one rule about WeatherNext: it
 * has no snowfall variable, so it never supplies a snow number. Temperature is
 * different. WeatherNext predicts it directly, so here its ensemble median
 * (p50) sits beside the Open-Meteo models as one more opinion. It has no gust
 * or freezing-level variable, so those come from the Open-Meteo models alone.
 *
 * Pure: no network, no database, no clock.
 */

/** Spread (°C) across sources at or under which the temperatures agree. */
export const TEMP_AGREE_C = 3;
/** Spread (°C) over which they are telling different stories. */
export const TEMP_SPLIT_C = 6;
/** WeatherNext counts toward the temperature consensus only when its steps
 *  cover at least this share of the window's days — a run that misses the
 *  coldest night would read as disagreement when it is only absence. */
const WN_MIN_COVERAGE = 0.8;

export const WEATHERNEXT = 'weathernext_3';

export type Consensus = {
  /** Median across sources (mean of the middle two for an even count), 1dp. */
  value: number;
  low: number;
  high: number;
  bySource: Record<string, number>;
};

export type Agreement = 'agree' | 'partly' | 'split';

export type ConditionsReport = {
  window: DateWindow;
  /** Each source's coldest daily minimum over the window. */
  tempLowC: Consensus | null;
  /** Each source's warmest daily maximum over the window. */
  tempHighC: Consensus | null;
  /** The wider of the two spreads above. null with fewer than two sources. */
  tempSpreadC: number | null;
  tempAgreement: Agreement | null;
  /** The windiest day by the models' median daily gust, km/h. */
  peakGust: { kmh: number; date: string } | null;
  /** Median of each model's precipitation total over the window, mm. */
  precipMm: number | null;
  /** Days with at least WET_DAY_MM (model median) and above freezing at the
   *  base at midday — the freezing level above the base, or, where no model
   *  reports one, a high of RAIN_THRESHOLD_C or more. */
  rainDays: string[];
  /** The lowest median midday freezing level on a wet day, when it sits
   *  between the base and the summit: snow up high, not at the bottom. */
  snowUpHigh: { date: string; freezingLevelM: number } | null;
  /** Every source that contributed a value, WeatherNext included. */
  sources: string[];
};

export type BuildConditionsInput = {
  window: DateWindow;
  base: readonly ModelForecast[];
  weathernext?: WeatherNextForecast;
  /** Resort-local offset, so WeatherNext's UTC steps land on the resort's days. */
  utcOffsetHours: number;
  baseElevationM: number;
  summitElevationM: number;
};

export function buildConditions(input: BuildConditionsInput): ConditionsReport {
  const { window, baseElevationM, summitElevationM } = input;
  const lows: Record<string, number> = {};
  const highs: Record<string, number> = {};
  const totals: number[] = [];
  const sources = new Set<string>();

  for (const f of input.base) {
    const days = f.days.filter((d) => inside(d.date, window));
    const mins = nums(days.map((d) => d.tempMinC));
    const maxs = nums(days.map((d) => d.tempMaxC));
    const precip = nums(days.map((d) => d.precipitationMm));
    if (mins.length) lows[f.model] = Math.min(...mins);
    if (maxs.length) highs[f.model] = Math.max(...maxs);
    if (precip.length) totals.push(precip.reduce((a, b) => a + b, 0));
    if (mins.length || maxs.length || precip.length) sources.add(f.model);
  }

  const wn = input.weathernext
    ? weathernextTemps(input.weathernext, window, input.utcOffsetHours)
    : null;
  if (wn) {
    lows[WEATHERNEXT] = wn.low;
    highs[WEATHERNEXT] = wn.high;
    sources.add(WEATHERNEXT);
  }

  const perDay = datesIn(window).map((date) => {
    const days = input.base
      .map((f) => f.days.find((d) => d.date === date))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);
    return {
      date,
      precipMm: median(nums(days.map((d) => d.precipitationMm))),
      freezingM: median(nums(days.map((d) => d.freezingLevelM))),
      highC: median(nums(days.map((d) => d.tempMaxC))),
      gustKmh: median(nums(days.map((d) => d.gustMaxKmh))),
    };
  });

  const wet = perDay.filter((d) => d.precipMm !== null && d.precipMm >= WET_DAY_MM);
  const rainDays = wet
    .filter((d) =>
      d.freezingM !== null
        ? d.freezingM > baseElevationM
        : d.highC !== null && d.highC >= RAIN_THRESHOLD_C,
    )
    .map((d) => d.date);

  let snowUpHigh: ConditionsReport['snowUpHigh'] = null;
  for (const d of wet) {
    if (d.freezingM === null) continue;
    if (d.freezingM < baseElevationM || d.freezingM >= summitElevationM) continue;
    if (snowUpHigh === null || d.freezingM < snowUpHigh.freezingLevelM) {
      snowUpHigh = { date: d.date, freezingLevelM: Math.round(d.freezingM) };
    }
  }

  let peakGust: ConditionsReport['peakGust'] = null;
  for (const d of perDay) {
    if (d.gustKmh !== null && (peakGust === null || d.gustKmh > peakGust.kmh)) {
      peakGust = { kmh: Math.round(d.gustKmh), date: d.date };
    }
  }

  const tempLowC = consensusOf(lows);
  const tempHighC = consensusOf(highs);
  const spreads = [tempLowC, tempHighC]
    .filter((c): c is Consensus => c !== null && Object.keys(c.bySource).length >= 2)
    .map((c) => round1(c.high - c.low));
  const tempSpreadC = spreads.length ? Math.max(...spreads) : null;

  const precipMedian = median(totals);
  return {
    window,
    tempLowC,
    tempHighC,
    tempSpreadC,
    tempAgreement: tempSpreadC === null ? null : agreementFor(tempSpreadC),
    peakGust,
    precipMm: precipMedian === null ? null : round1(precipMedian),
    rainDays,
    snowUpHigh,
    sources: [...sources],
  };
}

export function agreementFor(spreadC: number): Agreement {
  if (spreadC <= TEMP_AGREE_C) return 'agree';
  if (spreadC <= TEMP_SPLIT_C) return 'partly';
  return 'split';
}

/** Median of the values, or null for none. The mean of the middle two when even. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/* ---- internals ---- */

function consensusOf(bySource: Record<string, number>): Consensus | null {
  const values = Object.values(bySource);
  const m = median(values);
  if (m === null) return null;
  return {
    value: round1(m),
    low: round1(Math.min(...values)),
    high: round1(Math.max(...values)),
    bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, round1(v)])),
  };
}

/** WeatherNext's window low and high from its ensemble median, or null when
 *  its steps don't cover enough of the window to be a fair comparison. */
function weathernextTemps(
  wn: WeatherNextForecast,
  window: DateWindow,
  offsetHours: number,
): { low: number; high: number } | null {
  const values: number[] = [];
  const days = new Set<string>();
  for (const s of wn.steps) {
    const t = Date.parse(s.time);
    if (Number.isNaN(t)) continue;
    const date = new Date(t + offsetHours * 3600_000).toISOString().slice(0, 10);
    if (!inside(date, window)) continue;
    const c = s.temperature2mC.p50 ?? s.temperature2mC.mean;
    if (c === null) continue;
    values.push(c);
    days.add(date);
  }
  const want = datesIn(window).length;
  if (values.length === 0 || days.size < Math.ceil(want * WN_MIN_COVERAGE)) return null;
  return { low: Math.min(...values), high: Math.max(...values) };
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

function inside(date: string, w: DateWindow): boolean {
  return date >= w.start && date <= w.end;
}

function nums(xs: (number | null)[]): number[] {
  return xs.filter((x): x is number => x !== null);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
