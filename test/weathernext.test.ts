import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  buildInitTimeQuery,
  buildQuery,
  kelvinToC,
  metresToMm,
  parseRows,
  weathernextSource,
} from '../src/sources/weather/weathernext.js';
import {
  RAIN_THRESHOLD_C,
  deriveSnowfall,
  liquidToSnowCm,
  snowLiquidRatio,
} from '../src/sources/weather/snowfall.js';

const ASPEN = { lat: 39.2097, lon: -106.9489 };
const TABLE = 'project-x.weathernext_3.weathernext_3_0_0_0p1deg';

describe('query construction', () => {
  const q = buildQuery(TABLE, 12);

  it('unnests the repeated forecast record', () => {
    expect(q).toContain('t.forecast AS f');
  });

  it('prunes the partition — the expensive mistake this project can make', () => {
    expect(q).toContain('t.init_time >=');
    expect(q).toContain('TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 12 HOUR)');
    expect(q).toContain('t.init_time = @initTime');
  });

  it('prunes the cluster with a geography intersect', () => {
    expect(q).toContain('ST_INTERSECTS(t.geography_polygon');
  });

  it('never selects star', () => {
    expect(q).not.toMatch(/SELECT\s+\*/i);
  });

  it('asks for every percentile of every variable it needs', () => {
    for (const p of ['mean', 'p10', 'p25', 'p50', 'p75', 'p90']) {
      expect(q).toContain(`temperature_2m_${p}`);
      expect(q).toContain(`total_precipitation_1hr_${p}`);
    }
  });

  it('bounds the init-time lookup too', () => {
    expect(buildInitTimeQuery(TABLE, 12)).toContain('WHERE init_time >=');
  });
});

describe('unit conversion', () => {
  it('converts the Kelvin and metres the table actually stores', () => {
    expect(kelvinToC(273.15)).toBeCloseTo(0);
    expect(kelvinToC(263.15)).toBeCloseTo(-10);
    expect(metresToMm(0.0042)).toBeCloseTo(4.2);
  });
});

describe('parseRows', () => {
  const rows = [
    {
      forecast_time: { value: '2027-01-24T06:00:00.000Z' },
      lead_hours: 6,
      temperature_2m_mean: 265.15,
      temperature_2m_p10: 262.15,
      temperature_2m_p90: 268.15,
      total_precipitation_1hr_mean: 0.002,
      total_precipitation_1hr_p10: 0.0005,
      total_precipitation_1hr_p90: 0.004,
    },
  ];

  it('converts units and preserves the percentile band', () => {
    const f = parseRows(rows, ASPEN, '2027-01-24T00:00:00Z', 1234);
    const step = f.steps[0]!;
    expect(step.temperature2mC.mean).toBeCloseTo(-8);
    expect(step.temperature2mC.p10).toBeCloseTo(-11);
    expect(step.temperature2mC.p90).toBeCloseTo(-5);
    expect(step.precipitation1hrMm.mean).toBeCloseTo(2);
    expect(step.leadHours).toBe(6);
    expect(f.initTime).toBe('2027-01-24T00:00:00Z');
    expect(f.bytesProcessed).toBe(1234);
  });

  it('leaves absent percentiles null rather than zero', () => {
    const f = parseRows(rows, ASPEN, 'x');
    expect(f.steps[0]!.temperature2mC.p50).toBeNull();
    expect(f.steps[0]!.windSpeed10mMs.mean).toBeNull();
  });

  it('accepts a plain string timestamp as well as a BigQuery wrapper', () => {
    const f = parseRows([{ ...rows[0], forecast_time: '2027-01-24T06:00:00Z' }], ASPEN, 'x');
    expect(f.steps[0]!.time).toBe('2027-01-24T06:00:00Z');
  });
});

describe('the Source contract', () => {
  it('refuses to run without a project and dataset', async () => {
    const cfg = loadConfig({ env: {} });
    await expect(
      weathernextSource(cfg).fetch({ coord: ASPEN, hours: 360, ttlMinutes: 180 }),
    ).rejects.toThrow(/GCP_PROJECT_ID/);
  });

  it('keys on coordinate and horizon', () => {
    const cfg = loadConfig({ env: { GCP_PROJECT_ID: 'p', GCP_DATASET_ID: 'weathernext_3' } });
    const s = weathernextSource(cfg);
    expect(s.key({ coord: ASPEN, hours: 360, ttlMinutes: 1 })).toBe('39.210,-106.949:360h');
  });
});

describe('snow-liquid ratio', () => {
  it('is zero above the rain threshold', () => {
    expect(snowLiquidRatio(RAIN_THRESHOLD_C)).toBe(0);
    expect(snowLiquidRatio(5)).toBe(0);
    expect(liquidToSnowCm(20, 5)).toBe(0);
  });

  it('peaks in the cold-and-dry band, not at the coldest temperature', () => {
    expect(snowLiquidRatio(-15)).toBeGreaterThan(snowLiquidRatio(-1));
    expect(snowLiquidRatio(-15)).toBeGreaterThan(snowLiquidRatio(-30));
  });

  it('converts liquid to a plausible snow total', () => {
    // 10mm of liquid at -15°C is a proper powder day.
    expect(liquidToSnowCm(10, -15)).toBe(20);
    // The same liquid just below freezing is half that, and heavy.
    expect(liquidToSnowCm(10, -1)).toBe(10);
  });
});

describe('deriveSnowfall', () => {
  const step = (time: string, precipMm: number, tempC: number) => ({
    time,
    leadHours: 0,
    temperature2mC: { mean: tempC, p10: tempC - 2, p25: null, p50: null, p75: null, p90: tempC + 2 },
    dewpoint2mC: { mean: null, p10: null, p25: null, p50: null, p75: null, p90: null },
    precipitation1hrMm: {
      mean: precipMm,
      p10: precipMm * 0.4,
      p25: null,
      p50: null,
      p75: null,
      p90: precipMm * 1.8,
    },
    windSpeed10mMs: { mean: null, p10: null, p25: null, p50: null, p75: null, p90: null },
  });

  const forecast = {
    model: 'weathernext_3' as const,
    coord: ASPEN,
    initTime: '2027-01-24T00:00:00Z',
    bytesProcessed: 0,
    steps: [
      step('2027-01-24T06:00:00Z', 2, -14),
      step('2027-01-24T12:00:00Z', 3, -14),
      step('2027-01-25T06:00:00Z', 1, 6),
    ],
  };

  it('buckets steps into days and sums the liquid', () => {
    const days = deriveSnowfall(forecast);
    expect(days).toHaveLength(2);
    expect(days[0]!.date).toBe('2027-01-24');
    // 5mm at -14°C, ratio 20 -> 10cm
    expect(days[0]!.snowCm).toBe(10);
  });

  it('carries the ensemble spread through the conversion', () => {
    const [day] = deriveSnowfall(forecast);
    expect(day!.snowCmP10).toBeLessThan(day!.snowCm);
    expect(day!.snowCmP90).toBeGreaterThan(day!.snowCm);
  });

  it('marks a warm day as rain rather than reporting snow', () => {
    const days = deriveSnowfall(forecast);
    expect(days[1]!.fallsAsRain).toBe(true);
    expect(days[1]!.snowCm).toBe(0);
  });

  it('always flags itself as derived, so a post can never imply otherwise', () => {
    expect(deriveSnowfall(forecast).every((d) => d.derived === true)).toBe(true);
  });

  it('buckets by resort-local day, not UTC', () => {
    // 22:00 UTC is the next calendar day in Japan (UTC+9).
    const jp = { ...forecast, steps: [step('2027-02-12T22:00:00Z', 4, -10)] };
    expect(deriveSnowfall(jp, 9)[0]!.date).toBe('2027-02-13');
    expect(deriveSnowfall(jp, 0)[0]!.date).toBe('2027-02-12');
  });

  it('survives an unparseable timestamp', () => {
    const bad = { ...forecast, steps: [step('not-a-time', 4, -10)] };
    expect(deriveSnowfall(bad)).toEqual([]);
  });
});
