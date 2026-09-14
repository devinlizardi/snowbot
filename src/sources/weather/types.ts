/** Shared vocabulary for every weather source. Units are named in the field so
 *  nothing depends on remembering what Open-Meteo or BigQuery hands back:
 *  snowfall in cm, depths and heights in metres, temps in °C, wind in km/h. */

export type Coord = {
  lat: number;
  lon: number;
  /** Used to label base vs summit in a post, not sent to the API. */
  label?: string;
  elevationM?: number;
};

export type DailyWeather = {
  /** YYYY-MM-DD, resort-local. */
  date: string;
  snowfallCm: number | null;
  precipitationMm: number | null;
  tempMaxC: number | null;
  tempMinC: number | null;
  tempMeanC: number | null;
  windMaxKmh: number | null;
  gustMaxKmh: number | null;
  /** Midday value; the number that decides whether it falls as snow or rain. */
  freezingLevelM: number | null;
  /** End-of-day settled depth, where the model reports it. */
  snowDepthM: number | null;
};

export type ModelForecast = {
  /** The Open-Meteo `models=` value, e.g. `ecmwf_ifs025`. */
  model: string;
  coord: Coord;
  /** Model elevation at that point — often far off the real summit, which is
   *  why summit forecasts are taken at the summit coordinate, not extrapolated. */
  modelElevationM: number | null;
  days: DailyWeather[];
  /** Variables this model did not provide, so a post never implies it knows
   *  something it doesn't. */
  missingVariables: string[];
};

export type ObservedSnow = {
  coord: Coord;
  days: { date: string; snowfallCm: number | null }[];
  trailing7dCm: number;
};

export type SeasonalOutlook = {
  coord: Coord;
  /** Monthly means over the season, as CFS reports them. */
  months: { month: string; tempMeanC: number | null; precipitationMm: number | null }[];
};

/** The numbers a person would actually say out loud about a forecast window. */
export type ForecastSummary = {
  model: string;
  windowStart: string;
  windowEnd: string;
  totalSnowCm: number;
  biggestDay: { date: string; snowfallCm: number } | null;
  snowDays: number;
  coldestC: number | null;
  warmestC: number | null;
  maxGustKmh: number | null;
  /** True when any day in the window has a midday freezing level above the
   *  base — i.e. a rain risk at the bottom of the mountain. */
  rainRiskAtBase: boolean;
};

export function summarize(
  forecast: ModelForecast,
  windowStart: string,
  windowEnd: string,
  baseElevationM?: number,
): ForecastSummary {
  const days = forecast.days.filter((d) => d.date >= windowStart && d.date <= windowEnd);
  const snow = days.map((d) => d.snowfallCm ?? 0);
  const total = snow.reduce((a, b) => a + b, 0);

  let biggest: ForecastSummary['biggestDay'] = null;
  for (const d of days) {
    const cm = d.snowfallCm ?? 0;
    if (cm > 0 && (biggest === null || cm > biggest.snowfallCm)) {
      biggest = { date: d.date, snowfallCm: cm };
    }
  }

  const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const lows = nums(days.map((d) => d.tempMinC));
  const highs = nums(days.map((d) => d.tempMaxC));
  const gusts = nums(days.map((d) => d.gustMaxKmh ?? d.windMaxKmh));

  return {
    model: forecast.model,
    windowStart,
    windowEnd,
    totalSnowCm: round1(total),
    biggestDay: biggest ? { date: biggest.date, snowfallCm: round1(biggest.snowfallCm) } : null,
    // 1cm is the floor for "it snowed" — below that is noise a person wouldn't mention.
    snowDays: snow.filter((cm) => cm >= 1).length,
    coldestC: lows.length ? Math.min(...lows) : null,
    warmestC: highs.length ? Math.max(...highs) : null,
    maxGustKmh: gusts.length ? Math.round(Math.max(...gusts)) : null,
    rainRiskAtBase:
      baseElevationM !== undefined &&
      days.some((d) => d.freezingLevelM !== null && d.freezingLevelM > baseElevationM),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
