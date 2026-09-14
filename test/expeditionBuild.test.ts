import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExpedition, type Expedition, type ExpeditionInputs } from '../src/builder.js';
import { loadConfig, type Config, type Destination } from '../src/config.js';
import { kvGet, kvSet, openDb, type DB } from '../src/db.js';
import { Poster } from '../src/discord/client.js';
import { LlmClient } from '../src/llm/client.js';
import type { JobContext } from '../src/jobs/_runner.js';
import {
  KV_BUILD_REQUEST,
  pickWindow,
  runExpeditionBuild,
  type ExpeditionBuildDeps,
  type SnowSignal,
} from '../src/jobs/expeditionBuild.js';
import {
  DOSSIER_MAX_CHARS,
  fallbackRender,
  headerLine,
  renderDossierPrompt,
  trimForPrompt,
  unquotedNumbers,
} from '../src/llm/prompts/dossier.js';
import { log } from '../src/logger.js';
import type { FlightQuote, FlightSearch } from '../src/sources/flights.js';
import type { LodgingOption, LodgingSearch } from '../src/sources/lodging.js';
import type { GroundTransport, LookupResult, PassStatus } from '../src/sources/lookup.js';
import { buildSnowReport } from '../src/sources/weather/consensus.js';
import type { DailyWeather, ModelForecast } from '../src/sources/weather/types.js';

const NOW = new Date('2026-09-14T12:00:00Z');

let cfg: Config;
beforeEach(() => {
  cfg = loadConfig({
    env: { DISCORD_TEST_CHANNEL_ID: 'test-channel', DISCORD_CHANNEL_ID: 'real-channel' },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const by = (id: string): Destination => cfg.board.find((d) => d.id === id)!;

/* ---------------------------------------------------------------- fixtures */
/* Trimmed copies of the Niseko fixture in builder.test.ts. */

function quote(priceUsd: number, departAt: string, arriveAt: string): FlightQuote {
  return {
    priceUsd,
    airlines: ['ANA'],
    stops: 1,
    durationMin: 900,
    departAt,
    arriveAt,
    legs: [],
    source: 'serpapi',
  };
}

function search(
  origin: string,
  dest: Destination,
  window: { start: string; end: string },
  priceUsd: number,
  arriveAt: string,
): FlightSearch {
  const q = quote(priceUsd, `${window.start} 12:00`, arriveAt);
  return {
    origin,
    dest: dest.airport,
    depart: window.start,
    return: window.end,
    quotes: [q],
    cheapest: q,
    best: q,
    searchedAt: '2026-09-14T10:00:00Z',
  };
}

function model(name: string, start: string, snow: number[], dest: Destination): ModelForecast {
  const days: DailyWeather[] = snow.map((cm, i) => ({
    date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    snowfallCm: cm,
    precipitationMm: cm / 10,
    tempMaxC: -4,
    tempMinC: -12,
    tempMeanC: -8,
    windMaxKmh: 25,
    gustMaxKmh: 45,
    freezingLevelM: 200,
    snowDepthM: 2,
  }));
  return {
    model: name,
    coord: { lat: dest.lat, lon: dest.lon },
    modelElevationM: 300,
    days,
    missingVariables: [],
  };
}

const chalet: LodgingOption = {
  name: 'Hirafu Pine Chalet',
  type: 'vacation_rental',
  totalUsd: 5670,
  perNightUsd: 630,
  perPersonPerNightUsd: 126,
  rating: 4.7,
  reviews: 38,
  sleeps: 6,
  link: 'https://example.test/chalet',
  source: 'serpapi',
};

const groundLookup: LookupResult<GroundTransport> = {
  data: {
    options: [
      {
        mode: 'bus',
        operator: 'Hokkaido Resort Liner',
        durationMin: 150,
        priceUsdPp: 27,
        notes: 'pre-book',
      },
    ],
  },
  sources: ['https://example.test/resort-liner'],
  askedAt: '2026-09-14T10:00:00Z',
  model: 'claude-sonnet-4-6',
};

const passLookup: LookupResult<PassStatus> = {
  data: {
    covered: true,
    daysIncluded: 5,
    blackoutDates: ['2026-12-26', '2027-02-11'],
    notes: 'IKON Base: 5 days at Niseko United, no reservations',
  },
  sources: ['https://example.test/ikon-niseko'],
  askedAt: '2026-09-14T10:00:00Z',
  model: 'claude-sonnet-4-6',
};

const NISEKO_WINDOW = { start: '2027-02-06', end: '2027-02-15' };
const NISEKO_SNOW = [12, 18, 35, 22, 8, 4, 15, 28, 10, 6];

/** A complete Niseko plan. `fare` scales every flight so a test can push it over the ceiling. */
function nisekoInputs(over: Partial<ExpeditionInputs> = {}, fare = 0): ExpeditionInputs {
  const dest = over.dest ?? by('niseko');
  const w = NISEKO_WINDOW;
  const s = (o: string, p: number, arr = '2027-02-07 21:05') => search(o, dest, w, p + fare, arr);
  return {
    dest,
    window: w,
    flights: {
      byOrigin: {
        JFK: s('JFK', 698, '2027-02-07 20:30'),
        EWR: s('EWR', 712, '2027-02-07 20:30'),
        BUR: s('BUR', 684),
        SNA: s('SNA', 698),
        LAX: s('LAX', 511),
        SFO: s('SFO', 540, '2027-02-07 22:00'),
      },
      attempts: [
        { depart: '2027-02-06', return: '2027-02-15', offsetDays: 0, priceUsd: 698 + fare },
        { depart: '2027-02-05', return: '2027-02-14', offsetDays: -1, priceUsd: 760 + fare },
        { depart: '2027-02-04', return: '2027-02-13', offsetDays: -2, priceUsd: 905 + fare },
      ],
      anchorOrigin: 'JFK',
    },
    lodging: {
      query: 'x ski',
      checkIn: w.start,
      checkOut: w.end,
      options: [chalet],
      pick: chalet,
      searchedAt: '2026-09-14T10:00:00Z',
    } satisfies LodgingSearch,
    ground: groundLookup,
    passes: passLookup,
    weather: buildSnowReport({
      window: w,
      base: [
        model('ecmwf_ifs025', w.start, NISEKO_SNOW, dest),
        model(
          'ecmwf_aifs025',
          w.start,
          NISEKO_SNOW.map((c) => c * 0.9),
          dest,
        ),
        model(
          'gfs_seamless',
          w.start,
          NISEKO_SNOW.map((c) => c * 1.1),
          dest,
        ),
      ],
      baseElevationM: dest.base_elevation_m,
      summitElevationM: dest.summit_elevation_m,
    }),
    ...over,
  };
}

/* -------------------------------------------------------------- pickWindow */

describe('pickWindow', () => {
  const aspen = { start: '2027-01-24', end: '2027-01-30' };

  it('starts on the first Friday or Saturday of the season at least 21 days out and runs ideal_days', () => {
    // Sep 14 + 21 = Mon Oct 5, but nothing is open until Dec 1 (a Tuesday); the next Fri is Dec 4.
    expect(pickWindow(by('niseko'), NOW)).toEqual({ start: '2026-12-04', end: '2026-12-13' });
    expect(pickWindow(by('revelstoke'), NOW)).toEqual({ start: '2026-12-04', end: '2026-12-10' });
  });

  it('respects the lead time once the season is already open', () => {
    // Jan 2 + 21 = Jan 23 (Sat) — take it.
    expect(pickWindow(by('jackson'), new Date('2027-01-02T00:00:00Z')).start).toBe('2027-01-23');
  });

  it('rolls past the end of the season into the next one', () => {
    // Mid-April: the 21-day lead lands after Apr 15, so the next window is Dec 3, 2027 (a Fri).
    expect(pickWindow(by('jackson'), new Date('2027-04-10T00:00:00Z')).start).toBe('2027-12-03');
  });

  it('honours a month hint', () => {
    expect(pickWindow(by('niseko'), NOW, '2027-02', aspen)).toEqual({
      start: '2027-02-05',
      end: '2027-02-14',
    });
  });

  it('skips a window that touches the Aspen trip ±3 days', () => {
    // From Dec 20, whistler's 7 days: Fri Jan 15–21 ends on the buffer's first day,
    // every start through Sat Jan 30 sits inside it; Fri Feb 5 is the first clear one.
    expect(pickWindow(by('whistler'), new Date('2026-12-20T00:00:00Z'), undefined, aspen)).toEqual({
      start: '2027-02-05',
      end: '2027-02-11',
    });
    // A hinted month with nothing clear inside it falls through to the first clear window after.
    expect(pickWindow(by('niseko'), new Date('2026-12-25T00:00:00Z'), '2027-01', aspen)).toEqual({
      start: '2027-02-05',
      end: '2027-02-14',
    });
    // Without the Aspen window there is nothing to avoid.
    expect(pickWindow(by('whistler'), new Date('2026-12-20T00:00:00Z')).start).toBe('2027-01-15');
  });

  it('falls through to the first in-season window after a hinted month that is already too close', () => {
    const w = pickWindow(by('jackson'), NOW, '2026-09');
    expect(w.start).toBe('2026-12-04');
  });

  it('takes a hinted month at face value even outside the season', () => {
    expect(pickWindow(by('jackson'), NOW, '2026-11').start).toBe('2026-11-06');
  });
});

/* ------------------------------------------------------------- the dossier */

describe('dossier prompt + fallback', () => {
  it('trims the raw quotes out of what the model sees', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const prompt = renderDossierPrompt(e);
    expect(prompt).not.toMatch(/"legs"/);
    expect(prompt).not.toMatch(/"quotes"/);
    expect(prompt).toContain('"headerLine"');
    expect(prompt).toContain('Elliot: BUR $684 / LAX $511');
    expect(trimForPrompt(e).watchCommand).toBe('/watch niseko-0206');
  });

  it('fallbackRender carries every PLAN §1B section, the delta lines and the watch command', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const text = fallbackRender(e);
    expect(text.length).toBeLessThanOrEqual(DOSSIER_MAX_CHARS);
    expect(text.startsWith(`**${headerLine(e)}**`)).toBe(true);
    expect(headerLine(e)).toMatch(
      /^🇯🇵 NISEKO UNITED — Feb 6–15 — \$[\d,]+\/person — 10 days \(6 on snow\)$/,
    );
    for (const label of [
      'Getting there',
      'Where you sleep',
      'Ground',
      'Passes',
      'Time off',
      'The plan',
      'The catch',
    ]) {
      expect(text).toContain(`**${label}**`);
    }
    for (const line of e.routing.deltaLines) expect(text).toContain(line);
    expect(text).toContain('IKON covers 5 days');
    expect(text).toContain('2027-02-11');
    expect(text).toContain('**Decide by 2026-09-28.**');
    expect(text).toContain('`/watch niseko-0206`');
    expect(text).toMatch(/_As of 2026-09-14 12:00 UTC · sources: .*serpapi:flights/);
    // Its own numbers all trace back to the object.
    expect(unquotedNumbers(text, e)).toEqual([]);
  });

  it('fallbackRender says unverified for passes and ground when the lookups are missing', () => {
    const e = buildExpedition(nisekoInputs({ passes: null, ground: null }), cfg, NOW);
    const text = fallbackRender(e);
    expect(text).toMatch(/\*\*Passes\*\* — IKON coverage is unverified/);
    expect(text).toMatch(/\*\*Ground\*\* — Bus CTS -> Hirafu — unverified/);
    expect(text).not.toMatch(/blackout/i);
  });

  it('unquotedNumbers catches an invented $999 and lets real numbers through', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const real = `${headerLine(e)}\nElliot: BUR $684 / LAX $511 — worth the drive. ECMWF ${Math.round(
      e.weather.report.models[0]!.totalCm,
    )}cm. Bus $27 each way, $54 round trip.`;
    expect(unquotedNumbers(real, e)).toEqual([]);
    expect(unquotedNumbers(`${real} ZIPAIR $999 r/t and 140cm on the way.`, e)).toEqual([
      '$999',
      '140cm',
    ]);
    // Thousands separators are the model's choice, not a different number.
    expect(unquotedNumbers(`$${e.cost.perPersonUsd.toLocaleString('en-US')}/person`, e)).toEqual(
      [],
    );
  });
});

/* ---------------------------------------------------------------- the job */

describe('runExpeditionBuild', () => {
  let db: DB;
  let gathered: string[];
  let snowCalls: string[];
  let completions: number;
  let snowFor: (dest: Destination) => SnowSignal;
  let inputsFor: (dest: Destination) => ExpeditionInputs;

  beforeEach(() => {
    db = openDb(':memory:');
    gathered = [];
    snowCalls = [];
    completions = 0;
    // Rusutsu has the bigger forecast and ranks first; its build is over the ceiling.
    snowFor = (dest) =>
      dest.id === 'rusutsu'
        ? { forecast10dCm: 95, confidence: 'high', observed7dCm: 40 }
        : dest.id === 'niseko'
          ? { forecast10dCm: 80, confidence: 'high', observed7dCm: 30 }
          : { forecast10dCm: 5, confidence: 'low', observed7dCm: 0 };
    inputsFor = (dest) =>
      dest.id === 'rusutsu' ? nisekoInputs({ dest }, 1800) : nisekoInputs({ dest });
  });

  const deps = (): ExpeditionBuildDeps => ({
    async gather(_ctx, dest) {
      gathered.push(dest.id);
      return inputsFor(dest);
    },
    async fetchSnow(dest) {
      snowCalls.push(dest.id);
      return snowFor(dest);
    },
    async complete() {
      completions += 1;
      throw new Error('no model in tests');
    },
  });

  function ctx(over: Partial<JobContext> = {}): JobContext {
    return {
      cfg,
      db,
      poster: new Poster(cfg, db, { dryRun: true, target: 'test', job: 'expeditionBuild' }),
      llm: new LlmClient(cfg, db, 'expeditionBuild'),
      dryRun: true,
      target: 'test',
      now: NOW,
      log: log.child({ test: true }),
      ...over,
    };
  }

  const posts = () =>
    db.prepare(`SELECT kind, summary FROM posts ORDER BY id`).all() as {
      kind: string;
      summary: string;
    }[];
  const expeditions = () =>
    db
      .prepare(`SELECT id, destination, status, root_message_id, thread_id FROM expeditions`)
      .all() as {
      id: string;
      destination: string;
      status: string;
      root_message_id: string | null;
      thread_id: string | null;
    }[];
  const nearMisses = () =>
    db
      .prepare(
        `SELECT destination, window_start, total_pp_usd, reason FROM near_misses ORDER BY id`,
      )
      .all() as {
      destination: string;
      window_start: string;
      total_pp_usd: number;
      reason: string;
    }[];

  it('dry run: ranks, near-misses the over-ceiling leader, builds the runner-up, posts one root', async () => {
    const out = await runExpeditionBuild(ctx(), deps());
    expect(snowCalls).toHaveLength(cfg.board.length);
    expect(gathered).toEqual(['rusutsu', 'niseko']);

    expect(out?.expedition.id).toBe('niseko-0206');
    expect(out?.forced).toBe(false);
    expect(out?.posted).toBe(true);
    expect(expeditions()).toEqual([
      {
        id: 'niseko-0206',
        destination: 'niseko',
        status: 'proposed',
        root_message_id: null,
        thread_id: null,
      },
    ]);

    const misses = nearMisses();
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ destination: 'rusutsu', window_start: '2027-02-06' });
    expect(misses[0]!.total_pp_usd).toBeGreaterThan(cfg.expedition.ceiling_usd.international);
    expect(misses[0]!.reason).toMatch(/over the \$2600 ceiling/);

    const p = posts();
    expect(p.map((x) => x.kind)).toEqual(['root']);
    expect(p[0]!.summary).toMatch(/^\*\*🇯🇵 NISEKO UNITED — Feb 6–15/);
    expect(out?.dossier).toBe(fallbackRender(out!.expedition));
    expect(completions).toBe(0); // dry run without a key never calls the model
  });

  it('writes near_misses for candidates the pre-rank threw out on the ceiling', async () => {
    // Every JP/EU/CA prior estimate is over; the US ones stay well under (the
    // built plan reuses the Niseko fixture's fares, so its ceiling is lifted too).
    cfg.expedition.ceiling_usd = { international: 1200, domestic: 2600 };
    inputsFor = (dest) => nisekoInputs({ dest });
    const out = await runExpeditionBuild(ctx(), deps());
    expect(['jackson', 'big-sky', 'alta-snowbird', 'palisades']).toContain(
      out?.expedition.destination.id,
    );
    const misses = nearMisses();
    expect(misses.map((m) => m.destination)).toEqual(
      expect.arrayContaining(['niseko', 'rusutsu', 'chamonix', 'whistler']),
    );
    expect(misses.every((m) => /pre-rank estimate/.test(m.reason))).toBe(true);
  });

  it('honours the cooldown: a destination built two weeks ago is not rebuilt', async () => {
    db.prepare(
      `INSERT INTO expeditions (id, destination, window_start, window_end, days_total, days_on_snow,
         plan_json, total_pp_usd, confidence, status, created_at)
       VALUES ('niseko-0130', 'niseko', '2027-01-30', '2027-02-08', 10, 7, '{}', 2000, 'high', 'retired', ?)`,
    ).run(new Date(NOW.getTime() - 14 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19));
    inputsFor = (dest) => nisekoInputs({ dest });
    const out = await runExpeditionBuild(ctx(), deps());
    expect(out?.expedition.destination.id).toBe('rusutsu');
    expect(gathered).toEqual(['rusutsu']);
  });

  it('forced build via kv skips the ranking, ignores the ceiling and clears the request', async () => {
    kvSet(db, KV_BUILD_REQUEST, JSON.stringify({ kind: 'build', destination: 'rusutsu' }));
    const out = await runExpeditionBuild(ctx(), deps());
    expect(snowCalls).toEqual([]);
    expect(gathered).toEqual(['rusutsu']);
    expect(out?.forced).toBe(true);
    expect(out?.expedition.cost.overCeiling).toBe(true);
    expect(expeditions()[0]).toMatchObject({ id: 'rusutsu-0206', status: 'proposed' });
    expect(nearMisses()).toEqual([]);
    expect(kvGet(db, KV_BUILD_REQUEST)).toBeUndefined();
    expect(posts().map((p) => p.kind)).toEqual(['root']);
  });

  it('forced build passes the month hint into the window it asks gather for', async () => {
    kvSet(
      db,
      KV_BUILD_REQUEST,
      JSON.stringify({ kind: 'build', destination: 'niseko', month: '2027-03' }),
    );
    let asked: { start: string; end: string } | null = null;
    const d = deps();
    d.gather = async (_c, dest, window) => {
      asked = window;
      return nisekoInputs({ dest });
    };
    await runExpeditionBuild(ctx(), d);
    expect(asked).toEqual({ start: '2027-03-05', end: '2027-03-14' });
  });

  it('rejects a forced destination that is not on the board', async () => {
    kvSet(db, KV_BUILD_REQUEST, JSON.stringify({ kind: 'build', destination: 'mars' }));
    await expect(runExpeditionBuild(ctx(), deps())).rejects.toThrow(/not on the board/);
    expect(kvGet(db, KV_BUILD_REQUEST)).toBeUndefined();
  });

  it('quiet mode: the row is inserted, nothing is posted', async () => {
    kvSet(db, 'quiet_until', new Date(NOW.getTime() + 86_400_000).toISOString());
    const out = await runExpeditionBuild(ctx(), deps());
    expect(out?.posted).toBe(false);
    expect(expeditions()).toHaveLength(1);
    expect(posts()).toEqual([]);
  });

  it('gives up after three over-ceiling candidates and says so', async () => {
    inputsFor = (dest) => nisekoInputs({ dest }, 1800);
    await expect(runExpeditionBuild(ctx(), deps())).rejects.toThrow(/none of the top 3 candidates/);
    expect(gathered).toHaveLength(3);
    expect(nearMisses()).toHaveLength(3);
    expect(expeditions()).toEqual([]);
  });

  it('uses the model when it behaves and falls back when it invents a number', async () => {
    const d = deps();
    const good = 'A dossier with $511 and nothing invented.';
    d.complete = async () => good;
    const withKey = { ...process.env, ANTHROPIC_API_KEY: 'test-key' };
    vi.stubEnv('ANTHROPIC_API_KEY', withKey.ANTHROPIC_API_KEY!);
    try {
      const out = await runExpeditionBuild(ctx(), d);
      expect(out?.dossier).toBe(good);

      const db2 = openDb(':memory:');
      d.complete = async () => 'ZIPAIR LAX→NRT $999 r/t.';
      const out2 = await runExpeditionBuild(
        ctx({
          db: db2,
          poster: new Poster(cfg, db2, { dryRun: true, target: 'test', job: 'expeditionBuild' }),
        }),
        d,
      );
      expect(out2?.dossier).toBe(fallbackRender(out2!.expedition));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/* One sanity check that the fixture is what the tests above assume. */
describe('fixture', () => {
  it('scales over the ceiling with the fare bump', () => {
    const e: Expedition = buildExpedition(nisekoInputs({ dest: by('rusutsu') }, 1800), cfg, NOW);
    expect(e.cost.overCeiling).toBe(true);
    expect(buildExpedition(nisekoInputs(), cfg, NOW).cost.overCeiling).toBe(false);
  });
});
