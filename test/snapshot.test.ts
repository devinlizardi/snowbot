import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import {
  assertSnapshotHonest,
  BLOCK_MAX_COLS,
  cellText,
  composeSnapshot,
  DISCORD_MAX_CHARS,
  gatherSnapshot,
  pickCallouts,
  pool,
  renderSnapshot,
  runSnapshot,
  SNAPSHOT_UNAVAILABLE,
  snapshotSpots,
  type SnapshotFetch,
  type Spot,
} from '../src/snapshot.js';
import type { Fetched, Source } from '../src/sources/types.js';
import type { DailyWeather, ModelForecast, Coord } from '../src/sources/weather/types.js';
import type { WeatherNextForecast } from '../src/sources/weather/weathernext.js';

/* Fri Oct 2 2026, 1:20pm Eastern. */
const NOW = new Date('2026-10-02T17:20:00Z');
const FETCHED_AT = '2026-10-02 16:40:00'; // 12:40 EDT

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
};

let cfg: Config;
let db: DB;
let spots: Spot[];
beforeAll(() => {
  cfg = loadConfig({ env: {} });
  db = openDb(':memory:');
  spots = snapshotSpots(cfg);
});

/* ------------------------------------------------------------- fixtures */

type Day = Partial<Omit<DailyWeather, 'date'>>;
/** Per spot id, per model, a function of the day index (0 = Oct 1) → overrides. */
type Scenario = Record<string, Record<string, (i: number) => Day>>;

const UTC_OFFSET: Record<string, number> = { JP: 9, CA: -7, US: -6, EU: 2 };

function forecast(
  model: string,
  coord: Coord,
  region: string,
  day: (i: number) => Day,
): ModelForecast {
  return {
    model,
    coord,
    modelElevationM: coord.elevationM ?? null,
    utcOffsetSeconds: (UTC_OFFSET[region] ?? 0) * 3600,
    missingVariables: [],
    days: Array.from({ length: 16 }, (_, i) => ({
      date: `2026-10-${String(1 + i).padStart(2, '0')}`,
      snowfallCm: 0,
      precipitationMm: 0,
      tempMaxC: 14,
      tempMinC: 2,
      tempMeanC: 8,
      windMaxKmh: 15,
      gustMaxKmh: 30,
      freezingLevelM: 3900,
      snowDepthM: 0,
      ...day(i),
    })),
  };
}

/** Hourly WeatherNext, cold and wet: its *derived* snow is large, and must never print. */
function wetWeathernext(coord: Coord): WeatherNextForecast {
  const none = { mean: null, p10: null, p25: null, p50: null, p75: null, p90: null };
  const t0 = Date.parse('2026-10-02T00:00:00Z');
  return {
    model: 'weathernext_3',
    coord,
    initTime: '2026-10-02T00:00:00Z',
    bytesProcessed: 0,
    steps: Array.from({ length: 360 }, (_, h) => ({
      time: new Date(t0 + h * 3600_000).toISOString(),
      leadHours: h,
      temperature2mC: { mean: -14, p10: -16, p25: null, p50: 3, p75: null, p90: 6 },
      dewpoint2mC: none,
      precipitation1hrMm: { mean: 0.25, p10: 0.1, p25: null, p50: 0.25, p75: null, p90: 0.4 },
      windSpeed10mMs: none,
    })),
  };
}

/** The week in the README mock: a split at Revelstoke, real snow at Banff, a dip at Zermatt. */
const SCENARIO: Scenario = {
  revelstoke: {
    ecmwf_ifs025: (i) => ({ snowfallCm: i === 4 ? 2 : 0, precipitationMm: i === 4 ? 2 : 0 }),
    ecmwf_aifs025: (i) => ({ snowfallCm: i === 4 ? 3 : 0, precipitationMm: i === 4 ? 3 : 0 }),
    ncep_nam_conus: (i) => ({ snowfallCm: i === 4 ? 6 : 0, precipitationMm: i === 4 ? 5 : 0 }),
    gfs_seamless: (i) => ({ snowfallCm: i === 4 ? 14 : 0, precipitationMm: i === 4 ? 12 : 0 }),
  },
  banff: Object.fromEntries(
    (['ecmwf_ifs025', 'ecmwf_aifs025', 'ncep_nam_conus', 'gfs_seamless'] as const).map((m, k) => [
      m,
      (i: number) =>
        i === 5
          ? {
              snowfallCm: [8, 9, 10, 9][k]!,
              precipitationMm: 7,
              tempMinC: -6,
              tempMaxC: 1,
              freezingLevelM: 1200,
            }
          : { tempMinC: -4, tempMaxC: 8 },
    ]),
  ),
  zermatt: Object.fromEntries(
    (['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_eu', 'gfs_seamless'] as const).map((m) => [
      m,
      (i: number) => (i === 6 ? { precipitationMm: 9, freezingLevelM: 2300 } : {}),
    ]),
  ),
  whistler: Object.fromEntries(
    (['ecmwf_ifs025', 'ecmwf_aifs025', 'ncep_nam_conus', 'gfs_seamless'] as const).map((m) => [
      m,
      (i: number) => (i === 3 ? { precipitationMm: 8, freezingLevelM: 2500 } : {}),
    ]),
  ),
};

/** Answers every source from the scenario; `fail` names `source.name@spotId` (or `source.name@*`) that throw. */
function fakeFetch(
  scenario: Scenario,
  opts: { fail?: string[]; weathernext?: (coord: Coord) => WeatherNextForecast } = {},
): SnapshotFetch {
  return async <P, R>(source: Source<P, R>, params: P): Promise<Fetched<R>> => {
    const coord = (params as { coord: Coord }).coord;
    const spot = spots.find((s) => s.base.lat === coord.lat && s.base.lon === coord.lon)!;
    const fail = opts.fail ?? [];
    if (fail.includes(`${source.name}@${spot.id}`) || fail.includes(`${source.name}@*`)) {
      throw new Error(`${source.name} down`);
    }
    let value: unknown;
    if (source.name === 'weathernext:bigquery') {
      if (!opts.weathernext) throw new Error('no weathernext in this test');
      value = opts.weathernext(coord);
    } else {
      const model = source.name.replace('open-meteo:', '');
      const day = scenario[spot.id]?.[model] ?? (() => ({}));
      value = forecast(model, coord, spot.region, day);
    }
    return { value: value as R, cached: true, fetchedAt: FETCHED_AT };
  };
}

const ctx = () => ({ cfg, db, log: quiet, now: NOW });

async function snapshotFor(
  scenario: Scenario,
  opts: Parameters<typeof fakeFetch>[1] & { useWn?: boolean } = {},
) {
  const inputs = await gatherSnapshot(ctx(), {
    offline: true,
    weathernext: opts.useWn ?? false,
    fetch: fakeFetch(scenario, opts),
  });
  const snapshot = composeSnapshot(inputs);
  return { snapshot, text: renderSnapshot(snapshot) };
}

function block(text: string): string[] {
  const m = /```\n([\s\S]*?)\n```/.exec(text);
  return m ? m[1]!.split('\n') : [];
}

const rowFor = (text: string, label: string) =>
  block(text).find((l) => l.trimStart().startsWith(label)) ?? '';

/* ---------------------------------------------------------------- spots */

describe('snapshotSpots', () => {
  it('is Aspen then the whole board, every label short enough for the table', () => {
    expect(spots).toHaveLength(1 + cfg.board.length);
    expect(spots[0]).toMatchObject({ id: 'aspen', group: 'ASPEN', region: 'US' });
    expect(spots.slice(1).map((s) => s.id)).toEqual(cfg.board.map((d) => d.id));
    for (const s of spots) expect(s.label.length).toBeLessThanOrEqual(11);
  });
});

/* ---------------------------------------------------------------- render */

describe('the message', () => {
  it('fits Discord, and a phone', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(text.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
    for (const line of block(text)) expect([...line].length).toBeLessThanOrEqual(BLOCK_MAX_COLS);
  });

  it('puts Aspen first with its countdown, then the regions in board order', async () => {
    const { text } = await snapshotFor(SCENARIO);
    const lines = block(text);
    expect(lines[1]).toMatch(/^ASPEN · 114d\s+dry\s+2\/14\s+30 ●$/);
    const headers = lines.filter((l) => /^[A-Z]{3,} · /.test(l) && !l.startsWith('ASPEN'));
    expect(headers.map((h) => h.split(' · ')[0])).toEqual(['JAPAN', 'CANADA', 'USA', 'EUROPE']);
  });

  it('shows snow as the range across the models, and the split as a callout naming them', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(rowFor(text, 'Revelstoke')).toMatch(/2–14cm .* ○$/);
    expect(text).toContain('⚠️ **Revelstoke is a coin flip** — GFS 14cm, ECMWF 2cm.');
  });

  it('calls out the most snow the models agree on', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(rowFor(text, 'Banff/LL')).toMatch(/8–10cm\s+-6\/8\s+30 ●$/);
    expect(text).toContain('❄️ **Most snow: Banff/LL** — 8–10cm, models agree.');
  });

  it('calls out snow up high when the freezing level dips below a summit on a wet day', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(rowFor(text, 'Zermatt')).toMatch(/rain/);
    expect(text).toContain(
      '🏔️ **Snow up high at Zermatt** — freezing level down to 2,300m Wed (summit 3,900m).',
    );
  });

  it('says rain where it rains, and dry where nothing falls however warm', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(rowFor(text, 'Whistler')).toMatch(/^ Whistler\s+rain\s/);
    expect(rowFor(text, 'Niseko')).toMatch(/^ Niseko\s+dry\s/);
  });

  it('labels regions from the fixed vocabulary', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(block(text)).toContain('JAPAN · dry, mild');
    expect(block(text)).toContain('CANADA · snowing, mild');
  });

  it('ends with the legend, the sources that answered, and when', async () => {
    const { text } = await snapshotFor(SCENARIO);
    const foot = text.split('\n').at(-1)!;
    expect(foot).toMatch(/^-# ranges = low–high across models · ● agree ◐ partly ○ split · /);
    expect(foot).toContain('ECMWF, AIFS, ICON, ICON-EU, GFS, NAM');
    expect(foot).toContain('as of Fri 12:40 PM EDT');
    expect(foot).not.toContain('missing');
    expect(text.split('\n')[0]).toBe('❄️ **Snapshot** · next 7 days · 16 spots · 6 sources');
  });
});

/* ---------------------------------------------------------- weathernext */

describe('WeatherNext', () => {
  it('feeds temperature and confidence, and its derived snow never prints', async () => {
    const { snapshot, text } = await snapshotFor({}, { useWn: true, weathernext: wetWeathernext });
    const niseko = snapshot.spots.find((s) => s.spot.id === 'niseko')!;
    const derived = Math.round(niseko.snow!.derived!.totalCm);
    expect(derived).toBeGreaterThan(50);
    expect(text).not.toMatch(new RegExp(`\\b${derived}\\b`));
    expect(niseko.cell).toEqual({ kind: 'dry' }); // the snowfall models say dry; that's what prints
    expect(niseko.conditions!.tempLowC!.bySource.weathernext_3).toBe(3);
    expect(snapshot.sources).toContain('WeatherNext');
    expect(text.split('\n')[0]).toMatch(/· 7 sources$/);
    expect(() => assertSnapshotHonest(snapshot, text)).not.toThrow();
  });
});

/* ------------------------------------------------------------- failures */

describe('when sources fail', () => {
  it('says which, and for how many spots', async () => {
    const { text } = await snapshotFor(SCENARIO, {
      useWn: true,
      fail: ['weathernext:bigquery@*', 'open-meteo:gfs_seamless@banff'],
    });
    expect(text.split('\n').at(-1)).toContain('missing: WeatherNext, GFS at 1 spot');
    expect(rowFor(text, 'Banff/LL')).toMatch(/8–10cm/); // three models still answered
  });

  it('prints a dash row for a spot nothing answered for', async () => {
    const all = ['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_global', 'gfs_seamless'].map(
      (m) => `open-meteo:${m}@hakuba`,
    );
    const { text } = await snapshotFor(SCENARIO, { fail: all });
    expect(rowFor(text, 'Hakuba')).toMatch(/^ Hakuba\s+—\s+—\s+—$/);
    expect(text.split('\n')[0]).toContain('15 spots');
  });

  it('replies plainly when nothing at all answered', async () => {
    const fail = [
      'ecmwf_ifs025',
      'ecmwf_aifs025',
      'icon_global',
      'icon_eu',
      'gfs_seamless',
      'ncep_nam_conus',
    ].map((m) => `open-meteo:${m}@*`);
    const result = await runSnapshot(ctx(), {
      offline: true,
      weathernext: false,
      fetch: fakeFetch(SCENARIO, { fail }),
    });
    expect(result).toMatchObject({ ok: false, text: SNAPSHOT_UNAVAILABLE });
  });
});

/* ----------------------------------------------------------------- audit */

describe('assertSnapshotHonest', () => {
  it('passes a real snapshot', async () => {
    const { snapshot, text } = await snapshotFor(SCENARIO);
    expect(() => assertSnapshotHonest(snapshot, text)).not.toThrow();
  });

  it('refuses a snow cell that is not a modelled total', async () => {
    const { snapshot, text } = await snapshotFor(SCENARIO);
    const banff = snapshot.spots.find((s) => s.spot.id === 'banff')!;
    banff.cell = { kind: 'range', lowCm: 8, highCm: 11 };
    expect(() => assertSnapshotHonest(snapshot, text)).toThrow(/banff: snow cell prints 11cm/);
  });

  it('refuses any cm in the text that no model said', async () => {
    const { snapshot, text } = await snapshotFor(SCENARIO);
    expect(() => assertSnapshotHonest(snapshot, `${text}\n37cm`)).toThrow(/37cm/);
  });
});

/* ------------------------------------------------------------ worst case */

describe('a huge week everywhere', () => {
  it('still fits, dropping the unit from three-digit ranges', async () => {
    const deep = (i: number) => ({
      snowfallCm: i > 1 ? 15 : 0,
      precipitationMm: 12,
      tempMinC: -28,
      tempMaxC: -15,
      gustMaxKmh: 140,
      freezingLevelM: 0,
    });
    const huge: Scenario = Object.fromEntries(
      spots.map((s) => [
        s.id,
        {
          ...Object.fromEntries(
            ['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_global', 'icon_eu', 'ncep_nam_conus'].map(
              (m) => [m, deep],
            ),
          ),
          gfs_seamless: (i: number) => ({
            snowfallCm: i > 1 ? 40 : 0,
            precipitationMm: 30,
            tempMinC: -31,
            tempMaxC: -12,
            gustMaxKmh: 120,
            freezingLevelM: 0,
          }),
        },
      ]),
    );
    const { snapshot, text } = await snapshotFor(huge, {
      useWn: true,
      fail: ['weathernext:bigquery@*', 'open-meteo:ecmwf_aifs025@niseko'],
    });
    expect(text.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
    for (const line of block(text)) expect([...line].length).toBeLessThanOrEqual(BLOCK_MAX_COLS);
    expect(rowFor(text, 'Niseko')).toMatch(/^ Niseko\s+105–280\s+-28\/-15\s+140 ○$/);
    expect(() => assertSnapshotHonest(snapshot, text)).not.toThrow();
  });
});

/* ------------------------------------------------------------- callouts */

describe('pickCallouts', () => {
  it('falls back to a line that is true by construction', async () => {
    const { snapshot } = await snapshotFor({});
    expect(pickCallouts(snapshot.spots)).toEqual([
      '🧊 **Nothing standing out** — no big snow, no model splits, no lift-holding wind.',
    ]);
  });

  it('flags lift-holding wind', async () => {
    const windy: Scenario = {
      jackson: Object.fromEntries(
        ['ecmwf_ifs025', 'ecmwf_aifs025', 'ncep_nam_conus', 'gfs_seamless'].map((m) => [
          m,
          (i: number) => (i === 3 ? { gustMaxKmh: 85 } : {}),
        ]),
      ),
    };
    const { snapshot } = await snapshotFor(windy);
    expect(pickCallouts(snapshot.spots)).toEqual([
      '💨 **Jackson gusts to 85 km/h Sun** — lift-hold territory.',
    ]);
  });

  it('keeps at most three, most useful first', async () => {
    const busy: Scenario = {
      ...SCENARIO,
      jackson: { gfs_seamless: (i) => (i === 3 ? { gustMaxKmh: 99 } : {}) },
    };
    const { snapshot } = await snapshotFor(busy);
    const c = pickCallouts(snapshot.spots);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatch(/^⚠️ \*\*Revelstoke/);
    expect(c[1]).toMatch(/^❄️ \*\*Most snow/);
    expect(c[2]).toMatch(/^🏔️ \*\*Snow up high/);
  });
});

describe('cellText', () => {
  it.each([
    [{ kind: 'range', lowCm: 4, highCm: 4 }, '4cm'],
    [{ kind: 'range', lowCm: 0, highCm: 4 }, '0–4cm'],
    [{ kind: 'range', lowCm: 10, highCm: 25 }, '10–25cm'],
    [{ kind: 'range', lowCm: 90, highCm: 120 }, '90–120'],
    [{ kind: 'dry' }, 'dry'],
    [{ kind: 'none' }, '—'],
  ] as const)('%j → %s', (cell, want) => {
    expect(cellText(cell)).toBe(want);
  });
});

describe('Aspen countdown', () => {
  it('counts down, then says now, then goes quiet', async () => {
    const at = async (iso: string) => {
      const inputs = await gatherSnapshot(
        { cfg, db, log: quiet, now: new Date(iso) },
        { offline: true, weathernext: false, fetch: fakeFetch({}) },
      );
      return composeSnapshot(inputs).aspenLabel;
    };
    expect(await at('2026-10-02T17:00:00Z')).toBe('ASPEN · 114d');
    expect(await at('2027-01-25T17:00:00Z')).toBe('ASPEN · now');
    expect(await at('2027-02-02T17:00:00Z')).toBe('ASPEN');
  });
});

describe('pool', () => {
  it('never runs more than n at once', async () => {
    const limit = pool(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(3);
  });
});
