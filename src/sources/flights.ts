import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { GetOptions } from './_cache.js';
import { searchWithCap, serpapiGet } from './_serpapi.js';
import type { Source } from './types.js';

export { searchCapReached, serpapiSearchesThisMonth } from './_serpapi.js';

export type FlightParams = {
  origin: string;
  dest: string;
  /** YYYY-MM-DD */
  depart: string;
  /** YYYY-MM-DD */
  return: string;
  /** Hours; comes from `cfg.flights.cache_ttl_hours`. */
  ttlHours?: number;
};

export type FlightLeg = {
  from: string;
  to: string;
  flightNumber: string;
  departAt: string;
  arriveAt: string;
};

export type FlightQuote = {
  /** Round-trip price for one adult. */
  priceUsd: number;
  airlines: string[];
  stops: number;
  durationMin: number;
  departAt: string;
  arriveAt: string;
  legs: FlightLeg[];
  source: 'serpapi';
};

export type FlightSearch = {
  origin: string;
  dest: string;
  depart: string;
  return: string;
  /** Sorted by price, cheapest first. */
  quotes: FlightQuote[];
  cheapest: FlightQuote | null;
  /** Google's own top pick — usually a price/duration compromise. */
  best: FlightQuote | null;
  searchedAt: string;
};

/* ------------------------------------------------------------------ parse */

type RawAirport = { id?: string; name?: string; time?: string };
type RawLeg = {
  departure_airport?: RawAirport;
  arrival_airport?: RawAirport;
  duration?: number;
  airline?: string;
  flight_number?: string;
};
export type RawItinerary = {
  flights?: RawLeg[];
  layovers?: { duration?: number; id?: string }[];
  total_duration?: number;
  price?: number;
};
export type RawFlightsResponse = {
  best_flights?: RawItinerary[];
  other_flights?: RawItinerary[];
  search_metadata?: { created_at?: string };
};

/**
 * SerpApi's round-trip search returns the *outbound* itinerary with the
 * round-trip price; the return legs live behind a `departure_token` and cost a
 * second search each. For a "what does it cost to get there" number the
 * outbound plus total price is what we want, so we don't spend the extra call.
 */
export function parseFlights(
  json: RawFlightsResponse,
  params: Pick<FlightParams, 'origin' | 'dest' | 'depart' | 'return'>,
  searchedAt: string,
): FlightSearch {
  const best = (json.best_flights ?? []).map(parseItinerary).filter(isQuote);
  const other = (json.other_flights ?? []).map(parseItinerary).filter(isQuote);
  const quotes = [...best, ...other].sort((a, b) => a.priceUsd - b.priceUsd);
  return {
    origin: params.origin,
    dest: params.dest,
    depart: params.depart,
    return: params.return,
    quotes,
    cheapest: quotes[0] ?? null,
    best: best[0] ?? null,
    searchedAt,
  };
}

function isQuote(q: FlightQuote | null): q is FlightQuote {
  return q !== null;
}

function parseItinerary(raw: RawItinerary): FlightQuote | null {
  const legs: FlightLeg[] = [];
  for (const l of raw.flights ?? []) {
    const from = l.departure_airport?.id;
    const to = l.arrival_airport?.id;
    if (!from || !to) continue;
    legs.push({
      from,
      to,
      flightNumber: l.flight_number ?? '',
      departAt: l.departure_airport?.time ?? '',
      arriveAt: l.arrival_airport?.time ?? '',
    });
  }
  const first = legs[0];
  const last = legs[legs.length - 1];
  // A quote without a price or without legs can't be booked or compared.
  if (typeof raw.price !== 'number' || !first || !last) return null;

  const airlines = [
    ...new Set((raw.flights ?? []).map((l) => l.airline).filter((a): a is string => !!a)),
  ];
  const durationMin =
    typeof raw.total_duration === 'number'
      ? raw.total_duration
      : (raw.flights ?? []).reduce((s, l) => s + (l.duration ?? 0), 0) +
        (raw.layovers ?? []).reduce((s, l) => s + (l.duration ?? 0), 0);

  return {
    priceUsd: raw.price,
    airlines,
    stops: legs.length - 1,
    durationMin,
    departAt: first.departAt,
    arriveAt: last.arriveAt,
    legs,
    source: 'serpapi',
  };
}

/* ----------------------------------------------------------------- source */

export const flights: Source<FlightParams, FlightSearch> = {
  name: 'serpapi:flights',
  key: (p) => `${p.origin}-${p.dest}:${p.depart}:${p.return}`,
  ttlMinutes: (p) => (p.ttlHours ?? 144) * 60,
  fetch: async (p) => {
    const json = (await serpapiGet('google_flights', {
      departure_id: p.origin,
      arrival_id: p.dest,
      outbound_date: p.depart,
      return_date: p.return,
      currency: 'USD',
      hl: 'en',
      type: 1,
    })) as RawFlightsResponse;
    return parseFlights(json, p, new Date().toISOString());
  },
};

export type FlightWindow = { origin: string; dest: string; depart: string; return: string };

/** The quota-aware entry point jobs should use instead of `cached(flights, …)`. */
export function searchFlights(db: DB, cfg: Config, params: FlightWindow, opts: GetOptions = {}) {
  return searchWithCap(
    db,
    cfg,
    flights,
    { ...params, ttlHours: cfg.flights.cache_ttl_hours },
    opts,
  );
}

/* ------------------------------------------------------------------- flex */

/** Shift both ends of the trip by the same offset, so every candidate keeps
 *  the trip length the group agreed to; offsets run -flex..+flex. */
export function flexWindows(
  depart: string,
  ret: string,
  flexDays: number,
): { depart: string; return: string; offsetDays: number }[] {
  const out: { depart: string; return: string; offsetDays: number }[] = [];
  // `0 - flex` rather than `-flex`: a flex of 0 must not yield -0.
  for (let d = 0 - flexDays; d <= flexDays; d++) {
    out.push({ depart: shiftDate(depart, d), return: shiftDate(ret, d), offsetDays: d });
  }
  return out;
}

export function shiftDate(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`bad date ${iso}`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export type FlexResult = {
  /** The winning search, with the dates that won. */
  search: FlightSearch;
  depart: string;
  return: string;
  offsetDays: number;
  cheapest: FlightQuote;
  /** Every window tried, cheapest-first; null price = no quote or search failed. */
  attempts: { depart: string; return: string; offsetDays: number; priceUsd: number | null }[];
};

/**
 * Search every ±flex window and return the cheapest. One window failing (cap
 * hit, upstream error) shouldn't sink the others, so failures are recorded as
 * null and only a total wipe-out throws. Flex 0 is a single plain search —
 * what a watch re-check wants.
 */
export async function searchFlightsFlex(
  db: DB,
  cfg: Config,
  params: FlightWindow,
  flexDays: number,
  opts: GetOptions = {},
): Promise<FlexResult> {
  const attempts: FlexResult['attempts'] = [];
  let winner: Omit<FlexResult, 'attempts'> | null = null;
  const errors: string[] = [];

  for (const w of flexWindows(params.depart, params.return, flexDays)) {
    let search: FlightSearch | null = null;
    try {
      search = (
        await searchFlights(db, cfg, { ...params, depart: w.depart, return: w.return }, opts)
      ).value;
    } catch (err) {
      errors.push(String(err));
    }
    const cheapest = search?.cheapest ?? null;
    attempts.push({ ...w, priceUsd: cheapest?.priceUsd ?? null });
    if (search && cheapest && (!winner || cheapest.priceUsd < winner.cheapest.priceUsd)) {
      winner = { search, depart: w.depart, return: w.return, offsetDays: w.offsetDays, cheapest };
    }
  }
  if (!winner) {
    throw new Error(
      `no flight quotes for ${params.origin}-${params.dest} around ${params.depart}` +
        (errors.length ? `: ${errors[0]}` : ''),
    );
  }
  attempts.sort((a, b) => (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity));
  return { ...winner, attempts };
}
