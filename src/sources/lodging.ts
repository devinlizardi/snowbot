import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { GetOptions } from './_cache.js';
import { searchWithCap, serpapiGet } from './_serpapi.js';
import type { Source } from './types.js';

export { searchCapReached, serpapiSearchesThisMonth } from './_serpapi.js';

export type LodgingParams = {
  /** Resort name as written on the board; " ski" is appended for Google. */
  resort: string;
  /** YYYY-MM-DD */
  checkIn: string;
  /** YYYY-MM-DD */
  checkOut: string;
  /** Group size; also the sleeps floor for filtering. */
  minSleeps: number;
  ttlHours?: number;
};

export type LodgingType = 'hotel' | 'vacation_rental' | 'other';

export type LodgingOption = {
  name: string;
  type: LodgingType;
  /** Whole stay, whole property (or one room), taxes included where Google shows them. */
  totalUsd: number;
  perNightUsd: number;
  /** totalUsd ÷ nights ÷ minSleeps — the number that goes in the dossier. */
  perPersonPerNightUsd: number;
  rating: number | null;
  reviews: number | null;
  /** Parsed from "Sleeps N"; null when the listing doesn't say (hotels never do). */
  sleeps: number | null;
  link: string | null;
  source: 'serpapi';
};

export type LodgingSearch = {
  query: string;
  checkIn: string;
  checkOut: string;
  /** Sorted by total, cheapest first; already filtered to sleeps ≥ minSleeps or unknown. */
  options: LodgingOption[];
  /** Best rated among the cheapest third — cheap but not the place with the bedbug reviews. */
  pick: LodgingOption | null;
  searchedAt: string;
};

/* ------------------------------------------------------------------ parse */

type RawRate = { extracted_lowest?: number; lowest?: string };
export type RawProperty = {
  type?: string;
  name?: string;
  link?: string;
  rate_per_night?: RawRate;
  total_rate?: RawRate;
  overall_rating?: number;
  reviews?: number;
  essential_info?: string[];
  amenities?: string[];
};
export type RawHotelsResponse = {
  properties?: RawProperty[];
  search_metadata?: { created_at?: string };
};

export function lodgingQuery(resort: string): string {
  return `${resort} ski`;
}

export function parseLodging(
  json: RawHotelsResponse,
  params: Pick<LodgingParams, 'resort' | 'checkIn' | 'checkOut' | 'minSleeps'>,
  searchedAt: string,
): LodgingSearch {
  const nights = nightsBetween(params.checkIn, params.checkOut);
  const options = (json.properties ?? [])
    .map((p) => parseProperty(p, nights, params.minSleeps))
    .filter((o): o is LodgingOption => o !== null)
    // A listing that says it sleeps 3 is out; one that doesn't say (every
    // hotel) stays in, because two rooms is a fine answer for five people.
    .filter((o) => o.sleeps === null || o.sleeps >= params.minSleeps)
    .sort((a, b) => a.totalUsd - b.totalUsd);

  return {
    query: lodgingQuery(params.resort),
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    options,
    pick: pickLodging(options),
    searchedAt,
  };
}

function parseProperty(p: RawProperty, nights: number, minSleeps: number): LodgingOption | null {
  if (!p.name) return null;
  const total = p.total_rate?.extracted_lowest;
  const perNight = p.rate_per_night?.extracted_lowest;
  // Google usually gives both; derive whichever is missing, drop the row if neither.
  const totalUsd =
    typeof total === 'number' ? total : typeof perNight === 'number' ? perNight * nights : null;
  if (totalUsd === null || totalUsd <= 0) return null;
  const perNightUsd = typeof perNight === 'number' ? perNight : totalUsd / nights;

  return {
    name: p.name,
    type: lodgingType(p.type),
    totalUsd: round2(totalUsd),
    perNightUsd: round2(perNightUsd),
    perPersonPerNightUsd: round2(totalUsd / nights / minSleeps),
    rating: typeof p.overall_rating === 'number' ? p.overall_rating : null,
    reviews: typeof p.reviews === 'number' ? p.reviews : null,
    sleeps: parseSleeps([...(p.essential_info ?? []), ...(p.amenities ?? [])]),
    link: p.link ?? null,
    source: 'serpapi',
  };
}

function lodgingType(t: string | undefined): LodgingType {
  const s = (t ?? '').toLowerCase();
  if (s === 'hotel') return 'hotel';
  if (s.includes('vacation') || s.includes('rental')) return 'vacation_rental';
  return 'other';
}

export function parseSleeps(lines: string[]): number | null {
  for (const line of lines) {
    const m = /sleeps\s+(\d+)/i.exec(line);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

/**
 * Among the cheapest third (at least three options when there are that many)
 * take the highest rated, tie-breaking on review count so a 4.9 from two
 * reviews doesn't beat a 4.8 from four hundred.
 */
export function pickLodging(sorted: LodgingOption[]): LodgingOption | null {
  if (sorted.length === 0) return null;
  const n = Math.min(sorted.length, Math.max(3, Math.ceil(sorted.length / 3)));
  const pool = sorted.slice(0, n);
  return pool.reduce((best, o) => {
    const r = o.rating ?? 0;
    const b = best.rating ?? 0;
    if (r > b) return o;
    if (r === b && (o.reviews ?? 0) > (best.reviews ?? 0)) return o;
    return best;
  });
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const n = Math.round(
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000,
  );
  if (!Number.isFinite(n) || n < 1) throw new Error(`bad stay ${checkIn}..${checkOut}`);
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ----------------------------------------------------------------- source */

export const lodging: Source<LodgingParams, LodgingSearch> = {
  name: 'serpapi:hotels',
  key: (p) => `${lodgingQuery(p.resort)}:${p.checkIn}:${p.checkOut}:${p.minSleeps}`,
  ttlMinutes: (p) => (p.ttlHours ?? 144) * 60,
  fetch: async (p) => {
    const json = (await serpapiGet('google_hotels', {
      q: lodgingQuery(p.resort),
      check_in_date: p.checkIn,
      check_out_date: p.checkOut,
      adults: p.minSleeps,
      currency: 'USD',
      hl: 'en',
      sort_by: 3,
    })) as RawHotelsResponse;
    return parseLodging(json, p, new Date().toISOString());
  },
};

export type LodgingWindow = { resort: string; checkIn: string; checkOut: string };

/** Quota-aware entry point; `min_sleeps` and the TTL come from config. */
export function searchLodging(db: DB, cfg: Config, params: LodgingWindow, opts: GetOptions = {}) {
  return searchWithCap(
    db,
    cfg,
    lodging,
    { ...params, minSleeps: cfg.lodging.min_sleeps, ttlHours: cfg.lodging.cache_ttl_hours },
    opts,
  );
}
