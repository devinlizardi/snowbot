import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { kvGet, kvSet, openDb, type DB } from '../src/db.js';
import { Poster } from '../src/discord/client.js';
import { LlmClient } from '../src/llm/client.js';
import type { JobContext } from '../src/jobs/_runner.js';
import {
  composeBriefing,
  composeStatus,
  isDue,
  KV_LAST_BRIEFING,
  materialChange,
  packingList,
  reportWindow,
  resolveCadence,
  runAspenUpdate,
  type AspenDeps,
  type ComposeInputs,
} from '../src/jobs/aspenUpdate.js';
import {
  fallbackRender,
  renderAspenPrompt,
  unquotedSnowNumbers,
} from '../src/llm/prompts/aspen.js';
import { buildSnowReport } from '../src/sources/weather/consensus.js';
import type { Source } from '../src/sources/types.js';
import type { Coord, DailyWeather, ModelForecast } from '../src/sources/weather/types.js';
import type { WeatherNextForecast } from '../src/sources/weather/weathernext.js';
import { log } from '../src/logger.js';

const TZ = 'America/New_York';
const noon = (date: string) => new Date(`${date}T17:00:00Z`); // noon Eastern, any season

let cfg: Config;
beforeEach(() => {
  cfg = loadConfig({
    env: { DISCORD_TEST_CHANNEL_ID: 'test-channel', DISCORD_CHANNEL_ID: 'real-channel' },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

/* ---------------------------------------------------------------- cadence */

describe('resolveCadence', () => {
  it.each([
    ['2026-09-20', 'off'], // before the season
    ['2026-10-01', 'monthly'],
    ['2026-11-01', 'monthly'],
    ['2026-11-15', 'off'], // monthly tier, not the 1st
    ['2026-12-14', 'weekly'], // a Monday, weekly_from
    ['2026-12-16', 'off'], // a Wednesday
    ['2027-01-04', 'weekly'],
    ['2027-01-19', 'daily'],
    ['2027-01-23', 'daily'],
    ['2027-01-24', 'trip'],
    ['2027-01-25', 'trip'],
    ['2027-01-30', 'trip'],
    ['2027-02-02', 'off'],
  ])('%s → %s', (date, expected) => {
    expect(resolveCadence(cfg.aspen, noon(date), TZ)).toBe(expected);
  });

  it('uses the local date, not UTC', () => {
    // 23:30 Eastern on Sunday Dec 13 is already Monday in UTC.
    expect(resolveCadence(cfg.aspen, new Date('2026-12-14T04:30:00Z'), TZ)).toBe('off');
    expect(resolveCadence(cfg.aspen, new Date('2026-12-14T04:30:00Z'), 'UTC')).toBe('weekly');
  });
});

describe('isDue', () => {
  it('never fires when off', () => {
    expect(isDue('off', noon('2027-01-20'))).toBe(false);
  });
  it('fires with no watermark and again the next day, but not twice in a day', () => {
    const now = noon('2027-01-20');
    expect(isDue('daily', now, undefined, TZ)).toBe(true);
    expect(isDue('daily', now, '2027-01-19T17:00:00.000Z', TZ)).toBe(true);
    expect(isDue('daily', now, '2027-01-20T12:05:00.000Z', TZ)).toBe(false);
    expect(isDue('daily', now, 'garbage', TZ)).toBe(true);
  });
});

describe('reportWindow', () => {
  it('looks 15 days ahead until the trip is in reach, then clamps to the trip', () => {
    expect(reportWindow('weekly', '2026-12-14', cfg.aspen)).toEqual({
      start: '2026-12-14',
      end: '2026-12-28',
    });
    expect(reportWindow('weekly', '2027-01-11', cfg.aspen)).toEqual({
      start: '2027-01-24',
      end: '2027-01-25',
    });
    expect(reportWindow('daily', '2027-01-19', cfg.aspen)).toEqual({
      start: '2027-01-24',
      end: '2027-01-30',
    });
    expect(reportWindow('trip', '2027-01-27', cfg.aspen)).toEqual({
      start: '2027-01-27',
      end: '2027-01-30',
    });
    expect(reportWindow('monthly', '2027-01-01', cfg.aspen)).toEqual({
      start: '2027-01-01',
      end: '2027-01-15',
    });
  });
});

/* --------------------------------------------------------------- fixtures */

const WINDOW = { start: '2027-01-24', end: '2027-01-30' };
/** A distinctive derived total nothing else in the fixture produces. */
const DERIVED_SENTINEL = 77.7;

function day(date: string, patch: Partial<DailyWeather> = {}): DailyWeather {
  return {
    date,
    snowfallCm: 4,
    precipitationMm: 4,
    tempMaxC: -3,
    tempMinC: -11,
    tempMeanC: -7,
    windMaxKmh: 30,
    gustMaxKmh: 45,
    freezingLevelM: 1500,
    snowDepthM: 1.1,
    ...patch,
  };
}

function forecast(
  model: string,
  coord: Coord,
  perDayCm: number,
  patch: Partial<DailyWeather> = {},
): ModelForecast {
  const days: DailyWeather[] = [];
  for (let i = 0; i < 15; i += 1) {
    const date = new Date(Date.parse('2027-01-19T00:00:00Z') + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    days.push(day(date, { snowfallCm: perDayCm, ...patch }));
  }
  return { model, coord, modelElevationM: coord.elevationM ?? null, days, missingVariables: [] };
}

/** One 6-hourly WeatherNext step; precipitation chosen so the derived total is the sentinel. */
function weathernext(coord: Coord): WeatherNextForecast {
  const steps = [];
  for (let i = 0; i < 60; i += 1) {
    const t = new Date(Date.parse('2027-01-19T07:00:00Z') + i * 6 * 3600_000).toISOString();
    const p = (v: number | null) => ({ mean: v, p10: v, p25: v, p50: v, p75: v, p90: v });
    steps.push({
      time: t,
      leadHours: i * 6,
      temperature2mC: p(-10),
      dewpoint2mC: p(-14),
      precipitation1hrMm: p(1),
      windSpeed10mMs: p(5),
    });
  }
  return {
    model: 'weathernext_3',
    coord,
    initTime: '2027-01-19T00:00:00Z',
    steps,
    bytesProcessed: 0,
  };
}

const base: Coord = { lat: 39.2097, lon: -106.9489, label: 'base', elevationM: 2470 };
const summit: Coord = { lat: 39.1856, lon: -106.9653, label: 'summit', elevationM: 3813 };

function report(perDay = { ifs: 4, aifs: 5, nam: 4, gfs: 3 }, patch: Partial<DailyWeather> = {}) {
  return buildSnowReport({
    window: WINDOW,
    base: [
      forecast('ecmwf_ifs025', base, perDay.ifs, patch),
      forecast('ecmwf_aifs025', base, perDay.aifs, patch),
      forecast('ncep_nam_conus', base, perDay.nam, patch),
      forecast('gfs_seamless', base, perDay.gfs, patch),
    ],
    summit: [forecast('ecmwf_ifs025', summit, perDay.ifs + 2, patch)],
    baseElevationM: 2470,
    summitElevationM: 3813,
  });
}

function inputs(patch: Partial<ComposeInputs> = {}): ComposeInputs {
  const r = patch.report === undefined ? report() : patch.report;
  return {
    cfg,
    cadence: 'daily',
    now: noon('2027-01-20'),
    today: '2027-01-20',
    report: r,
    ifsBase: forecast('ecmwf_ifs025', base, 4),
    ifsSummit: forecast('ecmwf_ifs025', summit, 6),
    observed: { coord: base, days: [], trailing7dCm: 12.5 },
    seasonal: null,
    baseDepth: {
      baseDepthCm: 91,
      summitDepthCm: 140,
      seasonSnowfallCm: 300,
      reportedOn: '2027-01-19',
    },
    arrivals: [
      {
        member: 'Devin',
        flight: 'UA1234',
        date: '2027-01-24',
        origin: 'JFK',
        dest: 'ASE',
        status: null,
      },
    ],
    sources: { contributing: ['a'], missing: [], stale: [] },
    ...patch,
  };
}

/* -------------------------------------------------------------- composing */

describe('composeBriefing / composeStatus', () => {
  it('carries the snow line, per-day rows, observed and base depth through', () => {
    const b = composeBriefing(inputs());
    expect(b.daysOut).toBe(4);
    expect(b.snowLine).toMatch(/^Jan 24–30: ECMWF 28cm \/ AIFS 35cm \/ NAM 28cm \/ GFS 21cm/);
    expect(b.days).toHaveLength(7);
    expect(b.days[0]).toMatchObject({
      date: '2027-01-24',
      baseCm: 4,
      summitCm: 6,
      tempMinC: -11,
      gustKmh: 45,
    });
    expect(b.observed7dCm).toBe(12.5);
    expect(b.baseDepthCm).toBe(91);
    expect(b.seasonalNote).toBeNull();
    expect(b.groundNote).toContain('ASE > EGE > DEN');
    expect(b.groundNote).toContain('Devin into ASE');

    const s = composeStatus(b, TZ);
    expect(s.baseDepthIn).toBeCloseTo(91 / 2.54);
    expect(s.nextStorm).toMatchObject({ day: 'Sun', cm: 6, confidence: b.confidence });
    expect(s.sections?.map((x) => x.title)).toEqual(['Pack', 'Arrivals']);
    expect(s.sections?.[1]?.body).toContain('UA1234');
  });

  it('survives having no sources at all', () => {
    const b = composeBriefing(
      inputs({
        report: null,
        ifsBase: null,
        ifsSummit: null,
        observed: null,
        baseDepth: null,
        arrivals: [],
      }),
    );
    expect(b.snowLine).toBeNull();
    expect(b.confidence).toBe('low');
    expect(b.days).toEqual([]);
    expect(b.packing).toEqual([]);
    expect(fallbackRender(b)).toContain('no snowfall model');
    expect(composeStatus(b, TZ).nextStorm).toBeUndefined();
  });

  it('writes the seasonal note only on the monthly cadence', () => {
    const seasonal = {
      coord: base,
      months: [{ month: '2027-01', tempMeanC: -8.5, precipitationMm: 62 }],
    };
    expect(composeBriefing(inputs({ cadence: 'monthly', seasonal })).seasonalNote).toMatch(
      /January.*-8\.5°C.*62mm/,
    );
    expect(composeBriefing(inputs({ cadence: 'weekly', seasonal })).seasonalNote).toBeNull();
  });
});

describe('packingList', () => {
  const none = {
    minC: null,
    maxGustKmh: null,
    rainRiskAtBase: false,
    biggestDayCm: null,
    totalCm: null,
  };
  it.each([
    [
      'gusts over 50',
      { ...none, maxGustKmh: 62 },
      /low-light lens and a face cover — gusts to 62 km\/h/,
    ],
    ['gusts at 50 are fine', { ...none, maxGustKmh: 50 }, null],
    ['deep cold', { ...none, minC: -18 }, /Heavier layers.*-18°C/],
    ['ordinary cold', { ...none, minC: -9 }, /mid-layer.*-9°C/],
    ['mild', { ...none, minC: -2 }, null],
    ['rain risk', { ...none, rainRiskAtBase: true }, /Waterproof shell/],
    ['big day', { ...none, biggestDayCm: 24 }, /wider board.*24cm/],
    ['dry window', { ...none, totalCm: 3 }, /Dark lens and sunscreen/],
    ['dry but wet', { ...none, totalCm: 3, rainRiskAtBase: true }, /Waterproof shell/],
  ])('%s', (_label, p, expected) => {
    const out = packingList(p);
    if (expected === null) expect(out).toEqual([]);
    else expect(out.join('\n')).toMatch(expected);
  });

  it('stacks independent rules', () => {
    expect(
      packingList({
        minC: -20,
        maxGustKmh: 70,
        rainRiskAtBase: true,
        biggestDayCm: 30,
        totalCm: 60,
      }),
    ).toHaveLength(4);
  });
});

/* --------------------------------------------------------------- prompts */

describe('fallbackRender', () => {
  it('prints the snow line and never the derived WeatherNext total', () => {
    const r = buildSnowReport({
      window: WINDOW,
      base: [forecast('ecmwf_ifs025', base, 4), forecast('gfs_seamless', base, 3)],
      weathernext: weathernext(base),
      utcOffsetHours: -7,
      baseElevationM: 2470,
      summitElevationM: 3813,
    });
    expect(r.derived).toBeDefined();
    // Pin the sentinel so the assertion below is about a real, distinctive number.
    r.derived!.totalCm = DERIVED_SENTINEL;
    const b = composeBriefing(inputs({ report: r }));
    const text = fallbackRender(b);
    expect(text).toContain(b.snowLine);
    expect(text).not.toContain(String(DERIVED_SENTINEL));
    // WeatherNext may be credited for its spread, never for a snow number.
    expect(text).not.toMatch(/weathernext[^\n]*\d+\s*cm/i);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(unquotedSnowNumbers(text, b)).toEqual([]);
    // The prompt hands Haiku the same numbers and nothing derived.
    const prompt = renderAspenPrompt(b);
    expect(prompt).not.toContain(String(DERIVED_SENTINEL));
    expect(prompt).not.toContain('"packing"');
    expect(prompt).not.toContain('"arrivals"');
  });

  it('flags a snow number the briefing never held', () => {
    const b = composeBriefing(inputs());
    expect(unquotedSnowNumbers('ECMWF 28cm and a made-up 40cm day', b)).toEqual(['40cm']);
    expect(unquotedSnowNumbers('ECMWF 28cm / AIFS 35cm, 4cm Sunday, base 91cm', b)).toEqual([]);
  });
});

describe('materialChange', () => {
  const snap = (
    totalCm: number | null,
    confidence: 'high' | 'medium' | 'low' = 'medium',
    cadence = 'weekly' as const,
  ) => ({
    cadence,
    totalCm,
    confidence,
    at: '',
  });
  it.each([
    ['first ever', null, snap(20), 'first post'],
    ['flat', snap(20), snap(30), null],
    ['15cm up', snap(20), snap(35), 'forecast moved +15cm'],
    ['16cm down', snap(20), snap(4), 'forecast moved -16cm'],
    ['confidence flip', snap(20), snap(20, 'high'), 'confidence medium → high'],
    ['new tier', snap(20), { ...snap(20), cadence: 'daily' as const }, 'first daily post'],
    ['dropped out', snap(20), snap(null), 'forecast dropped out of reach'],
  ])('%s', (_label, prev, next, expected) => {
    expect(materialChange(prev, next)).toBe(expected);
  });
});

/* ------------------------------------------------------------- the job */

describe('runAspenUpdate', () => {
  let db: DB;
  let perDay: number;
  let calls: string[];
  let completions: number;

  beforeEach(() => {
    db = openDb(':memory:');
    perDay = 4;
    calls = [];
    completions = 0;
    const id = db
      .prepare(`INSERT INTO members (name, airports_json) VALUES (?, ?)`)
      .run('Devin', '["JFK"]').lastInsertRowid;
    db.prepare(
      `INSERT INTO flights (member_id, airline, number, date, origin, dest) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, 'UA', '1234', '2027-01-24', 'JFK', 'ASE');
  });

  const deps: AspenDeps = {
    async fetch<P, R>(
      source: Source<P, R>,
      params: P,
    ): Promise<{ value: R; cached: boolean; fetchedAt: string }> {
      calls.push(source.name);
      const p = params as { coord?: Coord };
      const at = p.coord?.label === 'summit' ? summit : base;
      const model = source.name.replace('open-meteo:', '');
      const value = (() => {
        switch (source.name) {
          case 'open-meteo:ecmwf_ifs025':
          case 'open-meteo:ecmwf_aifs025':
          case 'open-meteo:ncep_nam_conus':
          case 'open-meteo:gfs_seamless':
            return forecast(model, at, perDay);
          case 'open-meteo:archive':
            return { coord: base, days: [], trailing7dCm: 9 };
          case 'open-meteo:seasonal':
            return {
              coord: base,
              months: [{ month: '2027-01', tempMeanC: -8, precipitationMm: 60 }],
            };
          default:
            throw new Error(`no stub for ${source.name}`);
        }
      })();
      return { value: value as R, cached: false, fetchedAt: '' };
    },
    async complete() {
      completions += 1;
      throw new Error('no model in tests');
    },
  };

  function ctx(date: string): JobContext {
    return {
      cfg,
      db,
      poster: new Poster(cfg, db, { dryRun: true, target: 'test', job: 'aspenUpdate' }),
      llm: new LlmClient(cfg, db, 'aspenUpdate'),
      dryRun: true,
      target: 'test',
      now: noon(date),
      log: log.child({ test: true }),
    };
  }

  const kinds = () =>
    (db.prepare(`SELECT kind FROM posts ORDER BY id`).all() as { kind: string }[]).map(
      (r) => r.kind,
    );

  it('does nothing on an off day', async () => {
    await runAspenUpdate(ctx('2026-11-15'), deps);
    expect(calls).toEqual([]);
    expect(kinds()).toEqual([]);
  });

  it('creates the anchor once, edits on a flat re-run, posts root again on a swing', async () => {
    await runAspenUpdate(ctx('2027-01-20'), deps);
    expect(kinds()).toEqual(['root']);
    expect(kvGet(db, 'anchor:test-channel')).toBeTruthy();
    expect(kvGet(db, 'aspen:last_post_daily')).toBe('2027-01-20T17:00:00.000Z');
    expect(JSON.parse(kvGet(db, KV_LAST_BRIEFING)!)).toMatchObject({
      cadence: 'daily',
      totalCm: 28,
    });
    // The base-depth lookup is asked for and skipped without a key; nothing throws.
    expect(calls).toContain('lookup:base-depth');
    expect(calls).not.toContain('weathernext:bigquery');
    expect(calls).not.toContain('open-meteo:seasonal');
    expect(completions).toBe(0); // dry run, no ANTHROPIC_API_KEY → fallback, no call

    // Same day again: the watermark holds.
    await runAspenUpdate(ctx('2027-01-20'), deps);
    expect(kinds()).toEqual(['root']);

    // Next day, same forecast: edit only.
    await runAspenUpdate(ctx('2027-01-21'), deps);
    expect(kinds()).toEqual(['root', 'edit']);

    // Next day, 7 days × 4cm → 7 × 7cm = +21cm at every model: news.
    perDay = 7;
    await runAspenUpdate(ctx('2027-01-22'), deps);
    expect(kinds()).toEqual(['root', 'edit', 'edit', 'root']);
    const last = db.prepare(`SELECT summary FROM posts ORDER BY id DESC LIMIT 1`).get() as {
      summary: string;
    };
    expect(last.summary).toContain('forecast moved +21cm');
  });

  it('honours quiet mode: the anchor is edited, the news root is held back', async () => {
    await runAspenUpdate(ctx('2027-01-20'), deps);
    kvSet(db, 'quiet_until', '2027-02-15T00:00:00Z');
    perDay = 9;
    await runAspenUpdate(ctx('2027-01-21'), deps);
    expect(kinds()).toEqual(['root', 'edit']);
    const edit = db.prepare(`SELECT summary FROM posts WHERE kind = 'edit'`).get() as {
      summary: string;
    };
    expect(edit.summary).toContain('ASPEN');
  });

  it('posts root on the first day of a new tier even when the forecast is flat', async () => {
    await runAspenUpdate(ctx('2027-01-18'), deps); // a Monday → weekly, creates the anchor
    expect(kinds()).toEqual(['root']);
    await runAspenUpdate(ctx('2027-01-19'), deps); // daily starts
    expect(kinds()).toEqual(['root', 'edit', 'root']);
    expect(kvGet(db, 'aspen:last_post_weekly')).toBeTruthy();
    expect(kvGet(db, 'aspen:last_post_daily')).toBeTruthy();
  });

  it('fetches seasonal on the monthly cadence and still posts with the forecast out of reach', async () => {
    await runAspenUpdate(ctx('2026-11-01'), deps);
    expect(calls).toContain('open-meteo:seasonal');
    expect(calls).not.toContain('lookup:base-depth');
    expect(kinds()).toEqual(['root']);
    const post = db.prepare(`SELECT summary FROM posts`).get() as { summary: string };
    expect(post.summary).toContain('84 days out');
  });

  it('never throws when every source is missing', async () => {
    const dead: AspenDeps = {
      ...deps,
      fetch: async () => {
        throw new Error('offline');
      },
    };
    await runAspenUpdate(ctx('2027-01-20'), dead);
    expect(kinds()).toEqual(['root']);
    expect(JSON.parse(kvGet(db, KV_LAST_BRIEFING)!)).toMatchObject({
      totalCm: null,
      confidence: 'low',
    });
  });

  it('uses the model when it behaves and falls back when it invents a number', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      let answer = 'ECMWF 28cm at the base, models agree.';
      const talky: AspenDeps = { ...deps, complete: async () => answer };
      await runAspenUpdate(ctx('2027-01-20'), talky);
      let post = db.prepare(`SELECT summary FROM posts ORDER BY id DESC LIMIT 1`).get() as {
        summary: string;
      };
      expect(post.summary).toContain('models agree.');

      answer = 'Expect 99cm this week.';
      await runAspenUpdate(ctx('2027-01-21'), talky);
      post = db.prepare(`SELECT summary FROM posts ORDER BY id DESC LIMIT 1`).get() as {
        summary: string;
      };
      expect(post.summary).not.toContain('99cm');
      expect(post.summary).toContain('ECMWF 28cm');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
