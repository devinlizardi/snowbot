import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config, type Destination } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import {
  choosePicks,
  parsePriceButton,
  priceButtonId,
  runScout,
  sameStorm,
  travelFor,
  type ScoutCandidate,
} from '../src/scout.js';
import type { SnapshotFetch } from '../src/snapshot.js';
import type { PassAccess } from '../src/sources/lookup.js';
import type { Fetched, Source } from '../src/sources/types.js';
import type { Coord, DailyWeather, ModelForecast } from '../src/sources/weather/types.js';

/* Sun Dec 20 2026, noon Eastern. */
const NOW = new Date('2026-12-20T17:00:00Z');

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
};

let cfg: Config;
let db: DB;
beforeEach(() => {
  cfg = loadConfig({ env: {} });
  db = openDb(':memory:');
});

const by = (id: string): Destination => cfg.board.find((d) => d.id === id)!;

/** Per spot id, per model, snowfall (cm) by day index from Dec 20. */
type Storms = Record<string, Record<string, Record<number, number>>>;

function day(i: number, cm: number): DailyWeather {
  const date = new Date(Date.UTC(2026, 11, 20 + i)).toISOString().slice(0, 10);
  return {
    date,
    snowfallCm: cm,
    precipitationMm: cm,
    tempMaxC: -2,
    tempMinC: -10,
    tempMeanC: -6,
    windMaxKmh: 15,
    gustMaxKmh: 30,
    freezingLevelM: 1000,
    snowDepthM: 1,
  };
}

/** Answers forecasts from `storms`, the archive with a small trailing week; records every source asked. */
function fake(storms: Storms, asked: string[]): SnapshotFetch {
  return async <P, R>(source: Source<P, R>, params: P): Promise<Fetched<R>> => {
    asked.push(source.name);
    const coord = (params as { coord: Coord }).coord;
    const dest = cfg.board.find((d) => d.lat === coord.lat && d.lon === coord.lon);
    let value: unknown;
    if (source.name === 'open-meteo:archive') {
      value = { coord, days: [], trailing7dCm: 6 };
    } else {
      const model = source.name.replace('open-meteo:', '');
      const s = (dest && storms[dest.id]?.[model]) ?? {};
      const f: ModelForecast = {
        model,
        coord,
        modelElevationM: null,
        utcOffsetSeconds: 0,
        missingVariables: [],
        days: Array.from({ length: 16 }, (_, i) => day(i, s[i] ?? 0)),
      };
      value = f;
    }
    return { value: value as R, cached: true, fetchedAt: '2026-12-20 16:00:00' };
  };
}

/** The same storm in every snowfall model the spot's region uses. */
function storm(
  days: Record<number, number>,
  models = [
    'ecmwf_ifs025',
    'ecmwf_aifs025',
    'ncep_nam_conus',
    'gfs_seamless',
    'icon_global',
    'icon_eu',
  ],
) {
  return Object.fromEntries(models.map((m) => [m, days]));
}

const BLACKOUTS: PassAccess = {
  onPass: true,
  daysLimit: 'unlimited',
  blackouts: [
    { start: '2026-12-26', end: '2026-12-30' },
    { start: '2027-01-16', end: '2027-01-17' },
    { start: '2027-02-13', end: '2027-02-14' },
  ],
  notes: '',
};

describe('runScout', () => {
  it('ranks on weather alone and never asks a pricing source', async () => {
    const asked: string[] = [];
    const r = await runScout(
      { cfg, db, log: quiet, now: NOW },
      {
        offline: true,
        weathernext: false,
        fetch: fake({ mammoth: storm({ 2: 20, 3: 15 }), niseko: storm({ 1: 25, 2: 25 }) }, asked),
      },
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((n) => /serpapi|flights|hotels|lodging/i.test(n))).toEqual([]);
    expect(r.picks.map((p) => p.dest.id).sort()).toEqual(['mammoth', 'niseko']);
    expect(r.text).toMatch(/^🔭 \*\*What's worth watching\*\*/);
    expect(r.text).not.toMatch(/\$/);
    expect(r.buttons.map((b) => b.customId)).toContain('price:mammoth:2026-12-22:2026-12-24');
  });

  it('never picks two spots under the same storm, or two from one group', async () => {
    const r = await runScout(
      { cfg, db, log: quiet, now: NOW },
      {
        offline: true,
        weathernext: false,
        fetch: fake({ snowbird: storm({ 3: 30 }), solitude: storm({ 3: 28 }) }, []),
      },
    );
    expect(r.picks.map((p) => p.dest.id)).toEqual(['snowbird']);
  });

  it('shows the blackout when the suggested window touches Dec 26–30', async () => {
    const r = await runScout(
      { cfg, db, log: quiet, now: NOW },
      {
        offline: true,
        weathernext: false,
        fetch: fake({ 'big-bear': storm({ 6: 20, 5: 10 }) }, []),
        passAccess: async () => BLACKOUTS,
      },
    );
    const pick = r.picks[0]!;
    expect(pick.window).toEqual({ start: '2026-12-26', end: '2026-12-28' });
    expect(pick.pass?.blackoutDates).toEqual(['2026-12-26', '2026-12-27', '2026-12-28']);
    expect(r.text).toContain('🎟️ Ikon Base Pass: unlimited — blacked out Dec 26–28.');
  });

  it("says nothing's going off when nothing clears the bar, with the earliest signal", async () => {
    const quietWeek = await runScout(
      { cfg, db, log: quiet, now: NOW },
      { offline: true, weathernext: false, fetch: fake({}, []) },
    );
    expect(quietWeek.picks).toEqual([]);
    expect(quietWeek.buttons).toEqual([]);
    expect(quietWeek.text).toContain(
      "🧊 **Nothing's going off yet** — no storm in the 15-day models that two of them agree on.",
    );

    // A small day two models agree on is a signal worth naming, not a pick.
    const early = await runScout(
      { cfg, db, log: quiet, now: NOW },
      { offline: true, weathernext: false, fetch: fake({ stratton: storm({ 11: 6 }) }, []) },
    );
    expect(early.picks).toEqual([]);
    expect(early.text).toContain('the earliest real signal is Stratton around Thu Dec 31');
  });
});

describe('choosePicks / sameStorm', () => {
  it('treats close spots with lined-up peaks as one storm, even across groups', () => {
    const palisades = by('palisades');
    const nearby: Destination = {
      ...by('snowbird'),
      id: 'test-near',
      lat: palisades.lat + 0.5,
      lon: palisades.lon + 0.5,
    };
    expect(
      sameStorm(
        { dest: palisades, peakDay: '2026-12-23' },
        { dest: nearby, peakDay: '2026-12-24' },
        500,
      ),
    ).toBe(true);
    expect(
      sameStorm(
        { dest: palisades, peakDay: '2026-12-23' },
        { dest: nearby, peakDay: '2026-12-27' },
        500,
      ),
    ).toBe(false);
    expect(
      sameStorm(
        { dest: palisades, peakDay: '2026-12-23' },
        { dest: by('niseko'), peakDay: '2026-12-23' },
        500,
      ),
    ).toBe(false);
  });

  it('drops a candidate with no real snow, however good its history', () => {
    const c: ScoutCandidate = {
      dest: by('niseko'),
      row: {
        snow: { models: [], days: [], confidence: 'high' },
        lookAhead: null,
      } as unknown as ScoutCandidate['row'],
      observed7dCm: 0,
      historical: 1,
      historicalReason: null,
    };
    expect(choosePicks([c], cfg)).toEqual([]);
  });
});

describe('travelFor', () => {
  it('splits drivers and flyers from the roster airports', () => {
    expect(travelFor(cfg.members, by('big-bear'))).toEqual({
      drive: ['M3', 'M4'],
      fly: ['M1', 'M2', 'M5'],
    });
    expect(travelFor(cfg.members, by('stratton'))).toEqual({
      drive: ['M1', 'M2'],
      fly: ['M3', 'M4', 'M5'],
    });
    expect(travelFor(cfg.members, by('niseko')).drive).toEqual([]);
  });
});

describe('price button', () => {
  it('round-trips spot and window through the custom id', () => {
    const id = priceButtonId('winter-park', { start: '2027-01-08', end: '2027-01-12' });
    expect(id).toBe('price:winter-park:2027-01-08:2027-01-12');
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parsePriceButton(id)).toEqual({
      destination: 'winter-park',
      window: { start: '2027-01-08', end: '2027-01-12' },
    });
    expect(parsePriceButton('price:x:2027-01-12:2027-01-08')).toBeNull();
    expect(parsePriceButton('watch:niseko')).toBeNull();
  });
});
