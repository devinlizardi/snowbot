import { describe, expect, it } from 'vitest';
import {
  agreementOf,
  assertNoDerivedInQuoted,
  buildSnowReport,
  decideConfidence,
  formatSnowLine,
  type SnowReport,
} from '../src/sources/weather/consensus.js';
import type { DailyWeather, ModelForecast } from '../src/sources/weather/types.js';
import type { WeatherNextForecast } from '../src/sources/weather/weathernext.js';

const WINDOW = { start: '2027-01-24', end: '2027-01-26' };
const BASE_M = 2422;
const SUMMIT_M = 3418;
const BASE = { lat: 39.2084, lon: -106.949, label: 'base', elevationM: BASE_M };
const SUMMIT = { lat: 39.19, lon: -106.94, label: 'summit', elevationM: SUMMIT_M };

/** A model forecast from a list of daily snowfall cm, with sane other fields. */
function model(
  name: string,
  snow: (number | null)[],
  opts: { label?: 'base' | 'summit'; freezingLevelM?: number; missing?: string[] } = {},
): ModelForecast {
  const days: DailyWeather[] = snow.map((cm, i) => ({
    date: `2027-01-${24 + i}`,
    snowfallCm: cm,
    precipitationMm: cm === null ? null : cm / 12,
    tempMaxC: -3 + i,
    tempMinC: -12 - i,
    tempMeanC: -7,
    windMaxKmh: 20 + i * 5,
    gustMaxKmh: 40 + i * 10,
    freezingLevelM: opts.freezingLevelM ?? 1800,
    snowDepthM: 1,
  }));
  return {
    model: name,
    coord: opts.label === 'summit' ? SUMMIT : BASE,
    modelElevationM: 2410,
    days,
    missingVariables: opts.missing ?? [],
  };
}

/** WeatherNext steps: one per day at 12Z, precipitation with a chosen spread. */
function weathernext(precipMm: number[], spread: number, tempC = -10): WeatherNextForecast {
  const pct = (mean: number, s: number) => ({
    mean,
    p10: Math.max(0, mean * (1 - s)),
    p25: null,
    p50: mean,
    p75: null,
    p90: mean * (1 + s),
  });
  const none = { mean: null, p10: null, p25: null, p50: null, p75: null, p90: null };
  return {
    model: 'weathernext_3',
    coord: BASE,
    initTime: '2027-01-23T00:00:00Z',
    bytesProcessed: 0,
    steps: precipMm.map((mm, i) => ({
      time: `2027-01-${24 + i}T12:00:00Z`,
      leadHours: 36 + i * 24,
      temperature2mC: pct(tempC, 0),
      dewpoint2mC: none,
      precipitation1hrMm: pct(mm, spread),
      windSpeed10mMs: none,
    })),
  };
}

const build = (over: Partial<Parameters<typeof buildSnowReport>[0]>) =>
  buildSnowReport({
    window: WINDOW,
    base: [],
    baseElevationM: BASE_M,
    summitElevationM: SUMMIT_M,
    ...over,
  });

describe('agreement and confidence, table-driven', () => {
  const cases: {
    name: string;
    totals: number[][];
    spread: number | null;
    confidence: SnowReport['confidence'];
    phrase: RegExp;
  }[] = [
    {
      name: 'three models agree, tight ensemble',
      totals: [
        [14, 10, 18],
        [12, 11, 17],
        [15, 9, 14],
      ],
      spread: 0.3,
      confidence: 'high',
      phrase: /models agree and WeatherNext's ensemble is tight, high confidence/,
    },
    {
      name: 'three models agree, no WeatherNext',
      totals: [
        [14, 10, 18],
        [12, 11, 17],
        [15, 9, 14],
      ],
      spread: null,
      confidence: 'high',
      phrase: /models agree and no WeatherNext run to check the spread against, high confidence/,
    },
    {
      name: 'two models agree, no WeatherNext — not enough to call high',
      totals: [
        [14, 10, 18],
        [12, 11, 17],
      ],
      spread: null,
      confidence: 'medium',
      phrase: /models agree/,
    },
    {
      name: 'models agree but the ensemble is middling',
      totals: [
        [14, 10, 18],
        [12, 11, 17],
        [15, 9, 14],
      ],
      spread: 0.6,
      confidence: 'medium',
      phrase: /ensemble is middling, medium confidence/,
    },
    {
      name: 'models split, tight ensemble',
      totals: [
        [30, 25, 20],
        [5, 2, 0],
        [20, 10, 10],
      ],
      spread: 0.3,
      confidence: 'low',
      phrase: /models disagree/,
    },
    {
      name: 'models agree but the ensemble is wide open',
      totals: [
        [14, 10, 18],
        [12, 11, 17],
        [15, 9, 14],
      ],
      spread: 1.0,
      confidence: 'low',
      phrase: /ensemble is wide open, low confidence/,
    },
    {
      name: 'broad agreement lands in the middle',
      // 40 / 20 / 30cm: CV about 0.27, so agreement lands around 0.73.
      totals: [
        [20, 10, 10],
        [10, 5, 5],
        [15, 10, 5],
      ],
      spread: 0.3,
      confidence: 'medium',
      phrase: /models broadly agree/,
    },
  ];

  it.each(cases)('$name', ({ totals, spread, confidence, phrase }) => {
    const names = ['ecmwf_ifs025', 'gfs_seamless', 'icon_global'];
    const report = build({
      base: totals.map((t, i) => model(names[i]!, t)),
      ...(spread === null ? {} : { weathernext: weathernext([6, 5, 7], spread) }),
    });
    expect(report.confidence).toBe(confidence);
    expect(report.explanation).toMatch(phrase);
    // The sentence must read like a person wrote it: starts with the quoted
    // totals, ends with a full stop, no raw model ids.
    expect(report.explanation).toMatch(/^ECMWF \d+cm \/ GFS \d+cm/);
    expect(report.explanation).toMatch(/\.$/);
    expect(report.explanation).not.toMatch(/ecmwf_ifs025|gfs_seamless/);
    assertNoDerivedInQuoted(report);
  });

  it('scores identical totals as perfect agreement and a split as none', () => {
    expect(agreementOf([40, 40, 40])).toBe(1);
    expect(agreementOf([40, 0])).toBe(0);
    expect(agreementOf([42, 35, 38])!).toBeGreaterThan(0.85);
  });

  it('does not treat a dusting as a disagreement', () => {
    // 1cm vs 3cm is a 50% CV, but nobody cares about the difference.
    expect(agreementOf([1, 3])!).toBeGreaterThan(0.75);
  });

  it('agrees about a dry window', () => {
    expect(agreementOf([0, 0, 0])).toBe(1);
  });

  it('never rates a single model high, whatever the ensemble says', () => {
    expect(decideConfidence(1, null, { p10Mm: 5, meanMm: 6, p90Mm: 7, relativeWidth: 0.1 })).toBe(
      'medium',
    );
    expect(decideConfidence(1, null, null)).toBe('low');
    expect(decideConfidence(0, null, null)).toBe('low');
  });
});

describe('one model', () => {
  it('says so in the explanation and caps confidence at medium', () => {
    const report = build({
      base: [model('ecmwf_ifs025', [20, 12, 10])],
      weathernext: weathernext([6, 5, 7], 0.2),
    });
    expect(report.models).toEqual([{ model: 'ecmwf_ifs025', totalCm: 42, source: 'modelled' }]);
    expect(report.agreement).toBeNull();
    expect(report.confidence).toBe('medium');
    expect(report.explanation).toMatch(/^ECMWF 42cm — only one model reported/);
    expect(report.explanation).toMatch(/cannot be better than medium; medium confidence\.$/);
  });

  it('is low without a WeatherNext run to lean on', () => {
    const report = build({ base: [model('ecmwf_ifs025', [20, 12, 10])] });
    expect(report.confidence).toBe('low');
    expect(report.ensembleBand).toBeNull();
    expect(report.asOf.weathernext).toBeNull();
  });
});

describe('missing inputs', () => {
  it('leaves a model out of the quoted totals when it has no snowfall variable', () => {
    const report = build({
      base: [
        model('ecmwf_ifs025', [20, 12, 10]),
        model('ncep_nam_conus', [null, null, null], { missing: ['snowfall_sum'] }),
      ],
    });
    expect(report.models.map((m) => m.model)).toEqual(['ecmwf_ifs025']);
    expect(report.asOf.missing).toEqual([
      { model: 'ncep_nam_conus', reason: 'model does not report snowfall' },
    ]);
    expect(report.asOf.contributing).toEqual(['ecmwf_ifs025']);
  });

  it('leaves a model out when none of its days fall inside the window', () => {
    const late = model('gfs_seamless', [5, 5, 5]);
    late.days = late.days.map((d) => ({ ...d, date: d.date.replace('2027-01', '2027-02') }));
    const report = build({ base: [model('ecmwf_ifs025', [20, 12, 10]), late] });
    expect(report.asOf.missing[0]?.reason).toMatch(/no days inside the window/);
  });

  it('reports nothing quotable rather than inventing a total', () => {
    const report = build({ base: [] });
    expect(report.models).toEqual([]);
    expect(report.confidence).toBe('low');
    expect(formatSnowLine(report)).toBe('Jan 24–26: no snowfall model reported for this window');
    assertNoDerivedInQuoted(report);
  });

  it('has no ensemble band or derived block without WeatherNext', () => {
    const report = build({ base: [model('ecmwf_ifs025', [1, 1, 1])] });
    expect(report.ensembleBand).toBeNull();
    expect(report.derived).toBeUndefined();
    expect('derived' in report).toBe(false);
  });
});

describe('per-day rows', () => {
  it('lays out every date in the window with a column per quoted model', () => {
    const report = build({
      base: [model('ecmwf_ifs025', [20, 12, 10]), model('gfs_seamless', [18, null, 9])],
    });
    expect(report.days.map((d) => d.date)).toEqual(['2027-01-24', '2027-01-25', '2027-01-26']);
    expect(report.days[1]).toEqual({
      date: '2027-01-25',
      base: { ecmwf_ifs025: 12, gfs_seamless: null },
      summit: null,
    });
  });

  it('carries summit rows and totals when summit forecasts are supplied', () => {
    const report = build({
      base: [model('ecmwf_ifs025', [20, 12, 10])],
      summit: [model('ecmwf_ifs025', [30, 18, 15], { label: 'summit' })],
    });
    expect(report.days[0]?.summit).toEqual({ ecmwf_ifs025: 30 });
    expect(report.summitModels).toEqual([
      { model: 'ecmwf_ifs025', totalCm: 63, source: 'modelled' },
    ]);
    expect(report.summitNote).toMatch(/models' own forecasts at the summit point \(3418m\)/);
    expect(formatSnowLine(report)).toContain('(summit ECMWF 63cm)');
  });
});

describe('summit note without summit forecasts', () => {
  it('admits it is base only and gives the lapse-rate picture without a number', () => {
    const report = build({ base: [model('ecmwf_ifs025', [20, 12, 10])] });
    expect(report.summitNote).toMatch(/^Base only \(2422m\)/);
    // 996m higher at 6.5°C/km is about 6°C.
    expect(report.summitNote).toMatch(/996m higher, so expect it roughly 6°C colder/);
    expect(report.summitNote).toMatch(/no summit total is being quoted/);
    expect(report.summitModels).toEqual([]);
    expect(formatSnowLine(report)).not.toContain('summit');
  });
});

describe('conditions', () => {
  it('reads temperature and gust extremes across all models', () => {
    const report = build({
      base: [model('ecmwf_ifs025', [20, 12, 10]), model('gfs_seamless', [18, 8, 9])],
    });
    expect(report.tempRange).toEqual({ minC: -14, maxC: -1 });
    expect(report.maxGustKmh).toBe(60);
  });

  it('flags rain risk when a freezing level sits above the base', () => {
    const dry = build({ base: [model('ecmwf_ifs025', [20, 12, 10], { freezingLevelM: 1800 })] });
    const wet = build({ base: [model('ecmwf_ifs025', [20, 12, 10], { freezingLevelM: 2900 })] });
    expect(dry.rainRiskAtBase).toBe(false);
    expect(wet.rainRiskAtBase).toBe(true);
    expect(formatSnowLine(wet)).toMatch(/rain risk at the base$/);
    expect(wet.explanation).toMatch(/with a rain risk at the base\.$/);
  });

  it('also flags rain risk when WeatherNext says the day is too warm to snow', () => {
    const report = build({
      base: [model('ecmwf_ifs025', [20, 12, 10])],
      weathernext: weathernext([6, 5, 7], 0.2, 4),
    });
    expect(report.rainRiskAtBase).toBe(true);
    expect(report.derived?.totalCm).toBe(0);
  });
});

describe('WeatherNext stays in its lane', () => {
  // 30mm/day at -10°C is 51cm/day through the 17:1 ratio — a derived total of
  // ~153cm that dwarfs every modelled number. It must still never be quoted.
  const bigDerived = weathernext([30, 30, 30], 0.2, -10);
  const report = build({
    base: [model('ecmwf_ifs025', [20, 12, 10]), model('gfs_seamless', [18, 8, 9])],
    weathernext: bigDerived,
  });

  it('keeps the derived estimate in its own field, marked derived', () => {
    expect(report.derived).toMatchObject({ source: 'derived' });
    expect(report.derived!.totalCm).toBeGreaterThan(100);
    expect(report.derived!.p10).toBeLessThan(report.derived!.totalCm);
    expect(report.derived!.p90).toBeGreaterThan(report.derived!.totalCm);
    expect(report.derived!.days.every((d) => d.derived)).toBe(true);
  });

  it('never lists it among the quoted models', () => {
    expect(report.models.every((m) => m.source === 'modelled')).toBe(true);
    expect(report.models.map((m) => m.totalCm)).not.toContain(report.derived!.totalCm);
    expect(report.asOf.contributing).not.toContain('weathernext_3');
  });

  it('never prints it in the snow line, even though it is the biggest number', () => {
    const line = formatSnowLine(report);
    expect(line).toBe('Jan 24–26: ECMWF 42cm / GFS 35cm — high confidence');
    expect(line).not.toContain(String(Math.round(report.derived!.totalCm)));
    expect(line).not.toMatch(/weathernext|derived/i);
    expect(() => assertNoDerivedInQuoted(report)).not.toThrow();
  });

  it('the invariant catches a report that has been tampered with', () => {
    const tampered: SnowReport = {
      ...report,
      models: [
        ...report.models,
        {
          model: 'weathernext_3',
          totalCm: report.derived!.totalCm,
          source: 'derived' as 'modelled',
        },
      ],
    };
    expect(() => assertNoDerivedInQuoted(tampered)).toThrow(/not modelled/);
  });

  it('measures the ensemble band on precipitation, not on the derived snow', () => {
    expect(report.ensembleBand).toEqual({
      p10Mm: 72,
      meanMm: 90,
      p90Mm: 108,
      relativeWidth: 0.4,
    });
    expect(report.asOf.weathernext).toEqual({ initTime: '2027-01-23T00:00:00Z' });
  });

  it('buckets steps into resort-local days before clipping to the window', () => {
    // 04:00 UTC on the 27th is still the 26th in Aspen (UTC-7), so it counts.
    const wn = weathernext([6, 6, 6], 0.2);
    wn.steps.push({ ...wn.steps[0]!, time: '2027-01-27T04:00:00Z' });
    const local = build({
      base: [model('ecmwf_ifs025', [1, 1, 1])],
      weathernext: wn,
      utcOffsetHours: -7,
    });
    const utc = build({ base: [model('ecmwf_ifs025', [1, 1, 1])], weathernext: wn });
    expect(local.ensembleBand!.meanMm).toBe(24);
    expect(utc.ensembleBand!.meanMm).toBe(18);
  });
});

describe('formatSnowLine', () => {
  it('spells out a window that crosses a month boundary', () => {
    const report = build({
      window: { start: '2027-01-30', end: '2027-02-02' },
      base: [{ ...model('ecmwf_ifs025', [1, 1, 1]), days: [] }],
    });
    expect(formatSnowLine(report)).toMatch(/^Jan 30–Feb 2:/);
  });

  it('names an unknown model by its raw id rather than dropping it', () => {
    const report = build({ base: [model('some_new_model', [5, 5, 5])] });
    expect(formatSnowLine(report)).toContain('some_new_model 15cm');
  });
});
