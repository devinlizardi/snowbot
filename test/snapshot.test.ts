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
import { crosscheckFor } from '../src/sources/weather/crosscheck.js';
import { checkRead, READ_MAX_CHARS, readFacts } from '../src/llm/prompts/snapshot.js';
import { assertSpotHonest, runSpotSnapshot, spotChoices } from '../src/snapshotSpot.js';
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

/** The week in the README mock: a split at Snowbird, real snow at Banff, a dip at Zermatt. */
const SCENARIO: Scenario = {
  snowbird: {
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
  'big-bear': Object.fromEntries(
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
    if (source.name === 'open-meteo:archive') {
      value = {
        coord,
        days: [{ date: '2026-09-30', snowfallCm: 3.4 }],
        trailing7dCm: 3.4,
      };
    } else if (source.name === 'weathernext:bigquery') {
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

  it('groups by display group but keeps model selection on geography', () => {
    const niseko = spots.find((s) => s.id === 'niseko')!;
    const chamonix = spots.find((s) => s.id === 'chamonix')!;
    expect(niseko.group).toBe(chamonix.group);
    expect(crosscheckFor(niseko.region).map((x) => x.name)).toEqual([
      'open-meteo:icon_global',
      'open-meteo:gfs_seamless',
    ]);
    expect(crosscheckFor(chamonix.region).map((x) => x.name)).toEqual([
      'open-meteo:icon_eu',
      'open-meteo:gfs_seamless',
    ]);
  });
});

/* ---------------------------------------------------------------- render */

describe('the message', () => {
  it('fits Discord, and a phone', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(text.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
    for (const line of block(text)) expect([...line].length).toBeLessThanOrEqual(BLOCK_MAX_COLS);
  });

  it('puts Aspen first with its countdown, then the display groups in order', async () => {
    const { text } = await snapshotFor(SCENARIO);
    const lines = block(text);
    expect(lines[1]).toMatch(/^ASPEN · 114d\s+dry\s+2\/14\s+30 ●$/);
    const headers = lines.filter((l) => /^[A-Z]{3,} · /.test(l) && !l.startsWith('ASPEN'));
    expect(headers.map((h) => h.split(' · ')[0])).toEqual(['WEST', 'EAST', 'ROCKIES', 'ABROAD']);
  });

  it('shows snow as the range across the models, and the split as a callout naming them', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(rowFor(text, 'Snowbird')).toMatch(/2–14cm .* ○$/);
    expect(text).toContain('⚠️ **Snowbird is a coin flip** — GFS 14cm, ECMWF 2cm.');
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
    expect(rowFor(text, 'Big Bear')).toMatch(/^ Big Bear\s+rain\s/);
    expect(rowFor(text, 'Niseko')).toMatch(/^ Niseko\s+dry\s/);
  });

  it('labels display groups from the fixed vocabulary', async () => {
    const { text } = await snapshotFor(SCENARIO);
    expect(block(text)).toContain('EAST · dry, mild');
    expect(block(text)).toContain('ROCKIES · snow in spots, mild');
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
      (m) => `open-meteo:${m}@niseko`,
    );
    const { text } = await snapshotFor(SCENARIO, { fail: all });
    expect(rowFor(text, 'Niseko')).toMatch(/^ Niseko\s+—\s+—\s+—$/);
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
      'big-sky': Object.fromEntries(
        ['ecmwf_ifs025', 'ecmwf_aifs025', 'ncep_nam_conus', 'gfs_seamless'].map((m) => [
          m,
          (i: number) => (i === 3 ? { gustMaxKmh: 85 } : {}),
        ]),
      ),
    };
    const { snapshot } = await snapshotFor(windy);
    expect(pickCallouts(snapshot.spots)).toEqual([
      '💨 **Big Sky gusts to 85 km/h Sun** — lift-hold territory.',
    ]);
  });

  it('keeps at most three, most useful first', async () => {
    const busy: Scenario = {
      ...SCENARIO,
      'big-sky': { gfs_seamless: (i) => (i === 3 ? { gustMaxKmh: 99 } : {}) },
    };
    const { snapshot } = await snapshotFor(busy);
    const c = pickCallouts(snapshot.spots);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatch(/^⚠️ \*\*Snowbird/);
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

/* ------------------------------------------------------ P5: the read */

describe('the read', () => {
  const llm = (reply: string) => ({
    calls: [] as string[],
    async complete(prompt: string) {
      this.calls.push(prompt);
      return reply;
    },
  });

  it('goes above the table and replaces the callouts when every number checks out', async () => {
    const read =
      'Banff is the one getting real snow this week, 8–10cm with the models in step. ' +
      'Snowbird is a coin flip between GFS at 14cm and ECMWF at 2cm.';
    const w = llm(read);
    const result = await runSnapshot(ctx(), {
      offline: true,
      weathernext: false,
      fetch: fakeFetch(SCENARIO),
      llm: w,
    });
    const lines = result.text.split('\n');
    expect(lines[1]).toBe(read);
    expect(lines[2]).toBe('```');
    expect(result.text).not.toContain('⚠️ **Snowbird is a coin flip**');
    expect(w.calls[0]).toContain('"Banff/LL"');
    expect(() => assertSnapshotHonest(result.snapshot!, result.text)).not.toThrow();
  });

  it('is rejected for an invented number, and the callouts come back', async () => {
    const result = await runSnapshot(ctx(), {
      offline: true,
      weathernext: false,
      fetch: fakeFetch(SCENARIO),
      llm: llm('Banff is getting 25cm this week.'),
    });
    expect(result.text).not.toContain('25cm');
    expect(result.text).toContain('⚠️ **Snowbird is a coin flip**');
  });

  it('never lets the derived WeatherNext total through, even in the read', async () => {
    const inputs = await gatherSnapshot(ctx(), {
      offline: true,
      weathernext: true,
      fetch: fakeFetch({}, { weathernext: wetWeathernext }),
    });
    const snapshot = composeSnapshot(inputs);
    const derived = Math.round(
      snapshot.spots.find((s) => s.spot.id === 'niseko')!.snow!.derived!.totalCm,
    );
    const facts = readFacts(snapshot);
    expect(JSON.stringify(facts)).not.toMatch(new RegExp(`\\b${derived}\\b`));
    expect(checkRead(`Niseko could see ${derived}cm.`, facts).ok).toBe(false);
  });

  it('falls back when the model call throws', async () => {
    const result = await runSnapshot(ctx(), {
      offline: true,
      weathernext: false,
      fetch: fakeFetch(SCENARIO),
      llm: {
        complete: () => Promise.reject(new Error('cap reached')),
      },
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('❄️ **Most snow: Banff/LL**');
  });

  it('refuses markup, too many sentences, and anything too long', () => {
    const facts = readFacts(composeSnapshot({ now: NOW, timezone: 'UTC', aspenWindow: { start: '2027-01-24', end: '2027-01-30' }, spots: [] }));
    expect(checkRead('**Big** week.', facts).ok).toBe(false);
    expect(checkRead('A. B. C. D. E.', facts).ok).toBe(false);
    expect(checkRead('x'.repeat(500), facts).ok).toBe(false);
    expect(checkRead('Quiet week everywhere.', facts)).toEqual({ ok: true, read: 'Quiet week everywhere.' });
  });

  it('still fits a worst-case week with a full-length read', async () => {
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
        Object.fromEntries(
          ['ecmwf_ifs025', 'ecmwf_aifs025', 'icon_global', 'icon_eu', 'ncep_nam_conus', 'gfs_seamless'].map(
            (m) => [m, deep],
          ),
        ),
      ]),
    );
    const { snapshot } = await snapshotFor(huge);
    const read = ('Snowing everywhere. ').repeat(21).trim();
    expect(read.length).toBeLessThanOrEqual(READ_MAX_CHARS);
    const text = renderSnapshot(snapshot, { read });
    expect(text.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
    for (const line of block(text)) expect([...line].length).toBeLessThanOrEqual(BLOCK_MAX_COLS);
    expect(text).toContain('🔭');
  });
});

/* --------------------------------------------------- P5: look-ahead */

describe('days 8–15', () => {
  it('names storms at least two models show, labelled low confidence', async () => {
    const late = (cm: number) => (i: number) => (i >= 9 && i <= 10 ? { snowfallCm: cm, precipitationMm: cm } : {});
    const scenario: Scenario = {
      niseko: { ecmwf_ifs025: late(20), ecmwf_aifs025: late(12), gfs_seamless: late(4) },
      chamonix: { ecmwf_ifs025: late(20) }, // one model alone: not a signal
    };
    const { snapshot, text } = await snapshotFor(scenario);
    expect(snapshot.lookAhead.map((x) => x.spot.id)).toEqual(['niseko']);
    expect(text).toContain('🔭 **Days 8–15, low confidence:** Niseko 0–40cm — models starting to line up.');
    expect(() => assertSnapshotHonest(snapshot, text)).not.toThrow();
  });

  it('says so when nothing is lining up', async () => {
    const { text } = await snapshotFor({});
    expect(text).toContain('🔭 **Days 8–15:** nothing the models agree on yet.');
  });
});

/* ------------------------------------------------------ P5: region: */

describe('region filter', () => {
  it('keeps Aspen first and only that group', async () => {
    const result = await runSnapshot(ctx(), {
      offline: true,
      weathernext: false,
      fetch: fakeFetch(SCENARIO),
      group: 'EAST',
    });
    const lines = block(result.text);
    expect(lines[1]).toMatch(/^ASPEN/);
    expect(lines.filter((l) => / · /.test(l)).map((l) => l.split(' · ')[0])).toEqual(['ASPEN', 'EAST']);
    expect(result.text.split('\n')[0]).toContain('4 spots');
  });
});

/* ------------------------------------------------------- P5: spot: */

describe('spot drill-down', () => {
  it('renders for every spot on the board, from fixtures, inside the limits', async () => {
    for (const s of spots) {
      const r = await runSpotSnapshot(ctx(), s.id, { offline: true, weathernext: false, fetch: fakeFetch(SCENARIO) });
      expect(r.ok, s.id).toBe(true);
      expect(r.text.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
      const rows = block(r.text);
      expect(rows).toHaveLength(8); // header + 7 days
      for (const line of rows) expect([...line].length, `${s.id}: ${line}`).toBeLessThanOrEqual(BLOCK_MAX_COLS);
      expect(r.text).toContain('**Fell last 7 days:** 3cm');
    }
  });

  it('shows per-model totals, the freezing level against the summit, and the split', async () => {
    const r = await runSpotSnapshot(ctx(), 'snowbird', { offline: true, weathernext: false, fetch: fakeFetch(SCENARIO) });
    expect(r.text.split('\n')[0]).toBe('❄️ **Snowbird** · next 7 days · ○ models split');
    expect(r.text).toContain('**7-day totals:** GFS 14cm · NAM 6cm · AIFS 3cm · ECMWF 2cm');
    expect(r.text).toMatch(/\*\*Freezing level:\*\* lowest 3,900m \w{3}, above the 3,400m summit all week\./);
    expect(rowFor(r.text, 'Mon 05')).toMatch(/^Mon 05\s+2–14cm/);
    expect(r.text).toContain('**WeatherNext:** not in this report.');
  });

  it('adds the pass line only when the lookup has answered', async () => {
    const base = { offline: true, weathernext: false, fetch: fakeFetch(SCENARIO) };
    const none = await runSpotSnapshot(ctx(), 'killington', base);
    expect(none.text).not.toContain('🎟️');
    const withPass = await runSpotSnapshot(ctx(), 'killington', {
      ...base,
      passAccess: { onPass: true, daysLimit: 5, blackouts: [], notes: 'Shared with Pico' },
    });
    expect(withPass.text).toContain('🎟️ Ikon Base Pass: 5 days (Shared with Pico), no blackouts in these dates.');
  });

  it("never prints WeatherNext's derived total", async () => {
    const r = await runSpotSnapshot(ctx(), 'niseko', {
      offline: true,
      weathernext: true,
      fetch: fakeFetch({}, { weathernext: wetWeathernext }),
    });
    const derived = Math.round(r.detail!.row.snow!.derived!.totalCm);
    expect(derived).toBeGreaterThan(50);
    expect(r.text).not.toMatch(new RegExp(`\\b${derived}\\b`));
    expect(r.text).toMatch(/\*\*WeatherNext:\*\* /);
    expect(() => assertSpotHonest(r.detail!, `${r.text}\n${derived}cm`)).toThrow(/which no model/);
  });

  it('says plainly when the spot is unknown', async () => {
    const r = await runSpotSnapshot(ctx(), 'revelstoke', { offline: true, fetch: fakeFetch(SCENARIO) });
    expect(r).toMatchObject({ ok: false, detail: null });
  });

  it('autocompletes from Aspen and the board', () => {
    expect(spotChoices(cfg, '')).toHaveLength(16);
    expect(spotChoices(cfg, 'mamm')).toEqual([{ name: 'Mammoth Mountain', value: 'mammoth' }]);
    expect(spotChoices(cfg, 'asp')[0]).toEqual({ name: 'Aspen (Snowmass)', value: 'aspen' });
  });
});
