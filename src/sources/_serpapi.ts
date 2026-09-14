import type { Config } from '../config.js';
import { requireSecret } from '../config.js';
import { kvGet, kvSet, type DB } from '../db.js';
import { log } from '../logger.js';
import { cached, type GetOptions } from './_cache.js';
import type { Fetched, Source } from './types.js';

export const SERPAPI_URL = 'https://serpapi.com/search.json';

/** SerpApi answers 200 with an `error` field for a bad query, so the status
 *  code alone doesn't say whether the search counted. */
export type SerpApiEnvelope = { error?: string } & Record<string, unknown>;

export async function serpapiGet(
  engine: string,
  params: Record<string, string | number>,
): Promise<SerpApiEnvelope> {
  const qs = new URLSearchParams();
  qs.set('engine', engine);
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set('api_key', requireSecret('SERPAPI_KEY'));
  const res = await fetch(`${SERPAPI_URL}?${qs}`);
  const body = (await res
    .json()
    .catch(() => ({ error: `non-JSON response (${res.status})` }))) as SerpApiEnvelope;
  if (!res.ok || body.error) {
    // Never echo the URL: it carries the key.
    throw new Error(`serpapi ${engine} ${res.status}: ${body.error ?? 'unknown error'}`);
  }
  return body;
}

/* ---------------------------------------------------------------- counter */

/** One monthly counter for every SerpApi engine — the quota is per account,
 *  not per engine, so flights and hotels draw from the same bucket. */
export function searchCounterKey(now: Date): string {
  return `serpapi:searches:${now.toISOString().slice(0, 7)}`;
}

export function serpapiSearchesThisMonth(db: DB, now: Date): number {
  const raw = kvGet(db, searchCounterKey(now));
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function recordSerpapiSearch(db: DB, now: Date): number {
  const next = serpapiSearchesThisMonth(db, now) + 1;
  kvSet(db, searchCounterKey(now), String(next));
  return next;
}

export function searchCapReached(cfg: Config, db: DB, now: Date): boolean {
  return serpapiSearchesThisMonth(db, now) >= cfg.flights.monthly_search_cap;
}

/**
 * `cached()` with the monthly quota in front of it.
 *
 * `Source.fetch` has no database handle, so the counter lives here: a live
 * fetch is exactly a `cached === false` result. Past the cap we degrade to
 * whatever is already in the cache — a week-old fare is still a fare — and only
 * fail when there's nothing at all, with a message that names the cap so the
 * job log says "quota" rather than "network".
 */
export async function searchWithCap<P, R>(
  db: DB,
  cfg: Config,
  source: Source<P, R>,
  params: P,
  opts: GetOptions = {},
): Promise<Fetched<R>> {
  const now = opts.now ?? new Date();
  if (!opts.offline && searchCapReached(cfg, db, now)) {
    const used = serpapiSearchesThisMonth(db, now);
    try {
      return await cached(db, source, params, { ...opts, force: false, offline: true });
    } catch {
      throw new Error(
        `serpapi monthly search cap reached (${used}/${cfg.flights.monthly_search_cap}) and nothing cached for ${source.name}/${source.key(params)}`,
      );
    }
  }
  const out = await cached(db, source, params, opts);
  if (!out.cached) {
    const n = recordSerpapiSearch(db, now);
    log.info('serpapi search', { source: source.name, key: source.key(params), monthTotal: n });
  }
  return out;
}
