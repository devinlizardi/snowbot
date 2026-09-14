import type { Source } from './types.js';

export const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';

/** Rates are "1 USD buys N of currency", straight from the API. */
export type FxTable = {
  base: 'USD';
  date: string;
  rates: Record<string, number>;
};

export type RawFrankfurter = {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, unknown>;
};

export function parseFx(json: RawFrankfurter): FxTable {
  if (json.base !== 'USD') throw new Error(`fx: expected base USD, got ${String(json.base)}`);
  if (typeof json.date !== 'string') throw new Error('fx: response has no date');
  const rates: Record<string, number> = {};
  for (const [code, v] of Object.entries(json.rates ?? {})) {
    if (typeof v === 'number' && v > 0) rates[code] = v;
  }
  if (Object.keys(rates).length === 0) throw new Error('fx: response has no rates');
  return { base: 'USD', date: json.date, rates };
}

export async function fetchFx(): Promise<FxTable> {
  const res = await fetch(`${FRANKFURTER_URL}?base=USD`);
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  return parseFx((await res.json()) as RawFrankfurter);
}

/** ECB reference rates move once a business day; a day of staleness is well
 *  inside the noise of a fare quote. */
export const fx: Source<void, FxTable> = {
  name: 'frankfurter',
  key: () => 'latest',
  ttlMinutes: () => 24 * 60,
  fetch: fetchFx,
};

/** Throws on an unknown currency rather than guessing — a wrong rate on a
 *  five-person total is a worse outcome than a missing line. */
export function toUsd(amount: number, currency: string, table: FxTable): number {
  const code = currency.toUpperCase();
  if (code === 'USD') return amount;
  const rate = table.rates[code];
  if (rate === undefined)
    throw new Error(`fx: no USD rate for ${code} (table dated ${table.date})`);
  return amount / rate;
}
