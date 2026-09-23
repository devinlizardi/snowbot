import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { searchWithCap } from '../src/sources/_serpapi.js';
import {
  lodging,
  lodgingQuery,
  mergeLodging,
  nightsBetween,
  parseBedrooms,
  parseHighlights,
  parseLodging,
  parseSleeps,
  pickLodging,
  searchLodging,
  searchUrl,
  serpapiSearchesThisMonth,
  shortlistLodging,
  type LodgingOption,
  type RawHotelsResponse,
} from '../src/sources/lodging.js';

/** Shaped like a real google_hotels response for "Niseko United ski", 10 nights, 5 adults. */
const HOTELS: RawHotelsResponse = {
  search_metadata: { created_at: '2026-09-14 12:00:00 UTC' },
  properties: [
    {
      type: 'vacation rental',
      name: 'Hirafu Pine Chalet — 4BR, walk to lifts',
      link: 'https://www.google.com/travel/hotels/entity/fixture-1',
      rate_per_night: { lowest: '$412', extracted_lowest: 412 },
      total_rate: { lowest: '$4,120', extracted_lowest: 4120 },
      overall_rating: 4.7,
      reviews: 38,
      essential_info: ['Entire chalet', 'Sleeps 8', '4 bedrooms', '2 bathrooms'],
      amenities: ['Kitchen', 'Wi-Fi', 'Free parking'],
    },
    {
      type: 'vacation rental',
      name: 'Studio near Grand Hirafu gondola',
      link: 'https://www.google.com/travel/hotels/entity/fixture-2',
      rate_per_night: { lowest: '$140', extracted_lowest: 140 },
      total_rate: { lowest: '$1,400', extracted_lowest: 1400 },
      overall_rating: 4.9,
      reviews: 12,
      essential_info: ['Entire apartment', 'Sleeps 2', '1 bedroom'],
    },
    {
      type: 'hotel',
      name: "Niseko Northern Resort An'nupuri",
      link: 'https://www.google.com/travel/hotels/entity/fixture-3',
      rate_per_night: { lowest: '$298', extracted_lowest: 298 },
      total_rate: { lowest: '$2,980', extracted_lowest: 2980 },
      overall_rating: 4.3,
      reviews: 1211,
      amenities: ['Onsen', 'Breakfast', 'Ski storage'],
    },
    {
      type: 'vacation rental',
      name: 'Yotei View House',
      rate_per_night: { lowest: '$355', extracted_lowest: 355 },
      overall_rating: 4.5,
      reviews: 61,
      amenities: ['Sleeps 6 guests', 'Hot tub'],
    },
    {
      type: 'hotel',
      name: 'Hotel with no price yet',
      overall_rating: 4.1,
      reviews: 200,
    },
    {
      type: 'hotel',
      name: 'Hirafu Budget Lodge',
      rate_per_night: { lowest: '$120', extracted_lowest: 120 },
      total_rate: { lowest: '$1,200', extracted_lowest: 1200 },
      overall_rating: 3.6,
      reviews: 540,
      amenities: ['Shared kitchen'],
    },
    {
      type: 'hotel',
      name: 'Skye Niseko',
      rate_per_night: { lowest: '$690', extracted_lowest: 690 },
      total_rate: { lowest: '$6,900', extracted_lowest: 6900 },
      overall_rating: 4.8,
      reviews: 903,
    },
  ],
};

const PARAMS = {
  resort: 'Niseko United',
  checkIn: '2027-02-06',
  checkOut: '2027-02-16',
  minSleeps: 5,
};
const NOW = new Date('2026-09-14T12:00:00Z');

let db: DB;
let cfg: Config;
beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({ env: {} });
});

describe('parseLodging', () => {
  const out = parseLodging(HOTELS, PARAMS, NOW.toISOString());

  it('drops listings that sleep fewer than the group and listings without a price', () => {
    const names = out.options.map((o) => o.name);
    expect(names).not.toContain('Studio near Grand Hirafu gondola');
    expect(names).not.toContain('Hotel with no price yet');
    expect(names).toHaveLength(5);
  });

  it('prices a hotel as enough rooms for the group and sorts by the group total', () => {
    // Five people at two a room is three rooms: Budget Lodge 1200 × 3, An'nupuri 2980 × 3, Skye 6900 × 3.
    expect(out.options.map((o) => o.totalUsd)).toEqual([3550, 3600, 4120, 8940, 20700]);
    const lodge = out.options.find((o) => o.name === 'Hirafu Budget Lodge')!;
    expect(lodge).toMatchObject({ units: 3, unitTotalUsd: 1200, perPersonPerNightUsd: 72 });
    const house = out.options.find((o) => o.name === 'Yotei View House')!;
    expect(house).toMatchObject({ units: 1, unitTotalUsd: 3550 });
  });

  it('honours a different room assumption', () => {
    const quads = parseLodging(HOTELS, { ...PARAMS, guestsPerRoom: 4 }, 'x');
    expect(quads.options.find((o) => o.name === 'Hirafu Budget Lodge')).toMatchObject({
      units: 2,
      totalUsd: 2400,
    });
  });

  it('pulls out bedrooms, the highlights worth selling, and a link for every listing', () => {
    const chalet = out.options.find((o) => o.name.startsWith('Hirafu Pine'))!;
    expect(chalet.bedrooms).toBe(4);
    expect(chalet.highlights).toEqual(['kitchen']);
    expect(chalet.url).toBe(chalet.link);
    const annupuri = out.options.find((o) => o.name.startsWith('Niseko Northern'))!;
    expect(annupuri.highlights).toEqual(['onsen', 'breakfast']);
    const yotei = out.options.find((o) => o.name === 'Yotei View House')!;
    expect(yotei.highlights).toEqual(['hot tub']);
    expect(yotei.url).toBe('https://www.google.com/search?q=Yotei%20View%20House%20Niseko%20United');
  });

  it('derives the total from the nightly rate when Google omits it', () => {
    const yotei = out.options.find((o) => o.name === 'Yotei View House')!;
    expect(yotei.totalUsd).toBe(3550);
    expect(yotei.perNightUsd).toBe(355);
    expect(yotei.sleeps).toBe(6);
    expect(yotei.link).toBeNull();
  });

  it('computes per-person-per-night over min_sleeps, not over the listed sleeps', () => {
    const chalet = out.options.find((o) => o.name.startsWith('Hirafu Pine'))!;
    expect(chalet.type).toBe('vacation_rental');
    expect(chalet.sleeps).toBe(8);
    expect(chalet.perPersonPerNightUsd).toBe(82.4); // 4120 / 10 / 5
  });

  it('picks the best rated among the cheapest third, not the cheapest', () => {
    // Cheapest third of five = three: Yotei 4.5, Budget Lodge (3 rooms) 3.6, the chalet 4.7.
    expect(out.pick?.name).toBe('Hirafu Pine Chalet — 4BR, walk to lifts');
    expect(out.query).toBe('Niseko United ski');
    expect(out.checkIn).toBe('2027-02-06');
  });

  it('shortlists the pick, the cheapest, and the nicest within twice the pick', () => {
    expect(out.shortlist.map((o) => [o.role, o.name])).toEqual([
      ['pick', 'Hirafu Pine Chalet — 4BR, walk to lifts'],
      ['cheapest', 'Yotei View House'],
      // Skye (4.8) is over twice the pick; An'nupuri (4.3) is rated below it, so the
      // third slot is the next cheapest rather than a "splurge" that isn't one.
      ['alternative', 'Hirafu Budget Lodge'],
    ]);
  });

  it('handles an empty response', () => {
    const empty = parseLodging({}, PARAMS, 'x');
    expect(empty.options).toEqual([]);
    expect(empty.pick).toBeNull();
    expect(empty.shortlist).toEqual([]);
  });
});

describe('shortlistLodging / mergeLodging', () => {
  const mk = (name: string, totalUsd: number, rating: number | null): LodgingOption => ({
    name,
    type: 'vacation_rental',
    totalUsd,
    unitTotalUsd: totalUsd,
    units: 1,
    perNightUsd: totalUsd / 5,
    perPersonPerNightUsd: totalUsd / 25,
    rating,
    reviews: 10,
    sleeps: 6,
    bedrooms: 3,
    highlights: [],
    link: null,
    url: `https://example.test/${name}`,
    source: 'serpapi',
  });

  it('labels a better-rated option within reach as the splurge', () => {
    const sorted = [mk('cheap', 900, 4.0), mk('pick', 1000, 4.5), mk('nice', 1800, 4.9)];
    expect(shortlistLodging(sorted, sorted[1]!).map((o) => o.role)).toEqual([
      'pick',
      'cheapest',
      'nicest',
    ]);
  });

  it('merges hotels and rentals, dropping a listing that came back from both', () => {
    const a = { ...parseLodging(HOTELS, PARAMS, '2026-09-14T10:00:00Z') };
    const b = {
      ...parseLodging(
        {
          properties: [
            HOTELS.properties![0]!,
            {
              type: 'vacation rental',
              name: 'Annupuri Lodge House',
              total_rate: { extracted_lowest: 3000 },
              essential_info: ['Sleeps 6', '3 bedrooms'],
            },
          ],
        },
        PARAMS,
        '2026-09-14T11:00:00Z',
      ),
    };
    const m = mergeLodging(a, b)!;
    expect(m.options.filter((o) => o.name.startsWith('Hirafu Pine'))).toHaveLength(1);
    expect(m.options[0]!.name).toBe('Annupuri Lodge House');
    expect(m.searchedAt).toBe('2026-09-14T11:00:00Z');
    expect(m.query).toBe('Niseko United ski');
    expect(mergeLodging(null, b)).toBe(b);
  });
});

describe('helpers', () => {
  it.each([
    [['Entire house', 'Sleeps 8'], 8],
    [['sleeps 12 guests'], 12],
    [['Kitchen', 'Wi-Fi'], null],
    [[], null],
  ])('parseSleeps(%j) -> %s', (lines, want) => {
    expect(parseSleeps(lines)).toBe(want);
  });

  it('counts nights and rejects a zero-night stay', () => {
    expect(nightsBetween('2027-01-24', '2027-01-30')).toBe(6);
    expect(() => nightsBetween('2027-01-24', '2027-01-24')).toThrow(/bad stay/);
  });

  it('breaks rating ties on review count', () => {
    const mk = (
      name: string,
      totalUsd: number,
      rating: number,
      reviews: number,
    ): LodgingOption => ({
      name,
      type: 'hotel',
      totalUsd,
      unitTotalUsd: totalUsd,
      units: 1,
      perNightUsd: totalUsd / 5,
      perPersonPerNightUsd: totalUsd / 25,
      rating,
      reviews,
      sleeps: null,
      bedrooms: null,
      highlights: [],
      link: null,
      url: 'https://example.test',
      source: 'serpapi',
    });
    const pick = pickLodging([
      mk('a', 100, 4.5, 3),
      mk('b', 110, 4.5, 400),
      mk('c', 120, 4.0, 900),
    ]);
    expect(pick?.name).toBe('b');
    expect(pickLodging([])).toBeNull();
  });

  it('parses bedrooms and highlights from the listing text', () => {
    expect(parseBedrooms(['Entire house', '3 bedrooms'])).toBe(3);
    expect(parseBedrooms(['4BR chalet'])).toBe(4);
    expect(parseBedrooms(['Kitchen'])).toBeNull();
    expect(parseHighlights(['Ski-in/ski-out', 'Private onsen', 'Jacuzzi'])).toEqual([
      'ski-in/ski-out',
      'onsen',
      'hot tub',
    ]);
  });

  it('builds a search link that names the resort once', () => {
    expect(searchUrl('Skye Niseko', 'Niseko')).toBe('https://www.google.com/search?q=Skye%20Niseko');
    expect(searchUrl('The Lodge', 'Revelstoke')).toBe(
      'https://www.google.com/search?q=The%20Lodge%20Revelstoke',
    );
  });

  it('keys on the query, dates, group size, kind and room assumption', () => {
    expect(lodgingQuery('Revelstoke')).toBe('Revelstoke ski');
    expect(lodging.key(PARAMS)).toBe('Niseko United ski:2027-02-06:2027-02-16:5:hotels:g2:v2');
    expect(lodging.key({ ...PARAMS, kind: 'rentals' })).toBe(
      'Niseko United ski:2027-02-06:2027-02-16:5:rentals:g2:v2',
    );
    expect(lodging.ttlMinutes({ ...PARAMS, ttlHours: 144 })).toBe(8640);
  });
});

describe('searchLodging', () => {
  it('keeps the hotels when the rentals search fails', async () => {
    let n = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n += 1;
      return n === 1
        ? new Response(JSON.stringify(HOTELS), { status: 200 })
        : new Response(JSON.stringify({ error: 'rentals unavailable' }), { status: 500 });
    });
    process.env.SERPAPI_KEY = 'test-key-not-real';
    try {
      const out = await searchLodging(db, cfg, PARAMS, { now: NOW });
      expect(out.value.options).toHaveLength(5);
    } finally {
      spy.mockRestore();
      delete process.env.SERPAPI_KEY;
    }
  });

  it('goes through the shared serpapi counter and config', async () => {
    const fetch = vi.fn(async (p: typeof PARAMS) => parseLodging(HOTELS, p, NOW.toISOString()));
    const out = await searchWithCap(db, cfg, { ...lodging, fetch }, PARAMS, { now: NOW });
    expect(out.cached).toBe(false);
    expect(serpapiSearchesThisMonth(db, NOW)).toBe(1);
  });

  it('sends adults=min_sleeps, USD and price sort', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(HOTELS), { status: 200 }));
    process.env.SERPAPI_KEY = 'test-key-not-real';
    try {
      const out = await searchLodging(db, cfg, PARAMS, { now: NOW });
      expect(out.value.pick?.name).toBe('Hirafu Pine Chalet — 4BR, walk to lifts');
      const url = String(spy.mock.calls[0]?.[0]);
      expect(url).toContain('engine=google_hotels');
      expect(url).toContain('q=Niseko+United+ski');
      expect(url).toContain(`adults=${cfg.lodging.min_sleeps}`);
      expect(url).toContain('sort_by=3');
      expect(url).toContain('currency=USD');
      expect(url).not.toContain('vacation_rentals');
      // The second search is the rentals one, against the same monthly counter.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(String(spy.mock.calls[1]?.[0])).toContain('vacation_rentals=true');
      expect(serpapiSearchesThisMonth(db, NOW)).toBe(2);
    } finally {
      spy.mockRestore();
      delete process.env.SERPAPI_KEY;
    }
  });

  it('surfaces a serpapi error body instead of a cryptic parse failure', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 401 }),
      );
    process.env.SERPAPI_KEY = 'test-key-not-real';
    try {
      await expect(searchLodging(db, cfg, PARAMS, { now: NOW })).rejects.toThrow(
        /hotels: .*serpapi google_hotels 401: Invalid API key/,
      );
      expect(serpapiSearchesThisMonth(db, NOW)).toBe(0);
    } finally {
      spy.mockRestore();
      delete process.env.SERPAPI_KEY;
    }
  });
});
