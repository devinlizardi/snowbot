import { describe, expect, it } from 'vitest';
import { loadConfig, type Destination } from '../src/config.js';
import {
  hubFor,
  originsToPrice,
  solveRouting,
  spreadHours,
  type RoutingQuotes,
} from '../src/routing.js';
import type { FlightQuote, FlightSearch } from '../src/sources/flights.js';

const cfg = loadConfig({ env: {} });
const members = cfg.members;
const niseko: Destination = cfg.board.find((d) => d.id === 'niseko')!;
const OPTS = { arrivalWindowHours: cfg.expedition.arrival_window_hours };

const WINDOW = { depart: '2027-02-06', return: '2027-02-16' };

function quote(priceUsd: number, arriveAt = '2027-02-07 21:05'): FlightQuote {
  return {
    priceUsd,
    airlines: ['ANA'],
    stops: 1,
    durationMin: 910,
    departAt: '2027-02-06 12:55',
    arriveAt,
    legs: [],
    source: 'serpapi',
  };
}

function search(origin: string, priceUsd: number, arriveAt?: string): FlightSearch {
  const q = quote(priceUsd, arriveAt);
  return {
    origin,
    dest: 'CTS',
    ...WINDOW,
    quotes: [q],
    cheapest: q,
    best: q,
    searchedAt: '2026-09-14T12:00:00Z',
  };
}

/** Quotes for every origin the roster needs, as { IATA: price } or { IATA: [price, arriveAt] }. */
function quotes(spec: Record<string, number | [number, string] | null>): RoutingQuotes {
  const out: RoutingQuotes = {};
  for (const [origin, v] of Object.entries(spec)) {
    out[origin] =
      v === null ? null : Array.isArray(v) ? search(origin, v[0], v[1]) : search(origin, v);
  }
  return out;
}

const route = (
  r: ReturnType<typeof solveRouting>,
  strategy: 'independent' | 'consolidateWest',
  name: string,
) => r[strategy].perMember.find((m) => m.member === name)!;

describe('roster helpers', () => {
  it('maps every California airport to its hub and leaves the East Coast alone', () => {
    const by = Object.fromEntries(members.map((m) => [m.name, hubFor(m)]));
    expect(by).toEqual({ Devin: null, Andre: null, Elliot: 'LAX', Jeremy: 'LAX', Hagen: 'SFO' });
  });

  it('prices each member’s airports plus the hubs', () => {
    expect(originsToPrice(members).sort()).toEqual(['BUR', 'EWR', 'JFK', 'LAX', 'SFO', 'SNA']);
  });

  it('measures arrival spread in hours from local wall-clock strings', () => {
    expect(spreadHours(['2027-02-07 21:05', '2027-02-07 17:35', null])).toBe(3.5);
    expect(spreadHours(['2027-02-07 21:05', ''])).toBeNull();
    expect(spreadHours(['2027-02-07 21:05', '2027-02-08 03:05'])).toBe(6);
  });
});

describe('solveRouting', () => {
  const cases: {
    name: string;
    quotes: RoutingQuotes;
    recommended: 'independent' | 'consolidate-west';
    check?: (r: ReturnType<typeof solveRouting>) => void;
  }[] = [
    {
      name: 'consolidates at LAX when BUR and SNA are >$150 worse',
      quotes: quotes({ JFK: 698, EWR: 698, BUR: 684, SNA: 698, LAX: 511, SFO: 540 }),
      recommended: 'consolidate-west',
      check: (r) => {
        // Independent already sends both drivers to LAX, so the totals tie;
        // consolidation still wins because it puts them on one itinerary.
        expect(r.consolidateWest.groupTotalUsd).toBe(698 + 698 + 551 + 551 + 540);
        expect(r.independent.groupTotalUsd).toBe(698 + 698 + 551 + 551 + 540);
        expect(route(r, 'consolidateWest', 'Elliot')).toMatchObject({
          origin: 'LAX',
          priceUsd: 511,
          positioningUsd: 40,
          allInUsd: 551,
          delta: { vs: 'BUR', usd: 173 },
        });
        expect(route(r, 'consolidateWest', 'Elliot').note).toMatch(/estimate: gas or rideshare/);
        expect(route(r, 'consolidateWest', 'Hagen')).toMatchObject({
          origin: 'SFO',
          positioningUsd: 0,
        });
        expect(r.reason).toMatch(/Elliot, Jeremy/);
      },
    },
    {
      name: 'stays independent when the hub is within $50 of home',
      quotes: quotes({ JFK: 698, EWR: 698, BUR: 530, SNA: 540, LAX: 511, SFO: 540 }),
      recommended: 'independent',
      check: (r) => {
        // LAX is $19 cheaper on paper but $21 dearer once the drive is counted.
        expect(route(r, 'independent', 'Elliot')).toMatchObject({
          origin: 'BUR',
          allInUsd: 530,
          delta: { vs: 'LAX', usd: -19 },
        });
        expect(route(r, 'consolidateWest', 'Elliot').delta).toEqual({ vs: 'BUR', usd: 19 });
        expect(r.consolidateWest.groupTotalUsd).toBeGreaterThan(r.independent.groupTotalUsd);
        expect(r.deltaLines).toContain(
          'Elliot: BUR $530 / LAX $511 — LAX is only $19 cheaper, figure ~$40 to get to LAX — fly from BUR',
        );
      },
    },
    {
      name: 'flips to consolidation when independent arrivals miss the window',
      quotes: quotes({
        JFK: [698, '2027-02-07 20:30'],
        EWR: [698, '2027-02-07 20:30'],
        BUR: [520, '2027-02-08 06:10'],
        SNA: [525, '2027-02-08 06:10'],
        LAX: [511, '2027-02-07 21:05'],
        SFO: [540, '2027-02-07 22:00'],
      }),
      recommended: 'consolidate-west',
      check: (r) => {
        expect(r.independent.arrivalSpreadHours).toBeGreaterThan(OPTS.arrivalWindowHours);
        expect(r.independent.feasible).toBe(false);
        expect(r.consolidateWest.arrivalSpreadHours).toBe(1.5);
        expect(r.consolidateWest.feasible).toBe(true);
        expect(r.reason).toMatch(/spreads arrivals/);
      },
    },
    {
      name: 'falls back to the other priced airport when one search is empty',
      quotes: quotes({ JFK: 698, EWR: 698, BUR: null, SNA: 700, LAX: 640, SFO: 540 }),
      recommended: 'independent',
      check: (r) => {
        const elliot = route(r, 'independent', 'Elliot');
        expect(elliot.origin).toBe('LAX');
        expect(elliot.unpriced).toBe(false);
        expect(elliot.note).toMatch(/no fare from BUR/);
        expect(r.independent.unpriced).toEqual([]);
        expect(r.deltaLines).toContain('Elliot: BUR n/a / LAX $640 — no BUR fare, fly from LAX');
      },
    },
    {
      name: 'flags a member unpriced when nothing of theirs came back',
      quotes: quotes({ JFK: 698, EWR: 698, BUR: 684, SNA: 698, LAX: 511 }),
      recommended: 'consolidate-west',
      check: (r) => {
        for (const s of ['independent', 'consolidateWest'] as const) {
          const hagen = route(r, s, 'Hagen');
          expect(hagen.unpriced).toBe(true);
          expect(hagen.origin).toBe('SFO');
          expect(hagen.allInUsd).toBeNull();
          expect(r[s].unpriced).toEqual(['Hagen']);
        }
        // Group total excludes the unpriced member rather than pretending.
        expect(r.independent.groupTotalUsd).toBe(698 + 698 + 551 + 551);
        expect(r.independent.perPersonAvgUsd).toBe(Math.round((698 + 698 + 551 + 551) / 4));
      },
    },
    {
      name: 'does not consolidate when the hub search itself failed',
      quotes: quotes({ JFK: 698, EWR: 698, BUR: 684, SNA: 698, LAX: null, SFO: 540 }),
      recommended: 'independent',
      check: (r) => {
        expect(route(r, 'consolidateWest', 'Elliot')).toMatchObject({
          origin: 'BUR',
          priceUsd: 684,
        });
        expect(route(r, 'consolidateWest', 'Elliot').note).toMatch(/no LAX fare/);
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = solveRouting(members, niseko, c.quotes, OPTS);
      expect(r.recommended).toBe(c.recommended);
      expect(r.reason.length).toBeGreaterThan(10);
      c.check?.(r);
    });
  }

  it('always states the per-member delta, whichever way the call goes', () => {
    const win = solveRouting(
      members,
      niseko,
      quotes({ JFK: 698, EWR: 698, BUR: 684, SNA: 698, LAX: 511, SFO: 540 }),
      OPTS,
    );
    expect(win.deltaLines).toEqual([
      'Elliot: BUR $684 / LAX $511 — worth the drive ($173 cheaper, figure ~$40 to get to LAX)',
      'Jeremy: SNA $698 / LAX $511 — worth the drive ($187 cheaper, figure ~$40 to get to LAX)',
    ]);
    const tie = solveRouting(
      members,
      niseko,
      quotes({ JFK: 698, EWR: 698, BUR: 500, SNA: 500, LAX: 500, SFO: 540 }),
      OPTS,
    );
    expect(tie.deltaLines[0]).toBe('Elliot: BUR $500 / LAX $500 — same price, fly from BUR');
    const lose = solveRouting(
      members,
      niseko,
      quotes({ JFK: 698, EWR: 698, BUR: 480, SNA: 500, LAX: 500, SFO: 540 }),
      OPTS,
    );
    expect(lose.deltaLines[0]).toBe('Elliot: BUR $480 / LAX $500 — fly from BUR (LAX is $20 more)');
  });

  it('honours a custom threshold and positioning table', () => {
    const q = quotes({ JFK: 698, EWR: 698, BUR: 600, SNA: 600, LAX: 511, SFO: 540 });
    const strict = solveRouting(members, niseko, q, { ...OPTS, driveDeltaThresholdUsd: 100 });
    expect(strict.recommended).toBe('independent');
    const free = solveRouting(members, niseko, q, {
      ...OPTS,
      driveDeltaThresholdUsd: 80,
      positioningUsd: { 'BUR->LAX': 0, 'SNA->LAX': 0 },
    });
    expect(free.recommended).toBe('consolidate-west');
    expect(route(free, 'consolidateWest', 'Elliot').delta).toEqual({ vs: 'BUR', usd: 89 });
  });
});
