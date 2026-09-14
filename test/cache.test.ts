import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, purgeExpired } from '../src/sources/_cache.js';
import { openDb, type DB } from '../src/db.js';
import type { Source } from '../src/sources/types.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function counter(ttlMinutes = 60) {
  let calls = 0;
  const source: Source<{ id: string }, { n: number }> = {
    name: 'test-source',
    key: (p) => p.id,
    ttlMinutes: () => ttlMinutes,
    fetch: async () => ({ n: ++calls }),
  };
  return { source, calls: () => calls };
}

describe('cached', () => {
  it('fetches once, then serves from cache', async () => {
    const { source, calls } = counter();
    const a = await cached(db, source, { id: 'aspen' });
    const b = await cached(db, source, { id: 'aspen' });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.value).toEqual({ n: 1 });
    expect(calls()).toBe(1);
  });

  it('keys separately per params', async () => {
    const { source, calls } = counter();
    await cached(db, source, { id: 'aspen' });
    await cached(db, source, { id: 'niseko' });
    expect(calls()).toBe(2);
  });

  it('refetches once the ttl has passed', async () => {
    const { source, calls } = counter(60);
    const t0 = new Date('2026-09-14T12:00:00Z');
    await cached(db, source, { id: 'aspen' }, { now: t0 });
    await cached(db, source, { id: 'aspen' }, { now: new Date('2026-09-14T12:59:00Z') });
    expect(calls()).toBe(1);
    const late = await cached(db, source, { id: 'aspen' }, { now: new Date('2026-09-14T13:01:00Z') });
    expect(calls()).toBe(2);
    expect(late.cached).toBe(false);
  });

  it('honours force', async () => {
    const { source, calls } = counter();
    await cached(db, source, { id: 'aspen' });
    await cached(db, source, { id: 'aspen' }, { force: true });
    expect(calls()).toBe(2);
  });

  it('serves a stale value rather than failing the job', async () => {
    let shouldFail = false;
    const source: Source<void, string> = {
      name: 'flaky',
      key: () => 'k',
      ttlMinutes: () => 1,
      fetch: async () => {
        if (shouldFail) throw new Error('upstream 503');
        return 'good';
      },
    };
    await cached(db, source, undefined, { now: new Date('2026-09-14T12:00:00Z') });
    shouldFail = true;
    const out = await cached(db, source, undefined, { now: new Date('2026-09-14T14:00:00Z') });
    expect(out.value).toBe('good');
    expect(out.cached).toBe(true);
  });

  it('propagates the error when there is nothing stale to fall back on', async () => {
    const source: Source<void, string> = {
      name: 'always-broken',
      key: () => 'k',
      ttlMinutes: () => 1,
      fetch: async () => {
        throw new Error('upstream 503');
      },
    };
    await expect(cached(db, source, undefined)).rejects.toThrow('upstream 503');
  });

  it('never touches the network in offline mode', async () => {
    const fetch = vi.fn();
    const source: Source<void, string> = {
      name: 'offline',
      key: () => 'k',
      ttlMinutes: () => 1,
      fetch: fetch as unknown as () => Promise<string>,
    };
    await expect(cached(db, source, undefined, { offline: true })).rejects.toThrow(/offline mode/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('purges expired rows', async () => {
    const { source } = counter(1);
    await cached(db, source, { id: 'old' });
    db.prepare(`UPDATE source_cache SET expires_at = datetime('now','-90 days')`).run();
    expect(purgeExpired(db, 30)).toBe(1);
  });
});
