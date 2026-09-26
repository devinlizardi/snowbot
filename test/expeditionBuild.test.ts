import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExpedition, type Expedition, type ExpeditionInputs } from '../src/builder.js';
import { loadConfig, type Config, type Destination } from '../src/config.js';
import { kvGet, kvSet, openDb, type DB } from '../src/db.js';
import { Poster } from '../src/discord/client.js';
import { LlmClient } from '../src/llm/client.js';
import type { JobContext } from '../src/jobs/_runner.js';
import {
  KV_BUILD_REQUEST,
  kvDetailsKey,
  pickWindow,
  runExpeditionBuild,
  type ExpeditionBuildDeps,
  type SnowSignal,
} from '../src/jobs/expeditionBuild.js';
import {
  composeCopy,
  DOSSIER_MAX_CHARS,
  fallbackCopy,
  fallbackRender,
  headerLine,
  renderDossier,
  renderDossierPrompt,
  snowStory,
  trimForPrompt,
  unquotedNumbers,
  type DossierCopy,
} from '../src/llm/prompts/dossier.js';
import { log } from '../src/logger.js';
import type { FlightQuote, FlightSearch } from '../src/sources/flights.js';
import type { LodgingOption, LodgingSearch } from '../src/sources/lodging.js';
import type {
  GroundTransport,
  LookupResult,
  PassStatus,
  ResortSnow,
} from '../src/sources/lookup.js';
import {
  seasonDates,
  summarizeClimatology,
  type Climatology,
} from '../src/sources/weather/climatology.js';
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

function stay(
  name: string,
  totalUsd: number,
  rating: number,
  over: Partial<LodgingOption> = {},
): LodgingOption {
  return {
    name,
    type: 'vacation_rental',
    totalUsd,
    unitTotalUsd: totalUsd,
    units: 1,
    perNightUsd: totalUsd / 9,
    perPersonPerNightUsd: Math.round((totalUsd / 9 / 5) * 100) / 100,
    rating,
    reviews: 38,
    sleeps: 6,
    bedrooms: 3,
    highlights: [],
    link: null,
    url: `https://example.test/${name.toLowerCase().replace(/\W+/g, '-')}`,
    source: 'serpapi',
    ...over,
  };
}

const chalet = stay('Hirafu Pine Chalet', 5670, 4.7, {
  perNightUsd: 630,
  perPersonPerNightUsd: 126,
  highlights: ['hot tub', 'kitchen'],
  link: 'https://example.test/chalet',
  url: 'https://example.test/chalet',
});
const lodge = stay('Hirafu Budget Lodge', 4860, 3.9, {
  type: 'hotel',
  units: 3,
  unitTotalUsd: 1620,
  sleeps: null,
  bedrooms: null,
});
const skye = stay('Skye Niseko', 9900, 4.9, { type: 'hotel', highlights: ['onsen'], sleeps: null });

/** Twenty past seasons where Feb 6–15 snows on 5 of its 10 days (7, 8, 11, 13, 14). */
function history(window: { start: string; end: string }): Climatology {
  const seasons = Array.from({ length: 20 }, (_, i) => {
    const s = 2006 + i;
    const { start, end } = seasonDates(s, { start: '12-01', end: '04-15' });
    const out: { date: string; snowfallCm: number }[] = [];
    for (let t = Date.parse(`${start}T00:00:00Z`); ; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d > end) break;
      const day = Number(d.slice(8));
      out.push({ date: d, snowfallCm: d.slice(5, 7) === '02' && day % 5 !== 0 && day % 3 !== 0 ? 4 : 1 });
    }
    return { season: s, days: out };
  });
  return summarizeClimatology({
    window,
    span: { start: '12-01', end: '04-15' },
    seasons,
    snowDayCm: 2,
  })!;
}

const resortLookup: LookupResult<ResortSnow> = {
  data: {
    annualSnowfallCm: 1480,
    measuredWhere: 'summit',
    monthlySnowfallCm: { december: 280, january: 390, february: 350, march: 210, april: 60 },
    snowiestMonth: 'January',
    notes: 'resort 10-year average',
  },
  sources: ['https://example.test/niseko-snow'],
  askedAt: '2026-09-14T10:00:00Z',
  model: 'claude-sonnet-4-6',
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
      options: [lodge, chalet, skye],
      pick: chalet,
      shortlist: [
        { ...chalet, role: 'pick' },
        { ...lodge, role: 'cheapest' },
        { ...skye, role: 'nicest' },
      ],
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
    climate: { history: history(w), resort: resortLookup },
    ...over,
  };
}

/** A well-behaved model reply, built from the fixture's real numbers. */
function goodCopy(e: Expedition): DossierCopy {
  return {
    hook: 'Siberia keeps loading the cannon and Hokkaido keeps firing it.',
    pitch: `Hirafu trees, onsen every night, and a chalet with a hot tub for $${e.lodging.perPersonUsd} each.`,
    snow: `Snow on ~${e.climate.history!.typicalSnowDays} of these ${e.climate.history!.windowDays} days in a typical year; the resort reports ~350cm in February.`,
    flightsNote: 'Everyone flies from home and lands the same evening.',
    lodgingNote: 'The chalet is the one: hot tub, kitchen, sleeps six.',
    plan: e.weather.dayPlan.map((d) => ({ date: d.date, line: `${d.plannedAt} day` })),
    catch: 'Fares move with the dates.',
    signoff: 'Who is in?',
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

describe('expedition climate', () => {
  it('leads with history while the trip is past the forecast, with the day it comes into view', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    expect(e.climate.mode).toBe('history');
    expect(e.climate.forecastVisibleFrom).toBe('2027-01-23'); // Feb 6 is day 15 of a forecast issued Jan 23
    expect(e.climate.history?.typicalSnowDays).toBe(5);
    expect(e.climate.resort).toMatchObject({
      annualCm: 1480,
      annualM: 14.8,
      windowMonth: 'February',
      windowMonthCm: 350,
    });
    expect(e.sources).toEqual(expect.arrayContaining(['open-meteo:archive', 'lookup:resort-snow']));
  });

  it('switches to the forecast once the models reach the first day', () => {
    const e = buildExpedition(nisekoInputs(), cfg, new Date('2027-01-25T12:00:00Z'));
    expect(e.climate.mode).toBe('forecast');
  });

  it('weights the resort month across a window that spans two months', () => {
    const w = { start: '2027-01-29', end: '2027-02-07' }; // 3 days of Jan, 7 of Feb
    const e = buildExpedition(nisekoInputs({ window: w }), cfg, NOW);
    expect(e.climate.resort?.windowMonthCm).toBe(Math.round((390 * 3 + 350 * 7) / 10));
  });

  it('carries the shortlist into the plan with per-person numbers and links', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    expect(e.lodging.options.map((o) => [o.n, o.role, o.name])).toEqual([
      [1, 'pick', 'Hirafu Pine Chalet'],
      [2, 'cheapest', 'Hirafu Budget Lodge'],
      [3, 'nicest', 'Skye Niseko'],
    ]);
    expect(e.lodging.options[0]).toMatchObject({
      perPersonPerNightUsd: 126,
      perPersonUsd: 1134,
      url: 'https://example.test/chalet',
    });
    expect(e.lodging.link).toBe('https://example.test/chalet');
  });
});

describe('quotes', () => {
  it("uses the destination's own quote, else a pool quote chosen stably by id, else none", () => {
    expect(buildExpedition(nisekoInputs(), cfg, NOW).quote?.by).toBe('Matsuo Bashō');
    const whistler = by('whistler');
    const a = buildExpedition(nisekoInputs({ dest: whistler }), cfg, NOW).quote;
    const b = buildExpedition(nisekoInputs({ dest: whistler }), cfg, NOW).quote;
    expect(cfg.expedition.quote_pool).toContainEqual(a);
    expect(b).toEqual(a);
    cfg.expedition.quote_pool = [];
    expect(buildExpedition(nisekoInputs({ dest: whistler }), cfg, NOW).quote).toBeNull();
    expect(fallbackRender(buildExpedition(nisekoInputs({ dest: whistler }), cfg, NOW)).root).not.toMatch(/^> /m);
  });

  it('every quote in config is attributed', () => {
    const all = [...cfg.board.flatMap((d) => (d.pitch.quote ? [d.pitch.quote] : [])), ...cfg.expedition.quote_pool];
    expect(all.length).toBeGreaterThanOrEqual(9);
    for (const q of all) {
      expect(q.by.trim()).not.toBe('');
      expect(q.source.trim()).not.toBe('');
      if (q.translation === 'ours') expect(q.original).toBeTruthy();
    }
  });

  it('shows the model the quote so the hook does not repeat it', () => {
    const t = trimForPrompt(buildExpedition(nisekoInputs(), cfg, NOW));
    expect(t.quote?.by).toBe('Matsuo Bashō');
  });
});

describe('dossier prompt + fallback', () => {
  it('trims the raw quotes out of what the model sees and hands it the pitch and the history', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const prompt = renderDossierPrompt(e);
    expect(prompt).not.toMatch(/"legs"/);
    expect(prompt).not.toMatch(/"quotes"/);
    expect(prompt).toContain('"headerLine"');
    expect(prompt).toContain('Elliot: BUR $684 / LAX $511');
    const t = trimForPrompt(e);
    expect(t.watchCommand).toBe('/watch niseko-0206');
    expect(t.destination.pitch.hook).toMatch(/powder/);
    expect(t.snow.mode).toBe('history');
    // Past the horizon there is no forecast to misread as one.
    expect(t.snow.forecast).toBeNull();
    expect(t.snow.history?.typicalSnowDays).toBe(5);
    expect(t.lodging.options.map((o) => o.role)).toEqual(['pick', 'cheapest', 'nicest']);
    expect(t.dayPlan.every((d) => d.reason === null || !/horizon/.test(d.reason))).toBe(true);
  });

  it('fallbackRender: a pitch in the channel and three sections in the thread, all under the limit', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const d = fallbackRender(e);
    for (const m of [d.root, ...d.details]) {
      expect(m.length).toBeLessThanOrEqual(DOSSIER_MAX_CHARS);
      // Its own numbers all trace back to the object.
      expect(unquotedNumbers(m, e)).toEqual([]);
    }
    expect(d.root.startsWith(`**${headerLine(e)}**`)).toBe(true);
    expect(headerLine(e)).toMatch(
      /^🇯🇵 NISEKO UNITED — Feb 6–15 — \$[\d,]+\/person — 10 days \(6 on snow\)$/,
    );
    // A real, attributed quote sits under the header; the hook is our own line below it.
    expect(d.root).toContain(
      '\n> *“Well then, let\'s go snow-viewing — till we tumble down.”*\n> — Matsuo Bashō, haiku; our translation\n',
    );
    expect(d.root).toContain(`\n*${e.destination.pitch.hook}*\n`);
    expect(d.root).toContain('❄️ **The snow**');
    expect(d.root).toContain('💸 **All-in** — **$');
    expect(d.root).toContain('at Hirafu Pine Chalet');
    expect(d.root).toContain('**Decide by 2026-09-28.**');
    expect(d.root).toContain('`/watch niseko-0206`');
    expect(d.details).toHaveLength(3);
  });

  it('draws the flights as a monospace table with the delta lines under it', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const [flights] = fallbackRender(e).details;
    expect(flights).toMatch(/^✈️ \*\*Getting there\*\*/);
    const table = flights!.slice(flights!.indexOf('```'), flights!.lastIndexOf('```') + 3);
    const rows = table.split('\n').slice(1, -1);
    expect(rows[0]).toMatch(/^WHO\s+FROM\s+FARE\s+AIRLINE\s+ST\s+LANDS$/);
    expect(rows).toHaveLength(1 + cfg.members.length);
    expect(rows.find((r) => r.startsWith('Devin'))).toMatch(/^Devin\s+JFK\s+\$698\s+ANA\s+1\s+Sun 20:30$/);
    // The hub marker hangs after the number, so the digits still line up.
    const col = (who: string) => rows.find((r) => r.startsWith(who))!.indexOf('$');
    expect(col('Elliot')).toBe(col('Devin'));
    expect(rows.find((r) => r.startsWith('Elliot'))).toContain('$551*');
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(42);
    for (const line of e.routing.deltaLines) expect(flights).toContain(line);
    expect(flights).toMatch(/📉 JFK fares across/);
  });

  it('draws the stay as a table with a clickable, non-unfurling link per option', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const [, lodging] = fallbackRender(e).details;
    expect(lodging).toMatch(/^🏠 \*\*Where you sleep\*\* · 9 nights/);
    expect(lodging).toMatch(/# PLACE\s+TYPE\s+PP\/NT\s+PP\/TRIP\s+★/);
    expect(lodging).toMatch(/1 Hirafu Pine Ch… 3BR\s+\$126\s+\$1,134\s+4\.7/);
    expect(lodging).toMatch(/2 Hirafu Budget … 3 rooms/);
    expect(lodging).toContain('**1** the pick → [Hirafu Pine Chalet](<https://example.test/chalet>) · hot tub, kitchen');
    expect(lodging).toContain('**3** the splurge → [Skye Niseko](<https://example.test/skye-niseko>) · onsen');
  });

  it('the plan section carries the day-by-day, ground, passes, time off and the as-of line', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const [, , plan] = fallbackRender(e).details;
    expect(plan).toMatch(/^🗓️ \*\*The plan\*\* · 10 days door to door, 6 on snow/);
    expect(plan).toContain('• **Sat 6** — fly out');
    expect(plan).toContain('• **Sun 7** — land · Bus CTS -> Hirafu · food and bed');
    expect(plan).toContain('• **Thu 11** — rest day — onsen after riding\n');
    // History mode: the fixture's forecast numbers must not leak into the plan.
    expect(plan).not.toMatch(/\d+cm forecast/);
    expect(plan).toContain('• **Mon 8** — ride — four linked resorts');
    expect(plan).toContain('IKON covers 5 days');
    expect(plan).toContain('2027-02-11');
    expect(plan).toMatch(/-# as of 2026-09-14 12:00 UTC · sources: .*serpapi:flights/);
  });

  it('tells the snow story from history and the resort figure when the forecast cannot see the trip', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const story = snowStory(e);
    expect(story).toMatch(/^Too far out for a forecast; the first real one sees this trip around Jan 23\./);
    expect(story).toMatch(/new snow on ~5 of these 10 days in a typical season/);
    expect(story).toMatch(/(in \d+ of|every one of) the last 20 seasons/);
    expect(story).toContain('The resort reports ~350cm in a typical February.');
    expect(unquotedNumbers(story, e)).toEqual([]);
  });

  it('says it plainly when there is no history at all', () => {
    const e = buildExpedition(nisekoInputs({ climate: { history: null, resort: null } }), cfg, NOW);
    expect(snowStory(e)).toMatch(/No snow history could be fetched/);
  });

  it('fallbackRender says unverified for passes and ground when the lookups are missing', () => {
    const e = buildExpedition(nisekoInputs({ passes: null, ground: null }), cfg, NOW);
    const [, , plan] = fallbackRender(e).details;
    expect(plan).toMatch(/\*\*Passes\*\* — IKON coverage is unverified/);
    expect(plan).toMatch(/\*\*Ground\*\* — Bus CTS -> Hirafu — unverified/);
    expect(plan).not.toMatch(/blackout/i);
    expect(fallbackRender(e).root).toContain('ground unpriced');
  });

  it('prints the band estimate instead of a table when nothing was priced', () => {
    const e = buildExpedition(nisekoInputs({ lodging: null }), cfg, NOW);
    const [, lodging] = fallbackRender(e).details;
    expect(lodging).not.toContain('```');
    expect(lodging).toMatch(/No listing priced yet — budgeting \$135\/pp\/night/);
  });

  it('unquotedNumbers catches invented money, snow, percentages and counts', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const h = e.climate.history!;
    const real = `${headerLine(e)}\nElliot: BUR $684 / LAX $511 — worth the drive. ECMWF ${Math.round(
      e.weather.report.models[0]!.totalCm,
    )}cm. Bus $27 each way, $54 round trip. ~1,480cm a season, 14.8m, call it 15m. Snow on ${h.typicalSnowDays} of ${h.windowDays} days, ${h.seasonsHalfSnowy} of the last ${h.seasons} seasons.`;
    expect(unquotedNumbers(real, e)).toEqual([]);
    expect(
      unquotedNumbers(`${real} ZIPAIR $999 r/t and 140cm on the way, 2,000cm a year.`, e),
    ).toEqual(['$999', '140cm', '2,000cm']);
    expect(unquotedNumbers('It snowed 73% more, 17 of 29 years, 600 inches.', e)).toEqual([
      '600 inches',
      '73%',
      '17 of 29',
    ]);
    // A date in a note is not a licence to quote its digits as a count.
    // The year 2027 is in every date in the object, but dates don't license their digits.
    expect(unquotedNumbers('It snowed on 2027 of 2026 days.', e)).toEqual(['2027 of 2026']);
    // Thousands separators are the model's choice, not a different number.
    expect(unquotedNumbers(`$${e.cost.perPersonUsd.toLocaleString('en-US')}/person`, e)).toEqual(
      [],
    );
  });
});

describe('composeCopy', () => {
  it('uses a well-behaved reply as written', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const copy = goodCopy(e);
    const out = composeCopy(JSON.stringify(copy), e);
    expect(out.replaced).toEqual([]);
    expect(out.copy).toEqual(copy);
    const d = renderDossier(e, out.copy);
    expect(d.root).toContain('\n*Siberia keeps loading the cannon');
    expect(d.root).not.toContain('> *Siberia');
    expect(d.details[2]).toContain('• **Sat 6** — travel day');
  });

  it('swaps only the field that invented a number, and fills a missing day', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const copy = goodCopy(e);
    copy.snow = 'Niseko got 777cm last February alone.';
    copy.plan = copy.plan.slice(1);
    const out = composeCopy('```json\n' + JSON.stringify(copy) + '\n```', e);
    const base = fallbackCopy(e);
    expect(out.copy.hook).toBe(copy.hook);
    expect(out.copy.snow).toBe(base.snow);
    expect(out.copy.plan[0]).toEqual(base.plan[0]);
    expect(out.copy.plan[1]!.line).toBe(copy.plan[0]!.line);
    expect(out.replaced.map((r) => r.field).sort()).toEqual(['plan 2027-02-06', 'snow']);
    expect(out.replaced.find((r) => r.field === 'snow')!.why).toMatch(/777cm/);
  });

  it('cuts an over-long field at a sentence, and falls back when it cannot', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const copy = goodCopy(e);
    const sentence = 'The trees are deep and the lines are short. ';
    copy.pitch = sentence.repeat(20);
    copy.hook = 'x'.repeat(400);
    const out = composeCopy(JSON.stringify(copy), e);
    expect(out.copy.pitch.length).toBeLessThanOrEqual(480);
    expect(out.copy.pitch.endsWith('short.')).toBe(true);
    expect(out.copy.hook).toBe(fallbackCopy(e).hook);
  });

  it('falls back entirely when the reply is not the object', () => {
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    const out = composeCopy('Here is your dossier! Niseko is great.', e);
    expect(out.copy).toEqual(fallbackCopy(e));
    expect(out.replaced[0]!.field).toBe('*');
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
    expect(p.map((x) => x.kind)).toEqual(['root', 'thread', 'thread', 'thread']);
    expect(p[0]!.summary).toMatch(/^\*\*🇯🇵 NISEKO UNITED — Feb 6–15/);
    expect(p[1]!.summary).toMatch(/^✈️ \*\*Getting there/);
    expect(out?.dossier).toEqual(fallbackRender(out!.expedition));
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
    expect(posts().map((p) => p.kind)).toEqual(['root', 'thread', 'thread', 'thread']);
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

  it('uses the model when it behaves, and swaps only the field that invents a number', async () => {
    const d = deps();
    let asked: { prompt: string; system?: string } | null = null;
    d.complete = async (prompt, opts) => {
      asked = { prompt, system: opts.system };
      return JSON.stringify(goodCopy(buildExpedition(nisekoInputs(), cfg, NOW)));
    };
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    try {
      const out = await runExpeditionBuild(ctx(), d);
      expect(asked!.system).toMatch(/make them want it/);
      expect(asked!.prompt).toContain('"mode": "history"');
      expect(out?.dossier.root).toContain('Siberia keeps loading the cannon');

      const db2 = openDb(':memory:');
      d.complete = async () =>
        JSON.stringify({ ...goodCopy(buildExpedition(nisekoInputs(), cfg, NOW)), pitch: 'ZIPAIR LAX→NRT $999 r/t.' });
      const out2 = await runExpeditionBuild(
        ctx({
          db: db2,
          poster: new Poster(cfg, db2, { dryRun: true, target: 'test', job: 'expeditionBuild' }),
        }),
        d,
      );
      expect(out2?.dossier.root).toContain('Siberia keeps loading the cannon');
      expect(out2?.dossier.root).not.toContain('$999');
      expect(out2?.dossier.root).toContain(fallbackCopy(out2!.expedition).pitch);

      const db3 = openDb(':memory:');
      d.complete = async () => { throw new Error('overloaded'); };
      const out3 = await runExpeditionBuild(
        ctx({
          db: db3,
          poster: new Poster(cfg, db3, { dryRun: true, target: 'test', job: 'expeditionBuild' }),
        }),
        d,
      );
      expect(out3?.dossier).toEqual(fallbackRender(out3!.expedition));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a rebuild opens the thread a post never got, then posts every section into it', async () => {
    const calls: string[] = [];
    class FakePoster extends Poster {
      override get connected() {
        return true;
      }
      override async editMessage(id: string) {
        calls.push(`edit:${id}`);
        return { messageId: id, suppressed: false };
      }
      override async ensureThread(id: string) {
        calls.push(`thread-for:${id}`);
        return 'thread-9';
      }
      override async postThread(threadId: string | null) {
        calls.push(`thread:${threadId}`);
        return { messageId: `d-${calls.length}`, suppressed: false };
      }
    }
    const poster = new FakePoster(cfg, db, { dryRun: false, target: 'test', job: 'expeditionBuild' });
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    db.prepare(
      `INSERT INTO expeditions (id, destination, window_start, window_end, days_total, days_on_snow,
         plan_json, total_pp_usd, confidence, status, root_message_id, thread_id)
       VALUES (?, 'niseko', ?, ?, 10, 6, '{}', 1800, 'high', 'proposed', 'root-7', NULL)`,
    ).run(e.id, e.window.start, e.window.end);
    kvSet(db, KV_BUILD_REQUEST, JSON.stringify({ destination: 'niseko', month: '2027-02' }));
    inputsFor = () => nisekoInputs();
    await runExpeditionBuild(ctx({ poster }), deps());
    expect(calls).toEqual([
      'edit:root-7',
      'thread-for:root-7',
      'thread:thread-9',
      'thread:thread-9',
      'thread:thread-9',
    ]);
    expect(expeditions()[0]!.thread_id).toBe('thread-9');
  });

  it('fails the job, not silently, when the thread sections cannot be posted', async () => {
    class NoThreads extends Poster {
      override async postRoot() {
        return { messageId: 'root-1', suppressed: false };
      }
      override async ensureThread() {
        return null;
      }
      override async postThread() {
        return { messageId: null, suppressed: true, reason: 'no thread to post into' };
      }
    }
    const poster = new NoThreads(cfg, db, { dryRun: false, target: 'test', job: 'expeditionBuild' });
    kvSet(db, KV_BUILD_REQUEST, JSON.stringify({ destination: 'niseko' }));
    await expect(runExpeditionBuild(ctx({ poster }), deps())).rejects.toThrow(
      /posted the pitch but not the thread sections \(no thread to post into\).*Read Message History/,
    );
  });

  it('a rebuild edits the root and every thread section in place', async () => {
    const calls: string[] = [];
    let n = 0;
    class FakePoster extends Poster {
      override async postRoot() {
        calls.push('root');
        return { messageId: 'root-1', suppressed: false };
      }
      override async ensureThread() {
        return 'thread-1';
      }
      override async postThread(threadId: string | null) {
        n += 1;
        calls.push(`thread:${threadId}`);
        return { messageId: `detail-${n}`, suppressed: false };
      }
      override async editMessage(id: string) {
        calls.push(`edit:${id}`);
        return { messageId: id, suppressed: false };
      }
      override async editThreadMessage(threadId: string, id: string) {
        calls.push(`edit:${threadId}/${id}`);
        return { messageId: id, suppressed: false };
      }
    }
    const poster = new FakePoster(cfg, db, { dryRun: false, target: 'test', job: 'expeditionBuild' });
    const c = ctx({ poster });
    kvSet(db, KV_BUILD_REQUEST, JSON.stringify({ destination: 'niseko' }));
    await runExpeditionBuild(c, deps());
    expect(calls).toEqual(['root', 'thread:thread-1', 'thread:thread-1', 'thread:thread-1']);
    expect(JSON.parse(kvGet(db, kvDetailsKey('niseko-0206'))!)).toEqual([
      'detail-1',
      'detail-2',
      'detail-3',
    ]);

    calls.length = 0;
    kvSet(db, KV_BUILD_REQUEST, JSON.stringify({ destination: 'niseko' }));
    await runExpeditionBuild(c, deps());
    expect(calls).toEqual([
      'edit:root-1',
      'edit:thread-1/detail-1',
      'edit:thread-1/detail-2',
      'edit:thread-1/detail-3',
    ]);
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
