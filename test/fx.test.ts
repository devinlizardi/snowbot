import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cached } from '../src/sources/_cache.js';
import { openDb, type DB } from '../src/db.js';
import { fx, parseFx, toUsd, type FxTable } from '../src/sources/fx.js';

/** Trimmed from a real Frankfurter response. */
const FRANKFURTER = {
  amount: 1,
  base: 'USD',
  date: '2026-09-11',
  rates: { CAD: 1.3612, CHF: 0.7981, EUR: 0.8531, GBP: 0.7392, JPY: 147.32 },
};

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('parseFx', () => {
  it('keeps only positive numeric rates', () => {
    const t = parseFx({ ...FRANKFURTER, rates: { ...FRANKFURTER.rates, XXX: 'n/a', YYY: -1 } });
    expect(t).toEqual({ base: 'USD', date: '2026-09-11', rates: FRANKFURTER.rates });
  });

  it('rejects a table that is not USD-based', () => {
    expect(() => parseFx({ ...FRANKFURTER, base: 'EUR' })).toThrow(/base USD/);
  });

  it('rejects an empty table', () => {
    expect(() => parseFx({ base: 'USD', date: '2026-09-11', rates: {} })).toThrow(/no rates/);
  });
});

describe('toUsd', () => {
  const table: FxTable = parseFx(FRANKFURTER);

  it.each([
    ['USD', 100, 100],
    ['JPY', 147320, 1000],
    ['jpy', 147320, 1000],
    ['EUR', 85.31, 100],
    ['CAD', 1361.2, 1000],
  ])('%s %d -> $%d', (currency, amount, usd) => {
    expect(toUsd(amount, currency, table)).toBeCloseTo(usd, 6);
  });

  it('throws on an unknown currency rather than guessing', () => {
    expect(() => toUsd(10, 'KRW', table)).toThrow(/no USD rate for KRW/);
  });
});

describe('fx source', () => {
  it('is keyed as latest with a 24h ttl and never fetches offline', async () => {
    expect(fx.key()).toBe('latest');
    expect(fx.ttlMinutes()).toBe(1440);
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(cached(db, fx, undefined, { offline: true })).rejects.toThrow(/offline/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('round-trips through the cache', async () => {
    const stub = { ...fx, fetch: async () => parseFx(FRANKFURTER) };
    await cached(db, stub, undefined);
    const again = await cached(db, fx, undefined, { offline: true });
    expect(again.cached).toBe(true);
    expect(again.value.rates.JPY).toBe(147.32);
  });
});
