import type { Percentiles, WeatherNextForecast } from './weathernext.js';

/**
 * Turning WeatherNext precipitation into snowfall.
 *
 * WeatherNext has no snow variable, so this is an estimate, not a prediction.
 * Everything that consumes it must carry that distinction through to the post:
 * ECMWF says 42cm because ECMWF modelled snow; WeatherNext "says" 38cm because
 * we multiplied its precipitation by a ratio. Those are not the same claim and
 * the bot should never print them as though they were.
 *
 * The ratio is temperature-dependent, following the shape of the Kuchera
 * method: near freezing, snow is wet and packs down to roughly 10:1; in the
 * -12 to -18°C band it is dry and fluffs out past 20:1; colder than about
 * -25°C there is little moisture left to fall at all.
 */

/** Warmer than this and it is falling as rain, whatever the precip total. */
export const RAIN_THRESHOLD_C = 2;

export function snowLiquidRatio(tempC: number): number {
  if (tempC >= RAIN_THRESHOLD_C) return 0;
  if (tempC >= 0) return 8; // sleety, heavy, barely accumulates
  if (tempC >= -3) return 10;
  if (tempC >= -8) return 13;
  if (tempC >= -12) return 17;
  if (tempC >= -18) return 20; // the good stuff
  if (tempC >= -25) return 17;
  return 12; // too cold to snow much
}

/** mm of liquid at a given temperature → cm of snow. */
export function liquidToSnowCm(precipMm: number, tempC: number): number {
  const ratio = snowLiquidRatio(tempC);
  return Math.round(precipMm * ratio) / 10;
}

export type DerivedSnowDay = {
  date: string;
  /** Central estimate, from the ensemble mean. */
  snowCm: number;
  /** Ensemble spread carried through the conversion — this is the part that
   *  earns WeatherNext its place in the consensus. */
  snowCmP10: number;
  snowCmP90: number;
  meanTempC: number | null;
  /** True when the day's temperature puts it above the rain threshold. */
  fallsAsRain: boolean;
  /** Always true here. Never drop this when formatting a post. */
  derived: true;
};

/**
 * Collapse the hourly/6-hourly steps into local days.
 *
 * Steps are UTC; `utcOffsetHours` shifts them so a "day" means the day the
 * group would experience on the mountain, not a UTC window that splits a
 * Hokkaido night in half.
 */
export function deriveSnowfall(
  forecast: WeatherNextForecast,
  utcOffsetHours = 0,
): DerivedSnowDay[] {
  const buckets = new Map<string, { precip: Percentiles[]; temps: number[] }>();

  for (const step of forecast.steps) {
    const t = Date.parse(step.time);
    if (Number.isNaN(t)) continue;
    const local = new Date(t + utcOffsetHours * 3600_000);
    const date = local.toISOString().slice(0, 10);
    const b = buckets.get(date) ?? { precip: [], temps: [] };
    b.precip.push(step.precipitation1hrMm);
    if (step.temperature2mC.mean !== null) b.temps.push(step.temperature2mC.mean);
    buckets.set(date, b);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, b]) => {
      const meanTempC = b.temps.length ? b.temps.reduce((x, y) => x + y, 0) / b.temps.length : null;
      const sum = (pick: keyof Percentiles) =>
        b.precip.reduce((acc, p) => acc + (p[pick] ?? 0), 0);
      const t = meanTempC ?? 0;
      return {
        date,
        snowCm: liquidToSnowCm(sum('mean'), t),
        snowCmP10: liquidToSnowCm(sum('p10'), t),
        snowCmP90: liquidToSnowCm(sum('p90'), t),
        meanTempC: meanTempC === null ? null : Math.round(meanTempC * 10) / 10,
        fallsAsRain: meanTempC !== null && meanTempC >= RAIN_THRESHOLD_C,
        derived: true as const,
      };
    });
}
