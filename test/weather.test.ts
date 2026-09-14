import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateHourly, parseForecast } from '../src/sources/weather/openMeteo.js';
import { parseArchive, trailingWeek } from '../src/sources/weather/archive.js';
import { parseSeasonal } from '../src/sources/weather/seasonal.js';
import { crosscheckFor, gfs, nam, iconEu, iconGlobal } from '../src/sources/weather/crosscheck.js';
import { ecmwfIfs } from '../src/sources/weather/ecmwf.js';
import { summarize } from '../src/sources/weather/types.js';

const ASPEN = { lat: 39.2084, lon: -106.949, label: 'base', elevationM: 2422 };

/** Shaped like a real Open-Meteo response, small enough to reason about. */
const sample = {
  latitude: 39.2,
  longitude: -106.95,
  elevation: 2410,
  daily: {
    time: ['2027-01-24', '2027-01-25', '2027-01-26'],
    snowfall_sum: [12.4, 0.2, 31.8],
    precipitation_sum: [8.1, 0.1, 21.0],
    temperature_2m_max: [-2.1, 1.4, -6.8],
    temperature_2m_min: [-11.2, -4.0, -15.5],
    temperature_2m_mean: [-6.5, -1.3, -11.1],
    wind_speed_10m_max: [18, 22, 41],
    wind_gusts_10m_max: [34, 39, 77],
  },
  hourly: {
    time: [
      '2027-01-24T00:00', '2027-01-24T12:00', '2027-01-24T23:00',
      '2027-01-25T00:00', '2027-01-25T12:00',
      '2027-01-26T12:00',
    ],
    snow_depth: [0.9, 1.0, 1.1, 1.1, 1.05, 1.4],
    freezing_level_height: [2200, 2600, 2300, 2900, 3100, 1800],
  },
};

describe('parseForecast', () => {
  it('maps the daily columns onto DailyWeather', () => {
    const f = parseForecast(sample, 'ecmwf_ifs025', ASPEN);
    expect(f.model).toBe('ecmwf_ifs025');
    expect(f.modelElevationM).toBe(2410);
    expect(f.days).toHaveLength(3);
    expect(f.days[0]).toMatchObject({
      date: '2027-01-24',
      snowfallCm: 12.4,
      tempMaxC: -2.1,
      tempMinC: -11.2,
      gustMaxKmh: 34,
    });
  });

  it('takes freezing level at midday and snow depth at the day maximum', () => {
    const f = parseForecast(sample, 'ecmwf_ifs025', ASPEN);
    expect(f.days[0]?.freezingLevelM).toBe(2600);
    expect(f.days[0]?.snowDepthM).toBe(1.1);
    expect(f.days[2]?.freezingLevelM).toBe(1800);
  });

  it('reports an all-null column as missing rather than as zero', () => {
    const blank = { ...sample, daily: { ...sample.daily, snowfall_sum: [null, null, null] } };
    const f = parseForecast(blank, 'gfs_seamless', ASPEN);
    expect(f.missingVariables).toContain('snowfall_sum');
    expect(f.days[0]?.snowfallCm).toBeNull();
  });

  it('carries forward variables the caller already knows are missing', () => {
    const f = parseForecast({ ...sample, hourly: undefined }, 'nam', ASPEN, ['snow_depth']);
    expect(f.missingVariables).toContain('snow_depth');
    expect(f.days[0]?.snowDepthM).toBeNull();
    expect(f.days[0]?.freezingLevelM).toBeNull();
  });

  it('survives a response with no daily block at all', () => {
    const f = parseForecast({}, 'gfs_seamless', ASPEN);
    expect(f.days).toEqual([]);
    expect(f.missingVariables.length).toBeGreaterThan(0);
  });
});

describe('aggregateHourly', () => {
  it('returns an empty map when there is no hourly block', () => {
    expect(aggregateHourly(undefined).size).toBe(0);
    expect(aggregateHourly({ time: [] }).size).toBe(0);
  });

  it('leaves freezing level null on a day with no midday reading', () => {
    const out = aggregateHourly({
      time: ['2027-01-24T03:00', '2027-01-24T06:00'],
      snow_depth: [0.5, 0.7],
      freezing_level_height: [2000, 2100],
    });
    expect(out.get('2027-01-24')).toEqual({ snowDepthM: 0.7, freezingLevelM: null });
  });
});

describe('summarize', () => {
  const f = parseForecast(sample, 'ecmwf_ifs025', ASPEN);

  it('produces the numbers a person would say out loud', () => {
    const s = summarize(f, '2027-01-24', '2027-01-26', 2422);
    expect(s.totalSnowCm).toBe(44.4);
    expect(s.biggestDay).toEqual({ date: '2027-01-26', snowfallCm: 31.8 });
    expect(s.coldestC).toBe(-15.5);
    expect(s.warmestC).toBe(1.4);
    expect(s.maxGustKmh).toBe(77);
  });

  it('does not count a 2mm dusting as a snow day', () => {
    expect(summarize(f, '2027-01-24', '2027-01-26').snowDays).toBe(2);
  });

  it('flags rain risk when the freezing level climbs above the base', () => {
    expect(summarize(f, '2027-01-24', '2027-01-26', 2422).rainRiskAtBase).toBe(true);
    // Same forecast, a base high above every freezing level: no rain risk.
    expect(summarize(f, '2027-01-24', '2027-01-26', 3500).rainRiskAtBase).toBe(false);
  });

  it('stays silent about rain risk when no base elevation is given', () => {
    expect(summarize(f, '2027-01-24', '2027-01-26').rainRiskAtBase).toBe(false);
  });

  it('clips to the window', () => {
    const s = summarize(f, '2027-01-26', '2027-01-26');
    expect(s.totalSnowCm).toBe(31.8);
    expect(s.snowDays).toBe(1);
  });

  it('handles an empty window without dividing by zero', () => {
    const s = summarize(f, '2030-01-01', '2030-01-02');
    expect(s).toMatchObject({ totalSnowCm: 0, snowDays: 0, biggestDay: null, coldestC: null });
  });
});

describe('archive', () => {
  it('sums the trailing seven days and keeps nulls out of the total', () => {
    const out = parseArchive(
      { daily: { time: ['2026-09-07', '2026-09-08', '2026-09-09'], snowfall_sum: [3.0, null, 1.5] } },
      ASPEN,
    );
    expect(out.trailing7dCm).toBe(4.5);
    expect(out.days[1]?.snowfallCm).toBeNull();
  });

  it('asks for the week ending yesterday, since today is not in the archive', () => {
    const { start, end } = trailingWeek(new Date('2026-09-14T12:00:00Z'));
    expect(end).toBe('2026-09-13');
    expect(start).toBe('2026-09-07');
  });
});

describe('seasonal', () => {
  it('buckets daily values into months', () => {
    const out = parseSeasonal(
      {
        daily: {
          time: ['2027-01-30', '2027-01-31', '2027-02-01'],
          temperature_2m_max: [0, 2, 4],
          temperature_2m_min: [-10, -8, -6],
          precipitation_sum: [5, 5, 10],
        },
      },
      ASPEN,
    );
    expect(out.months).toHaveLength(2);
    expect(out.months[0]).toEqual({ month: '2027-01', tempMeanC: -4, precipitationMm: 10 });
    expect(out.months[1]).toEqual({ month: '2027-02', tempMeanC: -1, precipitationMm: 10 });
  });
});

describe('crosscheck routing', () => {
  it('uses the regional model that actually covers the region, plus GFS', () => {
    expect(crosscheckFor('US')).toEqual([nam, gfs]);
    expect(crosscheckFor('CA')).toEqual([nam, gfs]);
    expect(crosscheckFor('EU')).toEqual([iconEu, gfs]);
    // ICON-EU does not cover Hokkaido; the global run does.
    expect(crosscheckFor('JP')).toEqual([iconGlobal, gfs]);
  });
});

describe('the Source contract', () => {
  it('keys on coordinate and horizon, so base and summit cache separately', () => {
    const base = ecmwfIfs.key({ coord: ASPEN, forecastDays: 15, ttlMinutes: 180 });
    const summit = ecmwfIfs.key({
      coord: { lat: 39.2094, lon: -106.949 },
      forecastDays: 15,
      ttlMinutes: 180,
    });
    expect(base).not.toBe(summit);
    expect(ecmwfIfs.name).toBe('open-meteo:ecmwf_ifs025');
    expect(ecmwfIfs.ttlMinutes({ coord: ASPEN, forecastDays: 15, ttlMinutes: 180 })).toBe(180);
  });
});

/**
 * These run only once someone has executed `pnpm tsx scripts/record-fixtures.ts`
 * from a machine with network access. Until then they are skipped rather than
 * failing, so the suite is honest about what has and hasn't been checked
 * against a real response.
 */
const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const recorded = existsSync(FIXTURES)
  ? readdirSync(FIXTURES).filter((f) => f.startsWith('forecast-') && f.endsWith('.json'))
  : [];

describe.skipIf(recorded.length === 0)('recorded live responses', () => {
  it.each(recorded)('%s parses into a usable forecast', (file) => {
    const json = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
    const model = file.replace(/^forecast-|\.json$/g, '');
    const f = parseForecast(json, model, ASPEN);
    expect(f.days.length).toBeGreaterThan(0);
    expect(f.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);
    expect(f.missingVariables).not.toContain('snowfall_sum');
    // A summary over the real window must not throw or produce NaN.
    const s = summarize(f, f.days[0]!.date, f.days.at(-1)!.date, 2422);
    expect(Number.isFinite(s.totalSnowCm)).toBe(true);
  });
});
