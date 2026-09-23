import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config, type Destination } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { log } from '../src/logger.js';
import {
  CLIMATOLOGY_CAVEAT,
  fetchClimatology,
  lastCompleteSeason,
  seasonDates,
  seasonLabel,
  seasonOf,
  shiftToSeason,
  summarizeClimatology,
  type ArchiveDays,
  type SeasonRecord,
} from '../src/sources/weather/climatology.js';

const SPAN = { start: '12-01', end: '04-15' };

function days(start: string, end: string, cm: (date: string) => number | null): ArchiveDays {
  const out: ArchiveDays = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); ; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > end) break;
    out.push({ date: d, snowfallCm: cm(d) });
  }
  return out;
}

/** February snows every other day (5cm), the rest of the season dribbles (1cm, under the snow-day bar). */
const typical = (d: string) =>
  d.slice(5, 7) === '02' ? (Number(d.slice(8)) % 2 === 0 ? 5 : 0) : 1;

function season(s: number, cm: (d: string) => number | null = typical): SeasonRecord {
  const { start, end } = seasonDates(s, SPAN);
  return { season: s, days: days(start, end, cm) };
}

describe('season arithmetic', () => {
  it('assigns a date to the season that started the previous December', () => {
    expect(seasonOf('2027-02-06', SPAN)).toBe(2026);
    expect(seasonOf('2026-12-04', SPAN)).toBe(2026);
    expect(seasonOf('2026-09-14', SPAN)).toBe(2025);
    expect(seasonDates(2026, SPAN)).toEqual({ start: '2026-12-01', end: '2027-04-15' });
    expect(seasonLabel(2014)).toBe('2014–15');
  });

  it('knows which season last finished', () => {
    expect(lastCompleteSeason('2026-09-22', SPAN)).toBe(2025);
    expect(lastCompleteSeason('2027-01-10', SPAN)).toBe(2025);
    expect(lastCompleteSeason('2027-04-16', SPAN)).toBe(2026);
  });

  it('moves a date between seasons and drops a Feb 29 with no twin', () => {
    expect(shiftToSeason('2027-02-06', 2026, 2010)).toBe('2011-02-06');
    expect(shiftToSeason('2024-02-29', 2023, 2022)).toBeNull();
  });
});

describe('summarizeClimatology', () => {
  const window = { start: '2027-02-06', end: '2027-02-15' };
  const seasons = Array.from({ length: 20 }, (_, i) => season(2006 + i));

  it('counts snow days and seasons that delivered, never exposing amounts', () => {
    const c = summarizeClimatology({ window, span: SPAN, seasons, snowDayCm: 2 })!;
    expect(c).toMatchObject({
      seasons: 20,
      firstSeason: '2006–07',
      lastSeason: '2025–26',
      windowDays: 10,
      typicalSnowDays: 5, // Feb 6, 8, 10, 12, 14
      seasonsWithSnow: 20,
      seasonsHalfSnowy: 20,
      peakMonth: 'February',
      windowMonth: 'February',
      windowMonthRank: 1,
      caveat: CLIMATOLOGY_CAVEAT,
      seasonToDate: null,
    });
    // 2.5cm/day in the window against a season average a little over 1: much snowier.
    expect(c.vsSeasonPct).toBeGreaterThan(50);
    // The only centimetres in it are the snow-day threshold; no amounts.
    expect(Object.keys(c).filter((k) => /cm/i.test(k))).toEqual(['snowDayCm']);
  });

  it('names the best and quietest seasons for this window', () => {
    const varied = seasons.map((s) =>
      s.season === 2010 ? season(2010, () => 6) : s.season === 2015 ? season(2015, () => 0) : s,
    );
    const c = summarizeClimatology({ window, span: SPAN, seasons: varied, snowDayCm: 2 })!;
    expect(c.bestSeason).toEqual({ season: '2010–11', snowDays: 10 });
    expect(c.quietestSeason).toEqual({ season: '2015–16', snowDays: 0 });
    expect(c.seasonsWithSnow).toBe(19);
  });

  it('skips seasons that barely cover the window and gives up under five', () => {
    const holes = seasons.map((s, i) =>
      i < 17 ? { season: s.season, days: s.days.filter((d) => d.date.slice(5, 7) !== '02') } : s,
    );
    expect(summarizeClimatology({ window, span: SPAN, seasons: holes, snowDayCm: 2 })).toBeNull();
  });

  it('reads the season so far against the same span of past seasons', () => {
    const current = season(2026, (d) => (d <= '2026-12-20' ? 2 : null));
    const c = summarizeClimatology({ window, span: SPAN, seasons, current, snowDayCm: 2 })!;
    // 20 days at 2cm against 20 days at 1cm.
    expect(c.seasonToDate).toEqual({ throughDate: '2026-12-20', pctOfNormal: 200 });
  });

  it('waits a week into the season before judging it', () => {
    const current = season(2026, (d) => (d <= '2026-12-04' ? 2 : null));
    const c = summarizeClimatology({ window, span: SPAN, seasons, current, snowDayCm: 2 })!;
    expect(c.seasonToDate).toBeNull();
  });
});

describe('fetchClimatology', () => {
  let db: DB;
  let cfg: Config;
  let fetchSpy: { mockRestore(): void };
  const requested: string[] = [];
  const niseko = (): Destination => cfg.board.find((d) => d.id === 'niseko')!;

  beforeEach(() => {
    db = openDb(':memory:');
    cfg = loadConfig({ env: {} });
    requested.length = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('start_date')!;
      const end = url.searchParams.get('end_date')!;
      requested.push(`${start}..${end}`);
      const d = days(start, end, typical);
      return new Response(
        JSON.stringify({
          daily: { time: d.map((x) => x.date), snowfall_sum: d.map((x) => x.snowfallCm) },
        }),
        { status: 200 },
      );
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  const ctx = (now: Date) => ({ cfg, db, now, log: log.child({ test: true }) });

  it('asks for the last 20 finished seasons once, pacing live requests and not cache hits', async () => {
    const sleep = vi.fn(async () => {});
    const now = new Date('2026-09-22T12:00:00Z');
    const window = { start: '2027-02-06', end: '2027-02-15' };
    const c = await fetchClimatology(ctx(now), niseko(), window, { sleep, paceMs: 1500 });
    expect(requested).toHaveLength(20);
    expect(requested[0]).toBe('2006-12-01..2007-04-15');
    expect(requested[19]).toBe('2025-12-01..2026-04-15');
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(c?.typicalSnowDays).toBe(5);

    // A second build the same week is free: every season is cached for a year.
    const again = await fetchClimatology(ctx(now), niseko(), window, { sleep });
    expect(requested).toHaveLength(20);
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(again).toEqual(c);
  });

  it('adds the season so far once it has started', async () => {
    const now = new Date('2026-12-21T12:00:00Z');
    const c = await fetchClimatology(
      ctx(now),
      niseko(),
      { start: '2027-02-06', end: '2027-02-15' },
      {
        paceMs: 0,
      },
    );
    expect(requested).toContain('2026-12-01..2026-12-20');
    expect(c?.seasonToDate).toEqual({ throughDate: '2026-12-20', pctOfNormal: 100 });
  });

  it('degrades to null offline with nothing cached', async () => {
    const c = await fetchClimatology(
      ctx(new Date('2026-09-22T12:00:00Z')),
      niseko(),
      { start: '2027-02-06', end: '2027-02-15' },
      { offline: true },
    );
    expect(c).toBeNull();
    expect(requested).toEqual([]);
  });
});
