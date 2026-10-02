import { describe, expect, it } from 'vitest';
import {
  agreementFor,
  buildConditions,
  median,
  WEATHERNEXT,
  type BuildConditionsInput,
} from '../src/sources/weather/conditions.js';
import type { DailyWeather, ModelForecast } from '../src/sources/weather/types.js';
import type { WeatherNextForecast } from '../src/sources/weather/weathernext.js';

const WINDOW = { start: '2026-10-02', end: '2026-10-04' };
const BASE_M = 1645; // Banff / Lake Louise
const SUMMIT_M = 2637;
const COORD = { lat: 51.44, lon: -116.16, label: 'base', elevationM: BASE_M };

type Day = Partial<Omit<DailyWeather, 'date'>>;

/** Three October days; anything not given is mild, dry and calm. */
function model(name: string, days: Day[] = [{}, {}, {}]): ModelForecast {
  return {
    model: name,
    coord: COORD,
    modelElevationM: 1700,
    days: days.map((d, i) => ({
      date: `2026-10-0${2 + i}`,
      snowfallCm: 0,
      precipitationMm: 0,
      tempMaxC: 12,
      tempMinC: -1,
      tempMeanC: 5,
      windMaxKmh: 15,
      gustMaxKmh: 30,
      freezingLevelM: 3200,
      snowDepthM: 0,
      ...d,
    })),
    missingVariables: [],
  };
}

/** Hourly WeatherNext steps across the window (UTC), temperature from `tempAt(hourIndex)`. */
function weathernext(
  tempAt: (h: number) => number,
  hours = 72,
  startUtc = '2026-10-02T06:00:00Z',
): WeatherNextForecast {
  const none = { mean: null, p10: null, p25: null, p50: null, p75: null, p90: null };
  const t0 = Date.parse(startUtc);
  return {
    model: 'weathernext_3',
    coord: COORD,
    initTime: '2026-10-02T00:00:00Z',
    bytesProcessed: 0,
    steps: Array.from({ length: hours }, (_, h) => {
      const c = tempAt(h);
      return {
        time: new Date(t0 + h * 3600_000).toISOString(),
        leadHours: h + 6,
        temperature2mC: { mean: c, p10: c - 2, p25: null, p50: c, p75: null, p90: c + 2 },
        dewpoint2mC: none,
        precipitation1hrMm: { mean: 0, p10: 0, p25: null, p50: 0, p75: null, p90: 0 },
        windSpeed10mMs: none,
      };
    }),
  };
}

const build = (over: Partial<BuildConditionsInput>) =>
  buildConditions({
    window: WINDOW,
    base: [model('ecmwf_ifs025')],
    utcOffsetHours: -6,
    baseElevationM: BASE_M,
    summitElevationM: SUMMIT_M,
    ...over,
  });

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('temperature consensus', () => {
  it('takes each source’s window extremes and reports the median', () => {
    const r = build({
      base: [
        model('ecmwf_ifs025', [{ tempMinC: -2 }, { tempMinC: -4, tempMaxC: 9 }, {}]),
        model('gfs_seamless', [{ tempMinC: -3 }, {}, { tempMaxC: 14 }]),
        model('ncep_nam_conus', [{ tempMinC: -5 }, {}, {}]),
      ],
    });
    expect(r.tempLowC).toMatchObject({ value: -4, low: -5, high: -3 });
    expect(r.tempLowC?.bySource).toEqual({
      ecmwf_ifs025: -4,
      gfs_seamless: -3,
      ncep_nam_conus: -5,
    });
    expect(r.tempHighC).toMatchObject({ value: 12, low: 12, high: 14 });
    expect(r.tempSpreadC).toBe(2);
    expect(r.tempAgreement).toBe('agree');
  });

  it('calls a 7°C spread a split', () => {
    const r = build({
      base: [model('ecmwf_ifs025', [{ tempMinC: -8 }, {}, {}]), model('gfs_seamless')],
    });
    expect(r.tempSpreadC).toBe(7);
    expect(r.tempAgreement).toBe('split');
  });

  it('has no agreement to report from a single source', () => {
    const r = build({});
    expect(r.tempLowC?.value).toBe(-1);
    expect(r.tempSpreadC).toBeNull();
    expect(r.tempAgreement).toBeNull();
  });

  it('counts WeatherNext as a temperature source, on the resort’s own days', () => {
    // Hourly from 06Z Oct 2 for 72h; at UTC−6 that covers Oct 2 00:00 → Oct 4 23:00 local.
    const r = build({ weathernext: weathernext((h) => (h === 30 ? -9 : 4)) });
    expect(r.sources).toContain(WEATHERNEXT);
    expect(r.tempLowC?.bySource[WEATHERNEXT]).toBe(-9);
    expect(r.tempLowC?.value).toBe(-5); // median of −1 and −9
    expect(r.tempAgreement).toBe('split');
  });

  it('leaves WeatherNext out when its run covers too little of the window', () => {
    const r = build({ weathernext: weathernext(() => -20, 20) });
    expect(r.sources).not.toContain(WEATHERNEXT);
    expect(r.tempLowC?.value).toBe(-1);
  });

  it('buckets WeatherNext by the resort offset, not UTC', () => {
    // A single cold hour at 03Z Oct 5 is Oct 4 21:00 in Banff — inside the window.
    const late = weathernext((h) => (h === 69 ? -12 : 3), 72, '2026-10-02T06:00:00Z');
    expect(build({ weathernext: late }).tempLowC?.bySource[WEATHERNEXT]).toBe(-12);
    // At UTC it would fall on Oct 5 and be dropped.
    expect(build({ weathernext: late, utcOffsetHours: 0 }).tempLowC?.bySource[WEATHERNEXT]).toBe(3);
  });
});

describe('rain', () => {
  it('is not rain when nothing falls, however warm (the October case)', () => {
    const r = build({ base: [model('ecmwf_ifs025'), model('gfs_seamless')] });
    expect(r.rainDays).toEqual([]);
    expect(r.precipMm).toBe(0);
  });

  it('is rain when the models agree something falls and it is above freezing at the base', () => {
    const wetWarm: Day[] = [{}, { precipitationMm: 6, freezingLevelM: 2400 }, {}];
    const r = build({ base: [model('ecmwf_ifs025', wetWarm), model('gfs_seamless', wetWarm)] });
    expect(r.rainDays).toEqual(['2026-10-03']);
    expect(r.precipMm).toBe(6);
  });

  it('goes by the median day, so one wet model is not rain', () => {
    const r = build({
      base: [
        model('ecmwf_ifs025', [{}, { precipitationMm: 9 }, {}]),
        model('gfs_seamless'),
        model('ncep_nam_conus'),
      ],
    });
    expect(r.rainDays).toEqual([]);
  });

  it('falls back to the daily high where no model reports a freezing level', () => {
    const r = build({
      base: [
        model('ecmwf_aifs025', [
          { precipitationMm: 4, freezingLevelM: null, tempMaxC: 6 },
          { precipitationMm: 4, freezingLevelM: null, tempMaxC: 0 },
          {},
        ]),
      ],
    });
    expect(r.rainDays).toEqual(['2026-10-02']);
  });
});

describe('snow up high', () => {
  it('finds the lowest freezing level between base and summit on a wet day', () => {
    const r = build({
      base: [
        model('ecmwf_ifs025', [
          { precipitationMm: 3, freezingLevelM: 2500 },
          { precipitationMm: 0, freezingLevelM: 1700 }, // dry: doesn't count
          { precipitationMm: 5, freezingLevelM: 1910 },
        ]),
      ],
    });
    expect(r.snowUpHigh).toEqual({ date: '2026-10-04', freezingLevelM: 1910 });
  });

  it('says nothing when the freezing level is below the base (that is snow everywhere)', () => {
    const r = build({
      base: [model('ecmwf_ifs025', [{ precipitationMm: 3, freezingLevelM: 1200 }, {}, {}])],
    });
    expect(r.snowUpHigh).toBeNull();
  });
});

describe('wind', () => {
  it('reports the windiest day by the models’ median gust', () => {
    const r = build({
      base: [
        model('ecmwf_ifs025', [{}, { gustMaxKmh: 70 }, {}]),
        model('gfs_seamless', [{}, { gustMaxKmh: 58 }, { gustMaxKmh: 90 }]),
        model('ncep_nam_conus', [{}, { gustMaxKmh: 66 }, {}]),
      ],
    });
    expect(r.peakGust).toEqual({ kmh: 66, date: '2026-10-03' });
  });

  it('is null when no model reports gusts', () => {
    const r = build({
      base: [
        model('ecmwf_aifs025', [{ gustMaxKmh: null }, { gustMaxKmh: null }, { gustMaxKmh: null }]),
      ],
    });
    expect(r.peakGust).toBeNull();
  });
});

describe('agreementFor', () => {
  it.each([
    [0, 'agree'],
    [3, 'agree'],
    [3.1, 'partly'],
    [6, 'partly'],
    [6.1, 'split'],
  ] as const)('%s°C → %s', (spread, want) => {
    expect(agreementFor(spread)).toBe(want);
  });
});
