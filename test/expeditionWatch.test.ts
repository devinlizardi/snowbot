import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { kvSet, openDb, type DB } from '../src/db.js';
import { Poster } from '../src/discord/client.js';
import type { JobContext } from '../src/jobs/_runner.js';
import {
  classifyMove,
  itinerariesFor,
  renderWatchTable,
  retireIfPast,
  runExpeditionWatch,
  type ExpeditionRow,
  type ExpeditionWatchDeps,
} from '../src/jobs/expeditionWatch.js';
import { LlmClient } from '../src/llm/client.js';
import { log } from '../src/logger.js';
import type { FlightQuote, FlightSearch } from '../src/sources/flights.js';

/* ------------------------------------------------------------- fixtures */

const EXP_ID = 'niseko-0212';
const WINDOW = ['2027-02-12', '2027-02-20'] as const;

/** The dossier's per-member quotes; also the day-0 baseline of the fare series. */
const PER_MEMBER = [
  { member: 'Devin', origin: 'JFK', priceUsd: 698 },
  { member: 'Andre', origin: 'EWR', priceUsd: 698 },
  { member: 'Elliot', origin: 'LAX', priceUsd: 511 },
  { member: 'Jeremy', origin: 'LAX', priceUsd: 524 },
  { member: 'Hagen', origin: 'SFO', priceUsd: 540 },
];

/** Only the routing slice; Packet 12 owns the rest of the plan and we must not care. */
const PLAN = {
  destination: 'niseko',
  routing: {
    recommended: 'consolidate-west',
    independent: {
      perMember: PER_MEMBER.map((m) =>
        m.member === 'Elliot' ? { ...m, origin: 'BUR', priceUsd: 684 } : m,
      ),
    },
    'consolidate-west': { perMember: PER_MEMBER },
  },
};

const row = (patch: Partial<ExpeditionRow> = {}): ExpeditionRow => ({
  id: EXP_ID,
  destination: 'niseko',
  window_start: WINDOW[0],
  window_end: WINDOW[1],
  plan_json: JSON.stringify(PLAN),
  status: 'watched',
  thread_id: null,
  ...patch,
});

const quote = (priceUsd: number): FlightQuote => ({
  priceUsd,
  airlines: ['ZIPAIR'],
  stops: 0,
  durationMin: 700,
  departAt: `${WINDOW[0]} 10:00`,
  arriveAt: `${WINDOW[0]} 23:00`,
  legs: [],
  source: 'serpapi',
});

/* -------------------------------------------------------------- pure bits */

describe('itinerariesFor', () => {
  const cfg = loadConfig({ env: {} });

  it('follows the recommended routing and looks the airport up on the board', () => {
    const its = itinerariesFor(row(), cfg);
    expect(its).toHaveLength(5);
    expect(its.find((i) => i.member === 'Elliot')).toEqual({
      member: 'Elliot',
      origin: 'LAX',
      dest: 'CTS',
      depart: WINDOW[0],
      return: WINDOW[1],
      priceUsd: 511,
    });
  });

  it('falls back to independent routing when the recommendation is missing or unknown', () => {
    const plan = { routing: { recommended: 'teleport', independent: PLAN.routing.independent } };
    const its = itinerariesFor(row({ plan_json: JSON.stringify(plan) }), cfg);
    expect(its.find((i) => i.member === 'Elliot')?.origin).toBe('BUR');
  });

  it('dedupes member+origin and drops rows it cannot read', () => {
    const plan = {
      routing: {
        independent: {
          perMember: [
            { member: 'Devin', origin: 'jfk', priceUsd: 700 },
            { member: 'Devin', origin: 'JFK', priceUsd: 710 },
            { member: 'Nobody' },
            { origin: 'SFO' },
            'garbage',
            { member: 'Hagen', origin: 'SFO', priceUsd: 'n/a' },
          ],
        },
      },
    };
    const its = itinerariesFor(row({ plan_json: JSON.stringify(plan) }), cfg);
    expect(its.map((i) => [i.member, i.origin, i.priceUsd])).toEqual([
      ['Devin', 'JFK', 700],
      ['Hagen', 'SFO', null],
    ]);
  });

  it('prefers an explicit dest on the plan over the board, and yields nothing off-board', () => {
    const plan = { routing: { independent: { perMember: [{ member: 'Devin', origin: 'JFK', dest: 'hnd' }] } } };
    expect(itinerariesFor(row({ plan_json: JSON.stringify(plan), destination: 'atlantis' }), cfg)[0]?.dest).toBe('HND');
    expect(itinerariesFor(row({ destination: 'atlantis' }), cfg)).toEqual([]);
  });

  it('yields nothing for a plan without routing or with broken JSON', () => {
    expect(itinerariesFor(row({ plan_json: '{}' }), cfg)).toEqual([]);
    expect(itinerariesFor(row({ plan_json: '{not json' }), cfg)).toEqual([]);
  });
});

describe('retireIfPast', () => {
  it.each([
    ['the night before', '2027-02-11T23:59:59Z', false],
    ['midnight of day one', '2027-02-12T00:00:00Z', false],
    ['an hour in', '2027-02-12T01:00:00Z', true],
    ['mid-trip', '2027-02-15T12:00:00Z', true],
  ])('%s → %s', (_label, now, expected) => {
    expect(retireIfPast({ window_start: WINDOW[0] }, new Date(now))).toBe(expected);
  });
  it('never retires on a garbage date', () => {
    expect(retireIfPast({ window_start: 'someday' }, new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('classifyMove', () => {
  it.each([
    ['first check, no history', null, 600, null, 'flat'],
    ['flat', 600, 605, 600, 'flat'],
    ['-9.9% is chatter', 1000, 901, 900, 'flat'],
    ['-10% pings', 1000, 900, 850, 'down'],
    ['+10% pings', 1000, 1100, 900, 'up'],
    ['small drop under the floor', 610, 595, 600, 'new-floor'],
    ['equal to the floor is not new', 610, 600, 600, 'flat'],
    ['big drop beats new-floor', 1000, 500, 600, 'down'],
    ['first check vs the dossier quote', 700, 600, null, 'down'],
  ])('%s', (_label, prev, next, floor, expected) => {
    expect(classifyMove(prev, next, floor)).toBe(expected);
  });
});

describe('renderWatchTable', () => {
  it('lines everyone up with a delta and a floor', () => {
    const out = renderWatchTable([
      { member: 'Devin', origin: 'JFK', today: 698, last: 650, floor: 640 },
      { member: 'Hagen', origin: 'SFO', today: 540, last: 540, floor: 540 },
      { member: 'Elliot', origin: 'LAX', today: 480, last: 511, floor: null },
      { member: 'Jeremy', origin: 'LAX', today: null, last: 524, floor: 524 },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```');
    expect(lines[1]).toMatch(/^member\s+origin\s+today\s+Δ vs last\s+floor$/);
    expect(lines[2]).toMatch(/^Devin\s+JFK\s+\$698\s+\+\$48 \(\+7%\)\s+\$640$/);
    expect(lines[3]).toMatch(/^Hagen\s+SFO\s+\$540\s+\$0\s+\$540$/);
    expect(lines[4]).toMatch(/^Elliot\s+LAX\s+\$480\s+-\$31 \(-6%\)\s+—$/);
    expect(lines[5]).toMatch(/^Jeremy\s+LAX\s+—\s+—\s+\$524$/);
    expect(lines[6]).toBe('```');
  });
});

/* ---------------------------------------------------------- the job itself */

let db: DB;
let cfg: Config;
/** origin → today's cheapest fare; the test rewrites this between days. */
let fares: Map<string, number | null>;
let searches: string[];

beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({ env: { DISCORD_TEST_CHANNEL_ID: 'test-channel', DISCORD_CHANNEL_ID: 'real-channel' } });
  searches = [];
  const ins = db.prepare(`INSERT INTO members (name, airports_json) VALUES (?, ?)`);
  for (const m of PER_MEMBER) ins.run(m.member, JSON.stringify([m.origin]));
  db.prepare(
    `INSERT INTO expeditions (id, destination, window_start, window_end, days_total, days_on_snow,
       plan_json, total_pp_usd, confidence, status, thread_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(EXP_ID, 'niseko', WINDOW[0], WINDOW[1], 9, 7, JSON.stringify(PLAN), 2340, 'high', 'watched', 'thread-1');
  setFares(1);
});

/** Scale every dossier quote by `factor`, so the per-person average moves by exactly that. */
function setFares(factor: number, overrides: Record<string, number | null> = {}) {
  fares = new Map(PER_MEMBER.map((m) => [m.origin, Math.round(m.priceUsd * factor)]));
  for (const [k, v] of Object.entries(overrides)) fares.set(k, v);
}

const deps: ExpeditionWatchDeps = {
  async searchFlights(_db, _cfg, p) {
    searches.push(`${p.origin}-${p.dest}:${p.depart}:${p.return}`);
    const price = fares.get(p.origin);
    if (price === undefined) throw new Error(`no stub for ${p.origin}`);
    const search: FlightSearch = {
      ...p,
      quotes: price === null ? [] : [quote(price)],
      cheapest: price === null ? null : quote(price),
      best: null,
      searchedAt: '',
    };
    return { value: search, cached: false, fetchedAt: '' };
  },
};

function ctx(nowIso: string): JobContext {
  const poster = new Poster(cfg, db, { dryRun: true, target: 'test', job: 'expeditionWatch' });
  return {
    cfg,
    db,
    poster,
    llm: new LlmClient(cfg, db, 'expeditionWatch'),
    dryRun: true,
    target: 'test',
    now: new Date(nowIso),
    log: log.child({ test: true }),
  };
}

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T12:00:00Z`;
const posts = () => db.prepare(`SELECT kind, summary FROM posts ORDER BY id`).all() as { kind: string; summary: string }[];
const roots = () => posts().filter((p) => p.kind === 'root');
const fareRows = () =>
  db.prepare(`SELECT checked_at, member_id, origin, price_usd FROM fare_history ORDER BY id`).all() as {
    checked_at: string;
    member_id: number | null;
    origin: string;
    price_usd: number;
  }[];
const status = () => (db.prepare(`SELECT status FROM expeditions WHERE id = ?`).get(EXP_ID) as { status: string }).status;

describe('expeditionWatch', () => {
  it('stays out of the channel on a flat series, logging every day in the thread', async () => {
    for (let d = 1; d <= 6; d++) {
      setFares(1 + (d % 2 === 0 ? 0.02 : -0.01)); // ±2% wobble, never a new floor twice
      await runExpeditionWatch(ctx(day(d)), deps);
    }
    expect(roots()).toEqual([]);
    const thread = posts().filter((p) => p.kind === 'thread');
    expect(thread).toHaveLength(6);
    expect(thread[0]!.summary).toContain(EXP_ID);
    expect(thread[0]!.summary).toContain('/pp avg');
    expect(fareRows()).toHaveLength(30); // 5 members × 6 days
    expect(searches).toHaveLength(30); // flex 0: exactly one search per itinerary per day
    expect(searches[0]).toBe(`JFK-CTS:${WINDOW[0]}:${WINDOW[1]}`);
    expect(status()).toBe('watched');
  });

  it('pings the channel once on a 12% drop, then goes quiet again', async () => {
    await runExpeditionWatch(ctx(day(1)), deps);
    await runExpeditionWatch(ctx(day(2)), deps);
    expect(roots()).toEqual([]);

    setFares(0.88);
    await runExpeditionWatch(ctx(day(3)), deps);
    expect(roots()).toHaveLength(1);
    expect(roots()[0]!.summary).toMatch(/📉 \*\*niseko-0212\*\* fares down 12%/);
    expect(roots()[0]!.summary).toContain('New floor');

    // Same price the next day: no news, but the thread still gets its row.
    await runExpeditionWatch(ctx(day(4)), deps);
    expect(roots()).toHaveLength(1);
    expect(posts().filter((p) => p.kind === 'thread')).toHaveLength(4);
  });

  it('pings on a new floor even when the day-over-day move is small', async () => {
    await runExpeditionWatch(ctx(day(1)), deps); // baseline 1.00
    setFares(1.04);
    await runExpeditionWatch(ctx(day(2)), deps); // up 4%: chatter
    setFares(1.01);
    await runExpeditionWatch(ctx(day(3)), deps); // down 3%, still above day 1: chatter
    expect(roots()).toEqual([]);
    setFares(0.98);
    await runExpeditionWatch(ctx(day(4)), deps); // down 3% and under every prior check
    expect(roots()).toHaveLength(1);
    expect(roots()[0]!.summary).toMatch(/🔻 \*\*niseko-0212\*\* new floor/);
  });

  it('pings on a 10% climb too — a fare dying is also news', async () => {
    await runExpeditionWatch(ctx(day(1)), deps);
    setFares(1.12);
    await runExpeditionWatch(ctx(day(2)), deps);
    expect(roots()).toHaveLength(1);
    expect(roots()[0]!.summary).toMatch(/📈 .* fares up 12%/);
  });

  it('measures the first check against the dossier quote', async () => {
    setFares(0.85);
    await runExpeditionWatch(ctx(day(1)), deps);
    expect(roots()).toHaveLength(1);
    expect(roots()[0]!.summary).toContain('fares down 15%');
  });

  it('keeps a move in the thread while /quiet is on', async () => {
    await runExpeditionWatch(ctx(day(1)), deps);
    kvSet(db, 'quiet_until', '2026-10-10T00:00:00Z');
    setFares(0.8);
    await runExpeditionWatch(ctx(day(2)), deps);
    expect(roots()).toEqual([]);
    expect(posts().filter((p) => p.kind === 'thread')).toHaveLength(2);
    expect(fareRows()).toHaveLength(10);
  });

  it('retires once the window has started and does nothing else', async () => {
    await runExpeditionWatch(ctx(day(1)), deps);
    const before = posts().length;
    searches = [];
    await runExpeditionWatch(ctx('2027-02-12T09:00:00Z'), deps);
    expect(status()).toBe('retired');
    expect(searches).toEqual([]);
    expect(fareRows()).toHaveLength(5); // nothing new
    const after = posts().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe('thread');
    expect(after[0]!.summary).toMatch(/window passed/);

    // Retired means retired: the next run doesn't even look at it.
    await runExpeditionWatch(ctx('2027-02-13T09:00:00Z'), deps);
    expect(posts()).toHaveLength(before + 1);
  });

  it('writes fare_history rows that resolve to members, with a null id for a stranger', async () => {
    const plan = {
      routing: { independent: { perMember: [...PER_MEMBER, { member: 'Plus-one', origin: 'DEN', priceUsd: 600 }] } },
    };
    db.prepare(`UPDATE expeditions SET plan_json = ? WHERE id = ?`).run(JSON.stringify(plan), EXP_ID);
    fares.set('DEN', 600);
    await runExpeditionWatch(ctx(day(1)), deps);
    const rows = fareRows();
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ checked_at: day(1).replace('Z', '.000Z'), member_id: 1, origin: 'JFK', price_usd: 698 });
    expect(rows[5]).toMatchObject({ member_id: null, origin: 'DEN', price_usd: 600 });
    expect(new Set(rows.map((r) => r.checked_at)).size).toBe(1);
  });

  it('skips a search that fails or returns no quote, without failing the day', async () => {
    setFares(1, { SFO: null });
    const flaky: ExpeditionWatchDeps = {
      async searchFlights(d, c, p, o) {
        if (p.origin === 'EWR') throw new Error('no cached value and offline mode is on');
        return deps.searchFlights(d, c, p, o);
      },
    };
    await runExpeditionWatch(ctx(day(1)), flaky);
    expect(fareRows().map((r) => r.origin)).toEqual(['JFK', 'LAX', 'LAX']);
    const thread = posts().filter((p) => p.kind === 'thread');
    expect(thread).toHaveLength(1);
    expect(roots()).toEqual([]); // three-of-five averages are not news against a five-person quote
  });

  it('ignores proposed and retired expeditions', async () => {
    db.prepare(`UPDATE expeditions SET status = 'proposed' WHERE id = ?`).run(EXP_ID);
    await runExpeditionWatch(ctx(day(1)), deps);
    expect(searches).toEqual([]);
    expect(posts()).toEqual([]);
  });
});
