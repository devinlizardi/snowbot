import { describe, expect, it } from 'vitest';
import {
  buildExpedition,
  expeditionId,
  expeditionToRow,
  insertExpedition,
  minDaysNote,
  planDays,
  rowToExpedition,
  weekdaysIn,
  type ExpeditionInputs,
  type ExpeditionRow,
} from '../src/builder.js';
import { loadConfig, type Destination } from '../src/config.js';
import { openDb } from '../src/db.js';
import type { FlightQuote, FlightSearch } from '../src/sources/flights.js';
import type { LodgingOption, LodgingSearch } from '../src/sources/lodging.js';
import type { GroundTransport, LookupResult, PassStatus } from '../src/sources/lookup.js';
import { buildSnowReport } from '../src/sources/weather/consensus.js';
import type { DailyWeather, ModelForecast } from '../src/sources/weather/types.js';

const cfg = loadConfig({ env: {} });
const NOW = new Date('2026-09-14T12:00:00Z');
const niseko: Destination = cfg.board.find((d) => d.id === 'niseko')!;
const revelstoke: Destination = cfg.board.find((d) => d.id === 'revelstoke')!;

/* ------------------------------------------------------------ fixtures */

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

/** Daily snowfall per model at the base, starting at `start`. */
function model(
  name: string,
  start: string,
  snow: number[],
  lat: number,
  lon: number,
): ModelForecast {
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
  return { model: name, coord: { lat, lon }, modelElevationM: 300, days, missingVariables: [] };
}

function lodgingFixture(
  window: { start: string; end: string },
  pick: LodgingOption,
): LodgingSearch {
  return {
    query: 'x ski',
    checkIn: window.start,
    checkOut: window.end,
    options: [pick],
    pick,
    searchedAt: '2026-09-14T10:00:00Z',
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
      {
        mode: 'private_transfer',
        operator: null,
        durationMin: 120,
        priceUsdPp: 90,
        notes: 'per person, 5 seats',
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

/* Niseko: Sat Feb 6 → Mon Feb 15 2027, 10 days, long-haul (lands the next day). */
const NISEKO_WINDOW = { start: '2027-02-06', end: '2027-02-15' };
const NISEKO_SNOW = [12, 18, 35, 22, 8, 4, 15, 28, 10, 6];

function nisekoInputs(over: Partial<ExpeditionInputs> = {}): ExpeditionInputs {
  const w = NISEKO_WINDOW;
  const s = (o: string, p: number, arr = '2027-02-07 21:05') => search(o, niseko, w, p, arr);
  return {
    dest: niseko,
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
        { depart: '2027-02-06', return: '2027-02-15', offsetDays: 0, priceUsd: 698 },
        { depart: '2027-02-05', return: '2027-02-14', offsetDays: -1, priceUsd: 760 },
        { depart: '2027-02-07', return: '2027-02-16', offsetDays: 1, priceUsd: 812 },
        { depart: '2027-02-04', return: '2027-02-13', offsetDays: -2, priceUsd: 905 },
        { depart: '2027-02-08', return: '2027-02-17', offsetDays: 2, priceUsd: null },
      ],
      anchorOrigin: 'JFK',
    },
    lodging: lodgingFixture(w, chalet),
    ground: groundLookup,
    passes: passLookup,
    weather: buildSnowReport({
      window: w,
      base: [
        model('ecmwf_ifs025', w.start, NISEKO_SNOW, niseko.lat, niseko.lon),
        model(
          'ecmwf_aifs025',
          w.start,
          NISEKO_SNOW.map((c) => c * 0.9),
          niseko.lat,
          niseko.lon,
        ),
        model(
          'gfs_seamless',
          w.start,
          NISEKO_SNOW.map((c) => c * 1.1),
          niseko.lat,
          niseko.lon,
        ),
      ],
      baseElevationM: niseko.base_elevation_m,
      summitElevationM: niseko.summit_elevation_m,
    }),
    ...over,
  };
}

/* Revelstoke: Sat Feb 13 → Fri Feb 19 2027, 7 days, same-day arrival. */
const REVY_WINDOW = { start: '2027-02-13', end: '2027-02-19' };
const REVY_SNOW = [5, 20, 30, 12, 8, 3, 2];

function revelstokeInputs(over: Partial<ExpeditionInputs> = {}, fare = 480): ExpeditionInputs {
  const w = REVY_WINDOW;
  const s = (o: string, p: number, arr = '2027-02-13 18:40') => search(o, revelstoke, w, p, arr);
  return {
    dest: revelstoke,
    window: w,
    flights: {
      byOrigin: {
        JFK: s('JFK', fare + 200, '2027-02-13 19:10'),
        EWR: s('EWR', fare + 210, '2027-02-13 19:10'),
        BUR: s('BUR', fare + 40),
        SNA: s('SNA', fare + 30),
        LAX: s('LAX', fare),
        SFO: s('SFO', fare - 20, '2027-02-13 17:55'),
      },
      attempts: [{ depart: w.start, return: w.end, offsetDays: 0, priceUsd: fare + 200 }],
      anchorOrigin: 'JFK',
    },
    lodging: null,
    ground: null,
    passes: null,
    weather: buildSnowReport({
      window: w,
      base: [
        model('ecmwf_ifs025', w.start, REVY_SNOW, revelstoke.lat, revelstoke.lon),
        model(
          'gfs_seamless',
          w.start,
          REVY_SNOW.map((c) => c * 1.2),
          revelstoke.lat,
          revelstoke.lon,
        ),
      ],
      baseElevationM: revelstoke.base_elevation_m,
      summitElevationM: revelstoke.summit_elevation_m,
    }),
    ...over,
  };
}

/* --------------------------------------------------------------- tests */

describe('buildExpedition — Niseko (JP, 10 days)', () => {
  const e = buildExpedition(nisekoInputs(), cfg, NOW);

  it('is a complete expedition with the right shape', () => {
    expect(e.id).toBe('niseko-0206');
    expect(e.destination.id).toBe('niseko');
    expect(e.window).toEqual(NISEKO_WINDOW);
    expect(e.daysTotal).toBe(10);
    expect(e.workingDays).toBe(6); // Mon–Fri 8–12 plus Mon 15
    expect(e.confidence).toBe(e.weather.report.confidence);
    expect(e.asOf).toBe(NOW.toISOString());
    expect(e.routing.recommended).toBe('consolidate-west');
    expect(e.routing.deltaLines[0]).toMatch(/^Elliot: BUR \$684 \/ LAX \$511 — worth the drive/);
  });

  it('plans the days: travel at both ends plus the arrival day, one rest day, the rest on snow', () => {
    const at = Object.fromEntries(e.weather.dayPlan.map((d) => [d.date, d.plannedAt]));
    expect(at['2027-02-06']).toBe('travel');
    expect(at['2027-02-07']).toBe('travel'); // lands 21:05 the day after departure
    expect(at['2027-02-15']).toBe('travel');
    expect(e.weather.dayPlan.filter((d) => d.plannedAt === 'rest')).toHaveLength(1);
    expect(e.daysOnSnow).toBe(6);
    expect(e.weather.dayPlan).toHaveLength(10);
  });

  it('puts the biggest forecast day on snow and rests on the lightest', () => {
    const biggest = e.weather.dayPlan.find((d) => d.date === '2027-02-08')!; // 35cm
    expect(biggest.plannedAt).toBe('on-snow');
    expect(biggest.reason).toMatch(/biggest forecast day, 35cm/);
    const rest = e.weather.dayPlan.find((d) => d.plannedAt === 'rest')!;
    expect(rest.date).toBe('2027-02-11'); // 4cm, the lightest non-travel day
  });

  it('uses the priced chalet, the looked-up bus and the looked-up pass', () => {
    expect(e.lodging).toMatchObject({
      name: 'Hirafu Pine Chalet',
      nights: 9,
      perPersonPerNightUsd: 126,
      perPersonUsd: 1134,
      estimated: false,
    });
    expect(e.ground.status).toBe('looked-up');
    expect(e.ground.perPersonUsd).toBe(54); // $27 each way
    expect(e.passes).toMatchObject({
      status: 'verified',
      pass: 'IKON',
      covered: true,
      daysIncluded: 5,
      blackoutsInWindow: ['2027-02-11'],
    });
  });

  it('totals the cost per person from the recommended routing', () => {
    const elliot = e.cost.perMember.find((c) => c.member === 'Elliot')!;
    expect(elliot.chosenOrigin).toBe('LAX');
    expect(elliot.flightUsd).toBe(551); // $511 fare + ~$40 to LAX
    expect(elliot.totalUsd).toBe(551 + 1134 + 54);
    expect(elliot.notes.some((n) => n.startsWith('routing (consolidate-west)'))).toBe(true);
    const devin = e.cost.perMember.find((c) => c.member === 'Devin')!;
    expect(devin.totalUsd).toBe(698 + 1134 + 54);
    expect(e.cost.groupUsd).toBe(e.cost.perMember.reduce((s, c) => s + c.totalUsd, 0));
    expect(e.cost.perPersonUsd).toBe(Math.round(e.cost.groupUsd / 5));
    expect(e.cost.ceilingUsd).toBe(cfg.expedition.ceiling_usd.international);
    expect(e.cost.overCeiling).toBe(false);
  });

  it('writes a decide-by date and a volatility note from the flex spread', () => {
    // min(Feb 6 − 21d = Jan 16, now + 14d = Sep 28) — the sooner one.
    expect(e.volatility.decideBy).toBe('2026-09-28');
    expect(e.volatility.note).toMatch(
      /JFK fares across the ±2-day windows ran \$698–\$905 \(30% spread\)/,
    );
    expect(e.volatility.note).toMatch(/Decide by 2026-09-28/);
  });

  it('says the trip length is the full one Niseko deserves', () => {
    expect(e.minDaysNote).toBe(
      '10 days (6 on snow) is the full 10-day trip Niseko United deserves; the floor is 8.',
    );
  });

  it('lists every namespace and URL that contributed', () => {
    expect(e.sources).toEqual(
      expect.arrayContaining([
        'serpapi:flights',
        'serpapi:hotels',
        'lookup:ground-transport',
        'https://example.test/resort-liner',
        'lookup:pass-status',
        'https://example.test/ikon-niseko',
        'open-meteo:ecmwf_ifs025',
        'open-meteo:gfs_seamless',
      ]),
    );
    expect(e.sources).not.toContain('weathernext:bigquery');
  });
});

describe('buildExpedition — Revelstoke (CA, 7 days)', () => {
  const e = buildExpedition(revelstokeInputs(), cfg, NOW);

  it('is complete with band lodging, unverified ground and unverified passes', () => {
    expect(e.id).toBe('revelstoke-0213');
    expect(e.daysTotal).toBe(7);
    expect(e.workingDays).toBe(5);
    expect(e.lodging).toMatchObject({
      type: 'band',
      estimated: true,
      nights: 6,
      perPersonPerNightUsd: 130,
    });
    expect(e.lodging.note).toMatch(/band/);
    expect(e.ground).toEqual({
      status: 'unverified',
      description: 'Rental car YLW -> Revelstoke (~2.5h)',
      perPersonUsd: null,
    });
    expect(e.passes).toEqual({ status: 'unverified' });
  });

  it('has no rest day on a 7-day trip and no extra arrival day when the flight lands same-day', () => {
    const plan = e.weather.dayPlan.map((d) => d.plannedAt);
    expect(plan).toEqual([
      'travel',
      'on-snow',
      'on-snow',
      'on-snow',
      'on-snow',
      'on-snow',
      'travel',
    ]);
    expect(e.daysOnSnow).toBe(5);
    expect(e.weather.dayPlan[2]!.reason).toMatch(/biggest forecast day, 33cm/);
  });

  it('uses the international ceiling for Canada and stays under it', () => {
    expect(e.cost.ceilingUsd).toBe(cfg.expedition.ceiling_usd.international);
    expect(e.cost.overCeiling).toBe(false);
    expect(e.minDaysNote).toMatch(
      /^7 days \(5 on snow\) is the full 7-day trip Revelstoke deserves/,
    );
  });

  it('flags over-ceiling when the fares blow through it', () => {
    const pricey = buildExpedition(revelstokeInputs({}, 2400), cfg, NOW);
    expect(pricey.cost.perPersonUsd).toBeGreaterThan(pricey.cost.ceilingUsd);
    expect(pricey.cost.overCeiling).toBe(true);
  });

  it('uses the domestic ceiling for a US destination', () => {
    const jackson = cfg.board.find((d) => d.id === 'jackson')!;
    const inputs = revelstokeInputs({ dest: jackson });
    const e2 = buildExpedition(inputs, cfg, NOW);
    expect(e2.cost.ceilingUsd).toBe(cfg.expedition.ceiling_usd.domestic);
    expect(e2.id).toBe('jackson-0213');
  });

  it('decides by three weeks out when the window is close', () => {
    const soon = buildExpedition(revelstokeInputs(), cfg, new Date('2027-01-30T00:00:00Z'));
    expect(soon.volatility.decideBy).toBe('2027-01-23');
    expect(soon.volatility.note).toMatch(/Only one dated fare from JFK/);
  });
});

describe('passes never come from config', () => {
  it('reports unverified when the lookup is missing, whatever the board says', () => {
    for (const dest of cfg.board) {
      expect(dest.pass_verify).toBe(true);
      const e = buildExpedition(nisekoInputs({ dest, passes: null }), cfg, NOW);
      expect(e.passes).toEqual({ status: 'unverified' });
      expect(JSON.stringify(e.passes)).not.toMatch(/IKON|blackout/i);
    }
  });
});

describe('helpers', () => {
  it('counts working days as weekdays inside the window', () => {
    expect(weekdaysIn({ start: '2027-02-12', end: '2027-02-20' })).toBe(6); // PLAN §1B example
    expect(weekdaysIn({ start: '2027-02-13', end: '2027-02-14' })).toBe(0);
    expect(weekdaysIn({ start: '2027-02-15', end: '2027-02-15' })).toBe(1);
  });

  it('writes an honest min-days note on either side of the floor', () => {
    expect(minDaysNote(niseko, 6, 4)).toMatch(/under the 8-day floor for Niseko United/);
    expect(minDaysNote(niseko, 9, 6)).toMatch(/clears the 8-day floor .* short of the 10/);
  });

  it('builds ids from the departure date', () => {
    expect(expeditionId(niseko, { start: '2027-12-30', end: '2028-01-08' })).toBe('niseko-1230');
  });

  it('plans only travel days when the forecast has nothing to say', () => {
    const e = buildExpedition(revelstokeInputs(), cfg, NOW);
    const blank = buildSnowReport({
      window: REVY_WINDOW,
      base: [],
      baseElevationM: 500,
      summitElevationM: 2000,
    });
    const plan = planDays(REVY_WINDOW, blank, e.routing);
    expect(
      plan
        .filter((d) => d.plannedAt === 'on-snow')
        .every((d) => /beyond the forecast/.test(d.reason)),
    ).toBe(true);
  });
});

describe('expeditions table round-trip', () => {
  it('survives to-row / insert / select / from-row unchanged', () => {
    const db = openDb(':memory:');
    const e = buildExpedition(nisekoInputs(), cfg, NOW);
    insertExpedition(db, e);

    const row = db.prepare('SELECT * FROM expeditions WHERE id = ?').get(e.id) as ExpeditionRow;
    expect(row).toMatchObject({
      id: 'niseko-0206',
      destination: 'niseko',
      window_start: '2027-02-06',
      window_end: '2027-02-15',
      days_total: 10,
      days_on_snow: 6,
      total_pp_usd: e.cost.perPersonUsd,
      confidence: e.confidence,
      status: 'proposed',
    });
    expect(rowToExpedition(row)).toEqual(e);
    expect(expeditionToRow(e).plan_json).toBe(row.plan_json);
  });

  it('refreshes the plan on a rebuild without touching status or message ids', () => {
    const db = openDb(':memory:');
    const first = buildExpedition(nisekoInputs(), cfg, NOW);
    insertExpedition(db, first);
    db.prepare(
      `UPDATE expeditions SET status = 'watched', root_message_id = 'm1' WHERE id = ?`,
    ).run(first.id);

    const later = new Date('2026-09-21T12:00:00Z');
    const second = buildExpedition(nisekoInputs(), cfg, later);
    insertExpedition(db, second);

    const rows = db.prepare('SELECT * FROM expeditions').all() as ExpeditionRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'watched', root_message_id: 'm1' });
    expect(rowToExpedition(rows[0]!).asOf).toBe(later.toISOString());
  });
});
