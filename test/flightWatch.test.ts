import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, kvSet, type DB } from '../src/db.js';
import { Poster } from '../src/discord/client.js';
import { LlmClient } from '../src/llm/client.js';
import type { JobContext } from '../src/jobs/_runner.js';
import {
  diffStatus,
  isMilestone,
  renderFlightTable,
  runFlightWatch,
  selectFlightsToCheck,
  type FlightWatchDeps,
} from '../src/jobs/flightWatch.js';
import { flightStatus, parseAeroApi, type FlightStatus } from '../src/sources/flightStatus.js';
import { log } from '../src/logger.js';

/* ------------------------------------------------------------- fixtures */

/** Trimmed to the fields we read, but shaped like AeroAPI v4's `/flights/{ident}`
 *  answer: a through-flight with two legs plus the previous day's rotation. */
const AEROAPI_FIXTURE = {
  links: null,
  num_pages: 1,
  flights: [
    {
      ident: 'UAL1234',
      ident_iata: 'UA1234',
      ident_icao: 'UAL1234',
      status: 'Arrived / On Time',
      cancelled: false,
      diverted: false,
      scheduled_out: '2027-01-23T15:05:00Z',
      estimated_out: '2027-01-23T15:05:00Z',
      actual_out: '2027-01-23T15:07:00Z',
      scheduled_in: '2027-01-23T18:40:00Z',
      estimated_in: '2027-01-23T18:31:00Z',
      actual_in: '2027-01-23T18:31:00Z',
      departure_delay: 120,
      origin: { code: 'KSFO', code_iata: 'SFO' },
      destination: { code: 'KDEN', code_iata: 'DEN' },
      gate_origin: 'F11',
      terminal_origin: '3',
    },
    {
      ident: 'UAL1234',
      ident_iata: 'UA1234',
      ident_icao: 'UAL1234',
      status: 'Scheduled / Delayed',
      cancelled: false,
      diverted: false,
      scheduled_out: '2027-01-24T15:05:00Z',
      estimated_out: '2027-01-24T15:50:00Z',
      actual_out: null,
      scheduled_in: '2027-01-24T18:40:00Z',
      estimated_in: '2027-01-24T19:20:00Z',
      actual_in: null,
      departure_delay: 2700,
      origin: { code: 'KSFO', code_iata: 'SFO' },
      destination: { code: 'KDEN', code_iata: 'DEN' },
      gate_origin: 'F12',
      terminal_origin: '3',
    },
    {
      ident: 'UAL1234',
      ident_iata: 'UA1234',
      ident_icao: 'UAL1234',
      status: 'Scheduled',
      cancelled: false,
      diverted: false,
      scheduled_out: '2027-01-24T19:45:00Z',
      estimated_out: '2027-01-24T19:45:00Z',
      actual_out: null,
      scheduled_in: '2027-01-24T20:50:00Z',
      estimated_in: '2027-01-24T20:50:00Z',
      actual_in: null,
      departure_delay: 0,
      origin: { code: 'KDEN', code_iata: 'DEN' },
      destination: { code: 'KASE', code_iata: 'ASE' },
      gate_origin: 'B27',
      terminal_origin: null,
    },
  ],
};

describe('parseAeroApi', () => {
  it('picks the leg by origin and date and flattens it', () => {
    const s = parseAeroApi(AEROAPI_FIXTURE, { date: '2027-01-24', origin: 'SFO' });
    expect(s).toMatchObject({
      ident: 'UA1234',
      date: '2027-01-24',
      origin: 'SFO',
      dest: 'DEN',
      status: 'delayed',
      scheduledOut: '2027-01-24T15:05:00Z',
      estimatedOut: '2027-01-24T15:50:00Z',
      actualOut: null,
      scheduledIn: '2027-01-24T18:40:00Z',
      estimatedIn: '2027-01-24T19:20:00Z',
      delayMin: 45,
      gate: 'F12',
      terminal: '3',
    });
    expect('raw' in s).toBe(false);
  });

  it('distinguishes the second leg of a through-flight', () => {
    const s = parseAeroApi(AEROAPI_FIXTURE, { date: '2027-01-24', origin: 'den' });
    expect(s.origin).toBe('DEN');
    expect(s.dest).toBe('ASE');
    expect(s.status).toBe('scheduled');
    expect(s.terminal).toBeNull();
  });

  it('reads arrival from actual_in and the delay from seconds', () => {
    const s = parseAeroApi(AEROAPI_FIXTURE, { date: '2027-01-23', origin: 'SFO' });
    expect(s.status).toBe('arrived');
    expect(s.delayMin).toBe(2);
    expect(s.actualOut).toBe('2027-01-23T15:07:00Z');
  });

  it.each([
    [{ cancelled: true, status: 'Cancelled' }, 'cancelled'],
    [{ diverted: true, status: 'Diverted' }, 'diverted'],
    [{ actual_off: '2027-01-24T15:20:00Z', status: 'En Route / On Time' }, 'departed'],
    [{ departure_delay: 1800, status: 'Scheduled' }, 'delayed'],
    [{ status: 'On Time' }, 'scheduled'],
    [{ status: '' }, 'unknown'],
  ])('classifies %j as %s', (patch, expected) => {
    const base = { ...AEROAPI_FIXTURE.flights[1]!, departure_delay: 0 };
    const json = { flights: [{ ...base, ...patch }] };
    expect(parseAeroApi(json, { date: '2027-01-24', origin: 'SFO' }).status).toBe(expected);
  });

  it('tolerates a UTC date one day off for a late local departure', () => {
    const json = { flights: [{ ...AEROAPI_FIXTURE.flights[1]!, scheduled_out: '2027-01-25T05:30:00Z' }] };
    expect(parseAeroApi(json, { date: '2027-01-24', origin: 'SFO' }).scheduledOut).toBe('2027-01-25T05:30:00Z');
  });

  it('throws when nothing matches', () => {
    expect(() => parseAeroApi(AEROAPI_FIXTURE, { date: '2027-01-24', origin: 'LAX' })).toThrow(/no leg from LAX/);
    expect(() => parseAeroApi({ error: 'nope' }, { date: '2027-01-24', origin: 'SFO' })).toThrow(/no flights/);
  });

  it('keys the cache by ident, date and origin', () => {
    expect(flightStatus.key({ ident: 'ua1234', date: '2027-01-24', origin: 'sfo' })).toBe('UA1234:2027-01-24:SFO');
    expect(flightStatus.ttlMinutes({ ident: 'UA1234', date: '2027-01-24', origin: 'SFO' })).toBe(20);
  });
});

/* -------------------------------------------------------------- pure bits */

const DEP = '2027-01-24T15:00:00Z';
const at = (iso: string) => new Date(iso);
const minutesBefore = (hours: number, extraMin: number) =>
  new Date(Date.parse(DEP) - hours * 3_600_000 - extraMin * 60_000);

describe('isMilestone', () => {
  it.each([
    ['T-24h exactly', minutesBefore(24, 0), true],
    ['T-24h + 35m early', minutesBefore(24, 35), true],
    ['T-24h + 36m early', minutesBefore(24, 36), false],
    ['T-24h - 35m late', minutesBefore(24, -35), true],
    ['T-24h - 36m late', minutesBefore(24, -36), false],
    ['T-3h exactly', minutesBefore(3, 0), true],
    ['T-3h + 35m early', minutesBefore(3, 35), true],
    ['T-3h + 36m early', minutesBefore(3, 36), false],
    ['T-12h', minutesBefore(12, 0), false],
    ['departure', minutesBefore(0, 0), false],
  ])('%s → %s', (_label, now, expected) => {
    expect(isMilestone(DEP, now)).toBe(expected);
  });

  it('never fires on a garbage timestamp', () => {
    expect(isMilestone('soon', at(DEP))).toBe(false);
  });
});

describe('selectFlightsToCheck', () => {
  it('keeps yesterday through the day after tomorrow', () => {
    const rows = ['2027-01-22', '2027-01-23', '2027-01-24', '2027-01-26', '2027-01-27'].map((date) => ({ date }));
    expect(selectFlightsToCheck(rows, at('2027-01-24T10:00:00Z')).map((r) => r.date)).toEqual([
      '2027-01-23',
      '2027-01-24',
      '2027-01-26',
    ]);
  });
});

const status = (patch: Partial<FlightStatus> = {}): FlightStatus => ({
  ident: 'UA1234',
  date: '2027-01-24',
  origin: 'SFO',
  dest: 'DEN',
  status: 'scheduled',
  scheduledOut: DEP,
  estimatedOut: DEP,
  actualOut: null,
  scheduledIn: '2027-01-24T18:40:00Z',
  estimatedIn: '2027-01-24T18:40:00Z',
  delayMin: 0,
  gate: 'F12',
  terminal: '3',
  ...patch,
});

describe('diffStatus', () => {
  it('treats first sight as no news', () => {
    expect(diffStatus(null, status()).changed).toBe(false);
  });
  it('ignores a flat re-check', () => {
    expect(diffStatus(status(), status()).changed).toBe(false);
  });
  it('flags a small delay as a change but not urgent', () => {
    const d = diffStatus(status(), status({ status: 'delayed', delayMin: 20 }));
    expect(d).toMatchObject({ changed: true, urgent: false });
  });
  it('flags a 30 min delay move as urgent', () => {
    expect(diffStatus(status(), status({ status: 'delayed', delayMin: 30 })).urgent).toBe(true);
    expect(diffStatus(status({ delayMin: 50 }), status({ delayMin: 15 })).urgent).toBe(true);
  });
  it('flags cancellation and diversion as urgent', () => {
    expect(diffStatus(status(), status({ status: 'cancelled' })).urgent).toBe(true);
    expect(diffStatus(status({ status: 'departed' }), status({ status: 'diverted' })).urgent).toBe(true);
  });
  it('reports departure as a change, quietly', () => {
    expect(diffStatus(status(), status({ status: 'departed', actualOut: DEP }))).toMatchObject({
      changed: true,
      urgent: false,
    });
  });
});

describe('renderFlightTable', () => {
  it('lines everyone up in one code block', () => {
    const out = renderFlightTable([
      { member: 'Devin', flight: 'UA1234', origin: 'SFO', dest: 'DEN', status: status() },
      { member: 'Hagen', flight: 'DL9', origin: 'JFK', dest: 'ASE', status: null },
      {
        member: 'Jeremy',
        flight: 'AA100',
        origin: 'ORD',
        dest: 'ASE',
        status: status({ status: 'delayed', delayMin: 45, estimatedOut: '2027-01-24T15:45:00Z' }),
      },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```');
    expect(lines[1]).toMatch(/^member\s+flight\s+route\s+sched\s+est\s+status$/);
    expect(lines[2]).toMatch(/^Devin\s+UA1234\s+SFO→DEN\s+15:00\s+15:00\s+scheduled · gate F12$/);
    expect(lines[3]).toMatch(/^Hagen\s+DL9\s+JFK→ASE\s+--:--\s+--:--\s+no data$/);
    expect(lines[4]).toMatch(/^Jeremy\s+AA100\s+ORD→ASE\s+15:00\s+15:45\s+delayed \+45m$/);
    expect(lines[5]).toBe('```');
  });
});

/* ---------------------------------------------------------- the job itself */

const ROSTER: [string, string, string, string, string][] = [
  // member, airline, number, origin, scheduled_out
  ['Devin', 'UA', '1234', 'SFO', '2027-01-24T15:05:00Z'],
  ['Andre', 'UA', '1234', 'SFO', '2027-01-24T15:05:00Z'],
  ['Elliot', 'DL', '2210', 'SEA', '2027-01-24T16:30:00Z'],
  ['Jeremy', 'AA', '981', 'ORD', '2027-01-24T14:10:00Z'],
  ['Hagen', 'B6', '77', 'JFK', '2027-01-24T13:55:00Z'],
];

let db: DB;
let cfg: Config;
let live: Map<string, FlightStatus>;
let calls: string[];

beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({ env: { DISCORD_TEST_CHANNEL_ID: 'test-channel', DISCORD_CHANNEL_ID: 'real-channel' } });
  live = new Map();
  calls = [];
  const insMember = db.prepare(`INSERT INTO members (name, airports_json) VALUES (?, ?)`);
  const insFlight = db.prepare(
    `INSERT INTO flights (member_id, airline, number, date, origin, dest) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [name, airline, number, origin, out] of ROSTER) {
    const id = insMember.run(name, JSON.stringify([origin])).lastInsertRowid;
    insFlight.run(id, airline, number, out.slice(0, 10), origin, 'ASE');
    live.set(`${airline}${number}:${origin}`, {
      ...status({ ident: `${airline}${number}`, origin, dest: 'ASE', scheduledOut: out, estimatedOut: out }),
    });
  }
});

const deps: FlightWatchDeps = {
  async fetchStatus(p) {
    calls.push(p.ident);
    const s = live.get(`${p.ident}:${p.origin}`);
    if (!s) throw new Error(`no stub for ${p.ident}`);
    return structuredClone(s);
  },
};

function ctx(nowIso: string): JobContext {
  const poster = new Poster(cfg, db, { dryRun: true, target: 'test', job: 'flightWatch' });
  return {
    cfg,
    db,
    poster,
    llm: new LlmClient(cfg, db, 'flightWatch'),
    dryRun: true,
    target: 'test',
    now: new Date(nowIso),
    log: log.child({ test: true }),
  };
}

const posts = () => db.prepare(`SELECT kind, summary FROM posts ORDER BY id`).all() as { kind: string; summary: string }[];

describe('flightWatch', () => {
  it('posts one combined message for five flights at T-24h', async () => {
    // Devin and Andre are exactly at T-24h; the other three are outside ±35m but
    // still ride along in the one table. One window hit → one message, never five.
    await runFlightWatch(ctx('2027-01-23T15:05:00Z'), deps);
    const p = posts();
    expect(p).toHaveLength(1);
    expect(p[0]!.kind).toBe('root'); // no Aspen anchor yet, so root is the fallback
    expect(p[0]!.summary).toContain('T-24h');
    expect(calls).toHaveLength(5);
    const stored = db.prepare(`SELECT last_status, last_checked_at FROM flights`).all() as {
      last_status: string;
      last_checked_at: string;
    }[];
    expect(stored.every((r) => JSON.parse(r.last_status).status === 'scheduled')).toBe(true);
    expect(stored[0]!.last_checked_at).toBe('2027-01-23T15:05:00.000Z');
  });

  it('threads the milestone table off the Aspen anchor when one exists', async () => {
    kvSet(db, 'anchor:test', 'anchor-msg-1');
    await runFlightWatch(ctx('2027-01-23T15:05:00Z'), deps);
    expect(posts().map((p) => p.kind)).toEqual(['thread']);
  });

  it('says nothing at T-12h when nothing has changed', async () => {
    await runFlightWatch(ctx('2027-01-23T15:05:00Z'), deps); // learn scheduledOut
    calls = [];
    await runFlightWatch(ctx('2027-01-24T03:05:00Z'), deps);
    expect(posts()).toHaveLength(1);
    expect(calls).toHaveLength(5); // still polling on the travel day, just quietly
  });

  it('posts an urgent root when a flight slips 45 minutes at T-10h', async () => {
    await runFlightWatch(ctx('2027-01-23T15:05:00Z'), deps);
    // Burn the budget so only an urgent post could get through.
    const p = new Poster(cfg, db, { dryRun: true, target: 'test', job: 'other' });
    for (let i = 0; i < cfg.discord.max_root_posts_per_day; i++) await p.postRoot(`news ${i}`);
    const before = posts().length;

    live.set('AA981:ORD', {
      ...live.get('AA981:ORD')!,
      status: 'delayed',
      delayMin: 45,
      estimatedOut: '2027-01-24T14:55:00Z',
    });
    await runFlightWatch(ctx('2027-01-24T04:10:00Z'), deps);
    const after = posts().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe('root');
    expect(after[0]!.summary).toContain('Jeremy AA981');
    expect(after[0]!.summary).toContain('+45m');

    // A flat re-check an hour later stays quiet.
    await runFlightWatch(ctx('2027-01-24T05:10:00Z'), deps);
    expect(posts().slice(before)).toHaveLength(1);
  });

  it('escalates a cancellation even without a delay', async () => {
    await runFlightWatch(ctx('2027-01-23T15:05:00Z'), deps);
    live.set('B677:JFK', { ...live.get('B677:JFK')!, status: 'cancelled' });
    await runFlightWatch(ctx('2027-01-24T02:00:00Z'), deps);
    const last = posts().at(-1)!;
    expect(last.kind).toBe('root');
    expect(last.summary).toMatch(/Hagen B677: scheduled → cancelled/);
  });

  it('does not poll flights weeks out after the first sighting', async () => {
    await runFlightWatch(ctx('2027-01-01T12:00:00Z'), deps);
    expect(calls).toHaveLength(0); // outside the ±2 day date range entirely
    await runFlightWatch(ctx('2027-01-22T12:00:00Z'), deps);
    expect(calls).toHaveLength(5); // first sight: learn scheduledOut
    calls = [];
    await runFlightWatch(ctx('2027-01-22T13:00:00Z'), deps);
    expect(calls).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it('skips flights with nothing cached when offline, without failing the run', async () => {
    const flaky: FlightWatchDeps = {
      async fetchStatus(p, o) {
        if (p.ident === 'DL2210') throw new Error('no cached value and offline mode is on');
        return deps.fetchStatus(p, o);
      },
    };
    const c = ctx('2027-01-23T15:05:00Z');
    const sent = vi.spyOn(c.poster, 'postRoot');
    await runFlightWatch(c, flaky);
    expect(posts()).toHaveLength(1);
    expect(sent.mock.calls[0]![0]).toMatch(/Elliot\s+DL2210\s+SEA→ASE\s+--:--\s+--:--\s+no data/);
  });
});
