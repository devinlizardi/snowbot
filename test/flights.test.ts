import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { kvGet, kvSet, openDb, type DB } from '../src/db.js';
import { cached } from '../src/sources/_cache.js';
import { searchWithCap } from '../src/sources/_serpapi.js';
import {
  flexWindows,
  flights,
  parseFlights,
  searchCapReached,
  searchFlights,
  searchFlightsFlex,
  serpapiSearchesThisMonth,
  shiftDate,
  type FlightSearch,
  type RawFlightsResponse,
} from '../src/sources/flights.js';

const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), 'test', 'fixtures', 'serpapi-flights-lax-cts.json'), 'utf8'),
) as RawFlightsResponse;

const WINDOW = { origin: 'LAX', dest: 'CTS', depart: '2027-02-06', return: '2027-02-16' };
const NOW = new Date('2026-09-14T12:00:00Z');

let db: DB;
let cfg: Config;
beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({ env: {} });
});

describe('parseFlights', () => {
  const out = parseFlights(FIXTURE, WINDOW, '2026-09-14T12:00:00Z');

  it('merges best and other, sorted by price, dropping unpriced rows', () => {
    expect(out.quotes.map((q) => q.priceUsd)).toEqual([968, 1184, 1302]);
    expect(out.cheapest?.priceUsd).toBe(968);
    expect(out.cheapest?.airlines).toEqual(['Korean Air']);
  });

  it("keeps Google's own best pick separately from the cheapest", () => {
    expect(out.best?.priceUsd).toBe(1184);
    expect(out.best?.airlines).toEqual(['ANA']);
  });

  it('builds legs with stops, endpoints and total duration', () => {
    const q = out.best!;
    expect(q.stops).toBe(1);
    expect(q.durationMin).toBe(910);
    expect(q.departAt).toBe('2027-02-06 12:55');
    expect(q.arriveAt).toBe('2027-02-07 21:05');
    expect(q.legs.map((l) => `${l.from}-${l.to} ${l.flightNumber}`)).toEqual([
      'LAX-HND NH 105',
      'HND-CTS NH 79',
    ]);
    expect(q.source).toBe('serpapi');
  });

  it('lists distinct airlines for a codeshare-ish mixed itinerary', () => {
    expect(out.quotes[2]?.airlines).toEqual(['United', 'ANA']);
  });

  it('copes with an empty response', () => {
    const empty = parseFlights({}, WINDOW, 'x');
    expect(empty.quotes).toEqual([]);
    expect(empty.cheapest).toBeNull();
    expect(empty.best).toBeNull();
  });
});

describe('flexWindows', () => {
  it('shifts both ends by the same offset, -flex..+flex', () => {
    expect(flexWindows('2027-02-06', '2027-02-16', 2)).toEqual([
      { depart: '2027-02-04', return: '2027-02-14', offsetDays: -2 },
      { depart: '2027-02-05', return: '2027-02-15', offsetDays: -1 },
      { depart: '2027-02-06', return: '2027-02-16', offsetDays: 0 },
      { depart: '2027-02-07', return: '2027-02-17', offsetDays: 1 },
      { depart: '2027-02-08', return: '2027-02-18', offsetDays: 2 },
    ]);
  });

  it('flex 0 is exactly the requested window', () => {
    expect(flexWindows('2027-01-24', '2027-01-30', 0)).toEqual([
      { depart: '2027-01-24', return: '2027-01-30', offsetDays: 0 },
    ]);
  });

  it('crosses month and year boundaries', () => {
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2027-03-01', -1)).toBe('2027-02-28');
  });
});

describe('search counter and cap', () => {
  /** Same shape as `flights` but with the network swapped for the fixture. */
  function stubbed() {
    const fetch = vi.fn(
      async (p: { origin: string; dest: string; depart: string; return: string }) =>
        parseFlights(FIXTURE, p, NOW.toISOString()),
    );
    return { source: { ...flights, fetch }, fetch };
  }

  it('starts at zero for the month', () => {
    expect(serpapiSearchesThisMonth(db, NOW)).toBe(0);
    expect(searchCapReached(cfg, db, NOW)).toBe(false);
  });

  it('increments only on a live fetch, not on a cache hit', async () => {
    const { source, fetch } = stubbed();
    const a = await searchWithCap(db, cfg, source, WINDOW, { now: NOW });
    const b = await searchWithCap(db, cfg, source, WINDOW, { now: NOW });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(serpapiSearchesThisMonth(db, NOW)).toBe(1);
    expect(kvGet(db, 'serpapi:searches:2026-09')).toBe('1');
  });

  it('keys the counter by month', async () => {
    const { source } = stubbed();
    await searchWithCap(db, cfg, source, WINDOW, { now: NOW });
    const october = new Date('2026-10-01T00:00:00Z');
    expect(serpapiSearchesThisMonth(db, october)).toBe(0);
    expect(serpapiSearchesThisMonth(db, NOW)).toBe(1);
  });

  it('serves stale cache and never fetches once the cap is reached', async () => {
    const { source, fetch } = stubbed();
    await searchWithCap(db, cfg, source, WINDOW, { now: NOW });
    kvSet(db, 'serpapi:searches:2026-09', String(cfg.flights.monthly_search_cap));
    expect(searchCapReached(cfg, db, NOW)).toBe(true);

    // Well past the ttl, so a normal cached() would refetch.
    const later = new Date(NOW.getTime() + (cfg.flights.cache_ttl_hours + 48) * 3_600_000);
    const out = await searchWithCap(db, cfg, source, WINDOW, { now: later });
    expect(out.cached).toBe(true);
    expect(out.value.cheapest?.priceUsd).toBe(968);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(serpapiSearchesThisMonth(db, NOW)).toBe(cfg.flights.monthly_search_cap);
  });

  it('throws a cap-specific error when the cap is reached and nothing is cached', async () => {
    const { source, fetch } = stubbed();
    kvSet(db, 'serpapi:searches:2026-09', String(cfg.flights.monthly_search_cap));
    await expect(searchWithCap(db, cfg, source, WINDOW, { now: NOW })).rejects.toThrow(
      /monthly search cap reached/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('searchFlights carries the configured ttl into the cache row', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(FIXTURE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    process.env.SERPAPI_KEY = 'test-key-not-real';
    try {
      const out = await searchFlights(db, cfg, WINDOW, { now: NOW });
      expect(out.cached).toBe(false);
      expect(out.value.cheapest?.priceUsd).toBe(968);
      const url = String(spy.mock.calls[0]?.[0]);
      expect(url).toContain('engine=google_flights');
      expect(url).toContain('departure_id=LAX');
      expect(url).toContain('currency=USD');
      expect(url).toContain('type=1');
      const row = db
        .prepare('SELECT expires_at, fetched_at FROM source_cache WHERE namespace = ?')
        .get('serpapi:flights') as { expires_at: string; fetched_at: string };
      const hours =
        (Date.parse(row.expires_at + 'Z') - Date.parse(row.fetched_at + 'Z')) / 3_600_000;
      expect(hours).toBe(cfg.flights.cache_ttl_hours);
    } finally {
      spy.mockRestore();
      delete process.env.SERPAPI_KEY;
    }
  });

  it('refuses to search without SERPAPI_KEY', async () => {
    delete process.env.SERPAPI_KEY;
    await expect(cached(db, flights, WINDOW)).rejects.toThrow(/SERPAPI_KEY/);
  });
});

describe('searchFlightsFlex', () => {
  /** Price varies with the departure date so the winner is deterministic. */
  function priceByDate(prices: Record<string, number | null>) {
    return vi.fn(
      async (p: {
        origin: string;
        dest: string;
        depart: string;
        return: string;
      }): Promise<FlightSearch> => {
        const price = prices[p.depart];
        if (price === undefined) throw new Error(`upstream 500 for ${p.depart}`);
        const raw: RawFlightsResponse =
          price === null ? {} : { best_flights: [{ ...FIXTURE.best_flights![0]!, price }] };
        return parseFlights(raw, p, NOW.toISOString());
      },
    );
  }

  it('flex 0 does exactly one search — what a watch re-check wants', async () => {
    const fetch = priceByDate({ '2027-02-06': 1000 });
    vi.spyOn(flights, 'fetch').mockImplementation(fetch);
    try {
      const out = await searchFlightsFlex(db, cfg, WINDOW, 0, { now: NOW });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(out.offsetDays).toBe(0);
      expect(out.cheapest.priceUsd).toBe(1000);
      expect(out.attempts).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns the cheapest window and reports every attempt', async () => {
    const fetch = priceByDate({
      '2027-02-04': 1100,
      '2027-02-05': 900,
      '2027-02-06': 1000,
      '2027-02-07': null,
    });
    vi.spyOn(flights, 'fetch').mockImplementation(fetch);
    try {
      const out = await searchFlightsFlex(db, cfg, WINDOW, 2, { now: NOW });
      expect(out.depart).toBe('2027-02-05');
      expect(out.return).toBe('2027-02-15');
      expect(out.offsetDays).toBe(-1);
      expect(out.cheapest.priceUsd).toBe(900);
      expect(out.search.origin).toBe('LAX');
      expect(out.attempts.map((a) => [a.offsetDays, a.priceUsd])).toEqual([
        [-1, 900],
        [0, 1000],
        [-2, 1100],
        [1, null],
        [2, null],
      ]);
      // Four windows answered (one empty, one threw) => four live searches counted.
      expect(serpapiSearchesThisMonth(db, NOW)).toBe(4);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('throws only when every window fails', async () => {
    vi.spyOn(flights, 'fetch').mockImplementation(priceByDate({}));
    try {
      await expect(searchFlightsFlex(db, cfg, WINDOW, 1, { now: NOW })).rejects.toThrow(
        /no flight quotes/,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
