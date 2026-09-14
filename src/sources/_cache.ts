import type { DB } from '../db.js';
import { log } from '../logger.js';
import type { Fetched, Source } from './types.js';

export type GetOptions = {
  /** Ignore a fresh cache entry and refetch. */
  force?: boolean;
  /** Never hit the network; throw if nothing cached. Used by tests and CI. */
  offline?: boolean;
  now?: Date;
};

/**
 * Fetch-through cache backed by the `source_cache` table.
 *
 * On a network failure a *stale* entry is served rather than blowing up the
 * job — a forecast from four hours ago beats no post at all — and the staleness
 * is logged so it can surface in the post's "as of" line.
 */
export async function cached<P, R>(
  db: DB,
  source: Source<P, R>,
  params: P,
  opts: GetOptions = {},
): Promise<Fetched<R>> {
  const now = opts.now ?? new Date();
  const key = source.key(params);
  const row = db
    .prepare('SELECT value_json, fetched_at, expires_at FROM source_cache WHERE namespace = ? AND key = ?')
    .get(source.name, key) as { value_json: string; fetched_at: string; expires_at: string } | undefined;

  const fresh = row !== undefined && parseSqliteUtc(row.expires_at) > now.getTime();

  if (row && (fresh || opts.offline) && !opts.force) {
    return { value: JSON.parse(row.value_json) as R, cached: true, fetchedAt: row.fetched_at };
  }
  if (opts.offline) {
    throw new Error(`no cached value for ${source.name}/${key} and offline mode is on`);
  }

  try {
    const value = await source.fetch(params);
    const ttl = source.ttlMinutes(params);
    const expires = new Date(now.getTime() + ttl * 60_000);
    db.prepare(
      `INSERT INTO source_cache (namespace, key, value_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value_json = excluded.value_json,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
    ).run(source.name, key, JSON.stringify(value), iso(now), iso(expires));
    return { value, cached: false, fetchedAt: iso(now) };
  } catch (err) {
    if (row) {
      log.warn('source failed, serving stale cache', {
        source: source.name,
        key,
        staleSince: row.expires_at,
        error: String(err),
      });
      return { value: JSON.parse(row.value_json) as R, cached: true, fetchedAt: row.fetched_at };
    }
    throw err;
  }
}

export function purgeExpired(db: DB, olderThanDays = 30): number {
  const res = db
    .prepare(`DELETE FROM source_cache WHERE expires_at < datetime('now', ?)`)
    .run(`-${olderThanDays} days`);
  return res.changes;
}

/** SQLite's datetime('now') format, so hand-written and library-written rows match. */
function iso(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker. Spell the
 *  conversion out rather than trusting the engine to guess at a space. */
function parseSqliteUtc(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z');
}
