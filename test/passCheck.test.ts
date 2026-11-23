import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { passCheck, ranges } from '../src/passCheck.js';
import { cached } from '../src/sources/_cache.js';
import { openDb } from '../src/db.js';
import {
  passAccessLookup,
  PassAccessSchema,
  type Completer,
  type PassAccess,
} from '../src/sources/lookup.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/lookup-pass-access-killington.json', import.meta.url), 'utf8'),
) as { reply: string };

const BLACKOUTS = [
  { start: '2026-12-26', end: '2026-12-30' },
  { start: '2027-01-16', end: '2027-01-17' },
  { start: '2027-02-13', end: '2027-02-14' },
];
const unlimited: PassAccess = {
  onPass: true,
  daysLimit: 'unlimited',
  blackouts: BLACKOUTS,
  notes: '',
};
const fiveDays: PassAccess = {
  onPass: true,
  daysLimit: 5,
  blackouts: BLACKOUTS,
  notes: 'Snowbird only',
};
const spot = { name: 'Somewhere' };

describe('lookup:pass-access', () => {
  it('parses a compare-page answer through the v2 schema, cached for a week', async () => {
    const calls: string[] = [];
    const llm: Completer = {
      async complete(prompt) {
        calls.push(prompt);
        return fixture.reply;
      },
    };
    const src = passAccessLookup(llm);
    expect(src.ttlMinutes({ resort: 'Killington', pass: 'ikon_base', season: '2026-27' })).toBe(
      7 * 24 * 60,
    );
    const out = await cached(openDb(':memory:'), src, {
      resort: 'Killington',
      pass: 'ikon_base',
      season: '2026-27',
    });
    expect(out.value.data).toEqual({
      onPass: true,
      daysLimit: 5,
      blackouts: BLACKOUTS,
      notes: 'Shared between Killington and Pico',
    });
    expect(calls[0]).toContain('ikonpass.com/en/compare-passes');
    expect(calls[0]).toContain('Ikon Base Pass');
  });

  it('accepts "unlimited" and refuses a malformed blackout', () => {
    expect(PassAccessSchema.safeParse(unlimited).success).toBe(true);
    const bad = { ...unlimited, blackouts: [{ start: 'Dec 26', end: '2026-12-30' }] };
    expect(PassAccessSchema.safeParse(bad).success).toBe(false);
  });
});

describe('passCheck', () => {
  it('flags the blackout dates a holiday window touches', () => {
    const c = passCheck(spot, { start: '2026-12-28', end: '2027-01-02' }, unlimited);
    expect(c.blackoutDates).toEqual(['2026-12-28', '2026-12-29', '2026-12-30']);
    expect(c.overDayLimit).toBe(false);
    expect(c.summary).toBe('Ikon Base Pass: unlimited — blacked out Dec 28–30.');
  });

  it('flags a trip longer than the day limit', () => {
    const c = passCheck(spot, { start: '2027-03-01', end: '2027-03-06' }, fiveDays);
    expect(c.tripDays).toBe(6);
    expect(c.overDayLimit).toBe(true);
    expect(c.blackoutDates).toEqual([]);
    expect(c.summary).toBe(
      'Ikon Base Pass: 5 days (Snowbird only) — your 6-day trip runs past the 5-day limit.',
    );
  });

  it('is clean for an unlimited spot outside the blackouts', () => {
    const c = passCheck(spot, { start: '2027-03-05', end: '2027-03-07' }, unlimited);
    expect(c).toMatchObject({ onPass: true, blackoutDates: [], overDayLimit: false });
    expect(c.summary).toBe('Ikon Base Pass: unlimited, no blackouts in these dates.');
  });

  it('says both problems when there are two', () => {
    const c = passCheck(spot, { start: '2027-02-10', end: '2027-02-15' }, fiveDays);
    expect(c.summary).toMatch(
      /blacked out Feb 13–14; your 6-day trip runs past the 5-day limit\.$/,
    );
  });

  it('says so when the lookup has not answered, or the spot is off the pass', () => {
    const w = { start: '2027-03-05', end: '2027-03-07' };
    expect(passCheck(spot, w, null).summary).toBe('Ikon Base Pass: not checked yet.');
    expect(passCheck(spot, w, { ...unlimited, onPass: false }).summary).toBe(
      'Not on the Ikon Base Pass — lift tickets on top.',
    );
    expect(passCheck(spot, w, unlimited, 'none').summary).toMatch(/lift tickets/);
  });
});

describe('ranges', () => {
  it('collapses consecutive days and spans months', () => {
    expect(ranges(['2026-12-28', '2026-12-29', '2027-01-16'])).toBe('Dec 28–29, Jan 16');
    expect(ranges(['2026-12-31', '2027-01-01'])).toBe('Dec 31–Jan 1');
  });
});
