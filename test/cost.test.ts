import { describe, expect, it } from 'vitest';
import { loadConfig, type Destination, type Member } from '../src/config.js';
import { estimateCost } from '../src/sources/cost.js';
import type { FlightQuote, FlightSearch } from '../src/sources/flights.js';
import type { FxTable } from '../src/sources/fx.js';
import type { LodgingOption, LodgingSearch } from '../src/sources/lodging.js';

const cfg = loadConfig({ env: {} });
const elliot: Member = cfg.members.find((m) => m.name === 'Elliot')!;
const devin: Member = cfg.members.find((m) => m.name === 'Devin')!;
const niseko: Destination = cfg.board.find((d) => d.id === 'niseko')!;

const WINDOW = { depart: '2027-02-06', return: '2027-02-16' }; // 10 nights

function quote(priceUsd: number): FlightQuote {
  return {
    priceUsd,
    airlines: ['ANA'],
    stops: 1,
    durationMin: 910,
    departAt: '2027-02-06 12:55',
    arriveAt: '2027-02-07 21:05',
    legs: [],
    source: 'serpapi',
  };
}

function search(origin: string, prices: number[]): FlightSearch {
  const quotes = prices.map(quote).sort((a, b) => a.priceUsd - b.priceUsd);
  return {
    origin,
    dest: 'CTS',
    ...WINDOW,
    quotes,
    cheapest: quotes[0] ?? null,
    best: quotes[0] ?? null,
    searchedAt: '2026-09-14T12:00:00Z',
  };
}

const chalet: LodgingOption = {
  name: 'Hirafu Pine Chalet',
  type: 'vacation_rental',
  totalUsd: 4120,
  perNightUsd: 412,
  perPersonPerNightUsd: 82.4,
  rating: 4.7,
  reviews: 38,
  sleeps: 8,
  link: null,
  source: 'serpapi',
};
const lodgingSearch: LodgingSearch = {
  query: 'Niseko United ski',
  checkIn: WINDOW.depart,
  checkOut: WINDOW.return,
  options: [chalet],
  pick: chalet,
  searchedAt: '2026-09-14T12:00:00Z',
};

describe('estimateCost', () => {
  it('prices Elliot from both airports, picks the cheaper and states the delta', () => {
    const out = estimateCost(
      elliot,
      niseko,
      WINDOW,
      {
        flightsByOrigin: { BUR: search('BUR', [684, 720]), LAX: search('LAX', [511, 968]) },
        lodging: lodgingSearch,
      },
      { groundUsdPp: 60 },
    );
    expect(out.member).toBe('Elliot');
    expect(out.originsPriced).toEqual([
      { origin: 'BUR', priceUsd: 684 },
      { origin: 'LAX', priceUsd: 511 },
    ]);
    expect(out.chosenOrigin).toBe('LAX');
    expect(out.flightUsd).toBe(511);
    expect(out.lodgingUsd).toBe(824); // 82.4 × 10 nights
    expect(out.groundUsd).toBe(60);
    expect(out.totalUsd).toBe(511 + 824 + 60);
    expect(out.notes).toContain(
      'Elliot: BUR $684 / LAX $511 — LAX is $173 cheaper than BUR, worth the drive',
    );
  });

  it('stays at the home airport when it wins and says by how much', () => {
    const out = estimateCost(elliot, niseko, WINDOW, {
      flightsByOrigin: { BUR: search('BUR', [500]), LAX: search('LAX', [540]) },
      lodging: lodgingSearch,
    });
    expect(out.chosenOrigin).toBe('BUR');
    expect(out.notes).toContain('Elliot: BUR $500 / LAX $540 — BUR wins by $40');
    expect(out.notes).toContain('ground: not estimated');
    expect(out.groundUsd).toBe(0);
  });

  it('falls back to the lodging band midpoint when there is no lodging search', () => {
    const out = estimateCost(devin, niseko, WINDOW, {
      flightsByOrigin: { JFK: search('JFK', [1240.6]) },
      lodging: null,
    });
    const [lo, hi] = niseko.lodging_band_usd_pp_night;
    expect(out.originsPriced).toEqual([{ origin: 'JFK', priceUsd: 1240.6 }]);
    expect(out.flightUsd).toBe(1241);
    expect(out.lodgingUsd).toBe(((lo + hi) / 2) * 10);
    expect(out.totalUsd).toBe(1241 + ((lo + hi) / 2) * 10);
    expect(Number.isInteger(out.totalUsd)).toBe(true);
    expect(out.notes.some((n) => n.includes('band midpoint'))).toBe(true);
    // A single priced airport gets no delta line.
    expect(out.notes.some((n) => n.startsWith('Devin:'))).toBe(false);
  });

  it('flags a missing origin and still prices the other', () => {
    const out = estimateCost(elliot, niseko, WINDOW, {
      flightsByOrigin: { LAX: search('LAX', [600]) },
      lodging: lodgingSearch,
    });
    expect(out.originsPriced).toEqual([
      { origin: 'BUR', priceUsd: null },
      { origin: 'LAX', priceUsd: 600 },
    ]);
    expect(out.chosenOrigin).toBe('LAX');
    expect(out.flightUsd).toBe(600);
    expect(out.notes).toContain('BUR: no fare returned');
  });

  it('excludes airfare from the total, loudly, when nothing was priced', () => {
    const out = estimateCost(devin, niseko, WINDOW, {
      flightsByOrigin: { JFK: search('JFK', []) },
      lodging: lodgingSearch,
    });
    expect(out.flightUsd).toBeNull();
    expect(out.chosenOrigin).toBe('JFK');
    expect(out.totalUsd).toBe(824);
    expect(out.notes.some((n) => n.includes('total excludes airfare'))).toBe(true);
  });

  it('records the fx table date when one is supplied', () => {
    const fx: FxTable = { base: 'USD', date: '2026-09-11', rates: { JPY: 147.32 } };
    const out = estimateCost(devin, niseko, WINDOW, {
      flightsByOrigin: { JFK: search('JFK', [1000]) },
      lodging: lodgingSearch,
      fx,
    });
    expect(out.notes).toContain('fx: USD table dated 2026-09-11');
  });
});
