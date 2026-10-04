import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { cached } from '../src/sources/_cache.js';
import { ecmwfIfs } from '../src/sources/weather/ecmwf.js';
import {
  fetchModelForecast,
  getJson,
  OpenMeteoHttpError,
  RATE_LIMIT_RETRY_MS,
} from '../src/sources/weather/openMeteo.js';

const COORD = { lat: 45.92, lon: 6.87 };
const OK = { daily: { time: ['2026-10-04'], snowfall_sum: [1] } };

type Reply = { status: number; body: unknown };
let replies: Reply[];
let urls: string[];

beforeEach(() => {
  replies = [];
  urls = [];
  vi.useFakeTimers();
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    const r = replies.shift();
    if (!r) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rateLimited: Reply = { status: 429, body: { error: true, reason: 'Too many concurrent requests' } };

describe('getJson on a 429', () => {
  it('waits, retries once, and returns the second answer', async () => {
    replies.push(rateLimited, { status: 200, body: OK });
    const p = getJson('https://x.test/v1/forecast', { a: 1 });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1);
    expect(urls).toHaveLength(1); // still waiting
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
    await expect(p).resolves.toEqual(OK);
    expect(urls).toHaveLength(2);
  });

  it('gives up after the second 429, so the cache can serve stale', async () => {
    const db = openDb(':memory:');
    const params = { coord: COORD, forecastDays: 7, ttlMinutes: 60 };
    const t0 = new Date('2026-10-04T08:00:00Z');
    replies.push({ status: 200, body: OK });
    await cached(db, ecmwfIfs, params, { now: t0 });

    replies.push(rateLimited, rateLimited);
    const p = cached(db, ecmwfIfs, params, { now: new Date('2026-10-04T12:00:00Z') });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS * 2);
    const got = await p;
    expect(got.cached).toBe(true);
    expect(got.value.days[0]!.snowfallCm).toBe(1);
    // One try, one retry — and not a third request down the "missing variables" path.
    expect(urls).toHaveLength(3);
  });
});

describe('the optional-variables fallback', () => {
  it('is not taken for a 429', async () => {
    replies.push(rateLimited, rateLimited);
    const p = fetchModelForecast('ecmwf_ifs025', COORD, 7);
    const settled = expect(p).rejects.toBeInstanceOf(OpenMeteoHttpError);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS * 2);
    await settled;
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.includes('hourly='))).toBe(true);
  });

  it('is taken for a 400 naming a variable, and records what is missing', async () => {
    replies.push(
      {
        status: 400,
        body: {
          error: true,
          reason: 'Cannot initialize ForecastVariableHourly from invalid String value freezing_level_height',
        },
      },
      { status: 200, body: OK },
    );
    const f = await fetchModelForecast('gem_seamless', COORD, 7);
    expect(urls).toHaveLength(2);
    expect(urls[1]).not.toContain('hourly=');
    expect(f.missingVariables).toEqual(expect.arrayContaining(['snow_depth', 'freezing_level_height']));
  });

  it('is not taken for any other 400', async () => {
    replies.push({ status: 400, body: { error: true, reason: 'Latitude must be in range of -90 to 90°' } });
    await expect(fetchModelForecast('ecmwf_ifs025', COORD, 7)).rejects.toThrow(/Latitude/);
    expect(urls).toHaveLength(1);
  });
});
