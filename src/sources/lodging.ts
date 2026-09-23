import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { GetOptions } from './_cache.js';
import { searchWithCap, serpapiGet } from './_serpapi.js';
import { log } from '../logger.js';
import type { Fetched, Source } from './types.js';

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
  /** Hotels (Google's default) or whole-place vacation rentals. */
  kind?: LodgingKind;
  /** How many of the group one hotel room holds; hotels are priced as enough rooms for everyone. */
  guestsPerRoom?: number;
};

export type LodgingKind = 'hotels' | 'rentals';

export type LodgingType = 'hotel' | 'vacation_rental' | 'other';

export type LodgingOption = {
  name: string;
  type: LodgingType;
  /**
   * The whole stay for the whole group, taxes included where Google shows
   * them: the listing's own total × `units`. A hotel is priced per room, so
   * five people in a hotel is several rooms, not one room split five ways.
   */
  totalUsd: number;
  /** What the listing itself costs for the stay: one room, or the whole place. */
  unitTotalUsd: number;
  /** Rooms (hotels) or properties (rentals) the group books. */
  units: number;
  /** Group cost per night. */
  perNightUsd: number;
  /** totalUsd ÷ nights ÷ minSleeps — the number that goes in the dossier. */
  perPersonPerNightUsd: number;
  rating: number | null;
  reviews: number | null;
  /** Parsed from "Sleeps N"; null when the listing doesn't say (hotels never do). */
  sleeps: number | null;
  bedrooms: number | null;
  /** The amenities worth selling: onsen, hot tub, ski-in/ski-out… */
  highlights: string[];
  /** The property's own site, as Google gives it; often null for rentals. */
  link: string | null;
  /** Always clickable: `link`, or a search for the property by name when Google gave none. */
  url: string;
  source: 'serpapi';
};

export type ShortlistRole = 'pick' | 'cheapest' | 'nicest' | 'alternative';
export type ShortlistEntry = LodgingOption & { role: ShortlistRole };

export type LodgingSearch = {
  query: string;
  checkIn: string;
  checkOut: string;
  /** Sorted by total, cheapest first; already filtered to sleeps ≥ minSleeps or unknown. */
  options: LodgingOption[];
  /** Best rated among the cheapest third — cheap but not the place with the bedbug reviews. */
  pick: LodgingOption | null;
  /** The pick first, then the cheapest and the nicest alternatives — the dossier's table. */
  shortlist: ShortlistEntry[];
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

export const DEFAULT_GUESTS_PER_ROOM = 2;

export function parseLodging(
  json: RawHotelsResponse,
  params: Pick<LodgingParams, 'resort' | 'checkIn' | 'checkOut' | 'minSleeps' | 'guestsPerRoom'>,
  searchedAt: string,
): LodgingSearch {
  const nights = nightsBetween(params.checkIn, params.checkOut);
  const rooms = Math.ceil(params.minSleeps / (params.guestsPerRoom ?? DEFAULT_GUESTS_PER_ROOM));
  const options = (json.properties ?? [])
    .map((p) => parseProperty(p, nights, params.minSleeps, rooms, params.resort))
    .filter((o): o is LodgingOption => o !== null)
    // A listing that says it sleeps 3 is out; one that doesn't say (every
    // hotel) stays in, priced as enough rooms for the group.
    .filter((o) => o.sleeps === null || o.sleeps >= params.minSleeps)
    .sort((a, b) => a.totalUsd - b.totalUsd);
  return finish(options, params, searchedAt);
}

function finish(
  options: LodgingOption[],
  params: Pick<LodgingParams, 'resort' | 'checkIn' | 'checkOut'>,
  searchedAt: string,
): LodgingSearch {
  const pick = pickLodging(options);
  return {
    query: lodgingQuery(params.resort),
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    options,
    pick,
    shortlist: shortlistLodging(options, pick),
    searchedAt,
  };
}

/** Hotels and rentals searched separately, read as one list. Either side may be missing. */
export function mergeLodging(
  a: LodgingSearch | null,
  b: LodgingSearch | null,
): LodgingSearch | null {
  if (!a || !b) return a ?? b;
  const seen = new Set<string>();
  const options = [...a.options, ...b.options]
    .filter((o) => {
      const k = o.name.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => x.totalUsd - y.totalUsd);
  const searchedAt = a.searchedAt > b.searchedAt ? a.searchedAt : b.searchedAt;
  return {
    ...finish(options, { resort: '', checkIn: a.checkIn, checkOut: a.checkOut }, searchedAt),
    query: a.query,
  };
}

function parseProperty(
  p: RawProperty,
  nights: number,
  minSleeps: number,
  rooms: number,
  resort: string,
): LodgingOption | null {
  if (!p.name) return null;
  const total = p.total_rate?.extracted_lowest;
  const perNight = p.rate_per_night?.extracted_lowest;
  // Google usually gives both; derive whichever is missing, drop the row if neither.
  const unitTotal =
    typeof total === 'number' ? total : typeof perNight === 'number' ? perNight * nights : null;
  if (unitTotal === null || unitTotal <= 0) return null;
  const type = lodgingType(p.type);
  const info = [...(p.essential_info ?? []), ...(p.amenities ?? [])];
  const sleeps = parseSleeps(info);
  // A hotel room sleeps two unless it says otherwise; a rental is the whole place.
  const units = type === 'hotel' && (sleeps === null || sleeps < minSleeps) ? rooms : 1;
  const totalUsd = unitTotal * units;

  return {
    name: p.name,
    type,
    totalUsd: round2(totalUsd),
    unitTotalUsd: round2(unitTotal),
    units,
    perNightUsd: round2(totalUsd / nights),
    perPersonPerNightUsd: round2(totalUsd / nights / minSleeps),
    rating: typeof p.overall_rating === 'number' ? p.overall_rating : null,
    reviews: typeof p.reviews === 'number' ? p.reviews : null,
    sleeps,
    bedrooms: parseBedrooms(info),
    highlights: parseHighlights(info),
    link: p.link ?? null,
    url: p.link ?? searchUrl(p.name, resort),
    source: 'serpapi',
  };
}

/** A link that always lands somewhere useful, for listings Google gave no site for. */
export function searchUrl(name: string, resort: string): string {
  const q = resort && !name.toLowerCase().includes(resort.toLowerCase()) ? `${name} ${resort}` : name;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

export function parseBedrooms(lines: string[]): number | null {
  for (const line of lines) {
    const m = /(\d+)\s*(?:bedrooms?|br\b)/i.exec(line);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

/** The amenities that sell a place to a snowboarding group, in the order worth mentioning. */
const HIGHLIGHTS: [RegExp, string][] = [
  [/ski[- ]?in|ski[- ]?out/i, 'ski-in/ski-out'],
  [/onsen|hot spring/i, 'onsen'],
  [/hot tub|jacuzzi|whirlpool/i, 'hot tub'],
  [/sauna/i, 'sauna'],
  [/fireplace/i, 'fireplace'],
  [/pool/i, 'pool'],
  [/shuttle/i, 'shuttle'],
  [/kitchen/i, 'kitchen'],
  [/breakfast/i, 'breakfast'],
];

export function parseHighlights(lines: string[]): string[] {
  const text = lines.join(' | ');
  return HIGHLIGHTS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/**
 * Up to three places to show side by side: the pick, the cheapest other
 * option (the money-saver), and the best rated option that costs no more than
 * twice the pick (the splurge that's still in reach). Topped up with the next
 * cheapest if either is missing.
 */
export function shortlistLodging(
  sorted: LodgingOption[],
  pick: LodgingOption | null,
  n = 3,
): ShortlistEntry[] {
  if (!pick) return [];
  const out: ShortlistEntry[] = [{ ...pick, role: 'pick' }];
  const rest = sorted.filter((o) => o !== pick);
  const cheapest = rest[0];
  if (cheapest && cheapest.totalUsd < pick.totalUsd) out.push({ ...cheapest, role: 'cheapest' });
  const used = new Set(out.map((o) => o.name));
  const nicest = rest
    .filter((o) => !used.has(o.name) && o.totalUsd <= pick.totalUsd * 2 && o.rating !== null)
    .reduce<LodgingOption | null>((best, o) => {
      if (!best) return o;
      const r = o.rating ?? 0;
      const b = best.rating ?? 0;
      return r > b || (r === b && (o.reviews ?? 0) > (best.reviews ?? 0)) ? o : best;
    }, null);
  if (nicest && (nicest.rating ?? 0) >= (pick.rating ?? 0)) {
    out.push({ ...nicest, role: 'nicest' });
  }
  for (const o of rest) {
    if (out.length >= n) break;
    if (!out.some((x) => x.name === o.name)) out.push({ ...o, role: 'alternative' });
  }
  return out.slice(0, n);
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
  // v2: totals became whole-group (hotels × rooms) and gained a shortlist, so
  // rows cached under the old key must not be read back as the new shape.
  key: (p) =>
    `${lodgingQuery(p.resort)}:${p.checkIn}:${p.checkOut}:${p.minSleeps}` +
    `:${p.kind === 'rentals' ? 'rentals' : 'hotels'}:g${p.guestsPerRoom ?? DEFAULT_GUESTS_PER_ROOM}:v2`,
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
      ...(p.kind === 'rentals' ? { vacation_rentals: 'true' } : {}),
    })) as RawHotelsResponse;
    return parseLodging(json, p, new Date().toISOString());
  },
};

export type LodgingWindow = { resort: string; checkIn: string; checkOut: string };

/**
 * Quota-aware entry point; `min_sleeps`, the room assumption and the TTL come
 * from config. Hotels and (when enabled) rentals are two searches against the
 * same monthly counter, merged into one list; either may fail on its own.
 */
export async function searchLodging(
  db: DB,
  cfg: Config,
  params: LodgingWindow,
  opts: GetOptions = {},
): Promise<Fetched<LodgingSearch>> {
  const base = {
    ...params,
    minSleeps: cfg.lodging.min_sleeps,
    ttlHours: cfg.lodging.cache_ttl_hours,
    guestsPerRoom: cfg.lodging.hotel_guests_per_room,
  };
  const kinds: LodgingKind[] = cfg.lodging.search_rentals ? ['hotels', 'rentals'] : ['hotels'];
  const results: Fetched<LodgingSearch>[] = [];
  const errors: string[] = [];
  for (const kind of kinds) {
    try {
      results.push(await searchWithCap(db, cfg, lodging, { ...base, kind }, opts));
    } catch (err) {
      errors.push(`${kind}: ${String(err)}`);
    }
  }
  if (results.length === 0) throw new Error(errors.join('; '));
  if (errors.length) log.warn('lodging search partly failed', { errors });
  const merged = mergeLodging(results[0]!.value, results[1]?.value ?? null)!;
  return {
    value: merged,
    cached: results.every((r) => r.cached),
    fetchedAt: results.map((r) => r.fetchedAt).sort()[0]!,
  };
}
