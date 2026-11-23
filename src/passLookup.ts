import type { Config, Destination } from './config.js';
import type { DB } from './db.js';
import { cached } from './sources/_cache.js';
import {
  passAccessLookup,
  type Completer,
  type LookupResult,
  type PassAccess,
  type PassName,
} from './sources/lookup.js';

/*
 * Where the pass lookup meets the board. `/snapshot spot:` only ever reads the
 * cache (it must stay instant and free); `/build` may ask live, since a scout
 * view is rare and the answer is cached for a week.
 */

/** "2026-27": the season a date falls in, turning over in July. */
export function seasonOf(now: Date): string {
  const y = now.getUTCFullYear();
  const start = now.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function passParams(dest: Pick<Destination, 'name'>, pass: PassName, now: Date) {
  return { resort: dest.name, pass, season: seasonOf(now) };
}

const NO_LLM: Completer = {
  complete: () => Promise.reject(new Error('offline: the pass lookup is read from cache only')),
};

/** The cached answer for a board spot, or null if the lookup has never run (or there's no pass). */
export function cachedPassAccess(db: DB, cfg: Config, id: string, now: Date): PassAccess | null {
  if (cfg.group.pass === 'none') return null;
  const dest = cfg.board.find((d) => d.id === id);
  if (!dest) return null;
  const row = db
    .prepare('SELECT value_json FROM source_cache WHERE namespace = ? AND key = ?')
    .get(
      passAccessLookup(NO_LLM).name,
      passAccessLookup(NO_LLM).key(passParams(dest, cfg.group.pass, now)),
    ) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return (JSON.parse(row.value_json) as LookupResult<PassAccess>).data;
  } catch {
    return null;
  }
}

/** Live (through the cache) — for /build. Null on any failure: the line says "not checked". */
export async function fetchPassAccess(
  db: DB,
  cfg: Config,
  llm: Completer,
  dest: Destination,
  now: Date,
  opts: { offline: boolean },
): Promise<PassAccess | null> {
  if (cfg.group.pass === 'none') return null;
  try {
    const got = await cached(db, passAccessLookup(llm), passParams(dest, cfg.group.pass, now), {
      offline: opts.offline,
      now,
    });
    return got.value.data;
  } catch {
    return null;
  }
}
