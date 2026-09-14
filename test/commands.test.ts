import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { kvGet, openDb, type DB } from '../src/db.js';
import { COMMANDS, handle, isQuiet, type CommandContext } from '../src/discord/commands.js';

let db: DB;
let cfg: Config;
const NOW = new Date('2026-12-01T12:00:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({ env: {} });
});

const ctxFor = (id: string, name: string, now = NOW): CommandContext => ({
  db,
  cfg,
  now,
  user: { id, name },
});
const devin = () => ctxFor('u-devin', 'devin');
const andre = () => ctxFor('u-andre', 'Andre');
const stranger = () => ctxFor('u-999', 'Randy');

const insertExpedition = (id: string, status: 'proposed' | 'watched' | 'retired') =>
  db
    .prepare(
      `INSERT INTO expeditions (id, destination, window_start, window_end, days_total, days_on_snow,
         plan_json, total_pp_usd, confidence, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, 'niseko', '2027-02-12', '2027-02-20', 9, 7, '{}', 2340, 'high', status);

const airportsOf = (discordId: string): string[] =>
  JSON.parse(
    (
      db.prepare('SELECT airports_json FROM members WHERE discord_id = ?').get(discordId) as {
        airports_json: string;
      }
    ).airports_json,
  ) as string[];

describe('definitions', () => {
  it('declares every command PLAN.md §1C lists', () => {
    const names = COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual([
      'airports',
      'build',
      'flight',
      'join',
      'quiet',
      'trip',
      'unwatch',
      'watch',
    ]);
    for (const c of COMMANDS) expect(() => c.toJSON()).not.toThrow();
  });
});

describe('/join', () => {
  it('creates a member seeded from config, matching the name case-insensitively', async () => {
    const r = await handle('join', null, {}, devin());
    expect(r.reply).toMatch(/JFK, LGA, EWR/);
    const row = db.prepare('SELECT name, discord_id FROM members').get() as {
      name: string;
      discord_id: string;
    };
    expect(row).toEqual({ name: 'Devin', discord_id: 'u-devin' });
    expect(airportsOf('u-devin')).toEqual(['JFK', 'LGA', 'EWR']);
  });

  it('gives a stranger an empty airport list', async () => {
    await handle('join', null, {}, stranger());
    expect(airportsOf('u-999')).toEqual([]);
  });

  it('is idempotent and never resets curated airports', async () => {
    await handle('join', null, {}, devin());
    await handle('airports', 'remove', { iata: 'LGA' }, devin());
    const r = await handle('join', null, {}, devin());
    expect(r.reply).toMatch(/already on the roster/);
    expect(airportsOf('u-devin')).toEqual(['JFK', 'EWR']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n).toBe(1);
  });

  it('claims a pre-seeded row that has no discord id', async () => {
    db.prepare(`INSERT INTO members (name, airports_json) VALUES ('Andre', '["EWR"]')`).run();
    await handle('join', null, {}, andre());
    expect(airportsOf('u-andre')).toEqual(['EWR']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n).toBe(1);
  });
});

describe('/airports', () => {
  beforeEach(async () => {
    await handle('join', null, {}, devin());
  });

  it('adds, uppercasing the input', async () => {
    const r = await handle('airports', 'add', { iata: 'hpn' }, devin());
    expect(r.reply).toMatch(/Added HPN/);
    expect(airportsOf('u-devin')).toEqual(['JFK', 'LGA', 'EWR', 'HPN']);
  });

  it('removes', async () => {
    await handle('airports', 'remove', { iata: 'LGA' }, devin());
    expect(airportsOf('u-devin')).toEqual(['JFK', 'EWR']);
  });

  it.each(['JFKX', 'jf', '12A', ''])('rejects the invalid code %j', async (bad) => {
    const r = await handle('airports', 'add', { iata: bad }, devin());
    expect(r.ephemeral).toBe(true);
    expect(r.reply).toMatch(/3-letter IATA/);
    expect(airportsOf('u-devin')).toEqual(['JFK', 'LGA', 'EWR']);
  });

  it('refuses duplicates and missing removals politely', async () => {
    expect((await handle('airports', 'add', { iata: 'JFK' }, devin())).reply).toMatch(/already/);
    expect((await handle('airports', 'remove', { iata: 'SFO' }, devin())).reply).toMatch(
      /isn't on your list/,
    );
  });

  it('lists', async () => {
    expect((await handle('airports', 'list', {}, devin())).reply).toMatch(/JFK, LGA, EWR/);
  });

  it('requires a roster entry', async () => {
    const r = await handle('airports', 'add', { iata: 'SFO' }, stranger());
    expect(r.reply).toMatch(/\/join/);
  });
});

describe('/flight', () => {
  const ua = { airline: 'ua', number: '1234', date: '2027-01-24', origin: 'jfk', dest: 'ase' };

  it('refuses to add before /join', async () => {
    const r = await handle('flight', 'add', ua, devin());
    expect(r.ephemeral).toBe(true);
    expect(r.reply).toMatch(/\/join/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM flights').get() as { n: number }).n).toBe(0);
  });

  it('adds, lists and removes', async () => {
    await handle('join', null, {}, devin());
    await handle('join', null, {}, andre());
    const add = await handle('flight', 'add', ua, devin());
    expect(add.reply).toMatch(/UA1234 JFK→ASE on 2027-01-24/);
    await handle(
      'flight',
      'add',
      { ...ua, airline: 'DL', number: '88', origin: 'EWR', date: '2027-01-23' },
      andre(),
    );

    const list = await handle('flight', 'list', {}, stranger());
    expect(list.reply).toContain('Andre');
    expect(list.reply).toContain('DL88');
    expect(list.reply).toContain('UA1234');
    expect(list.reply.indexOf('DL88')).toBeLessThan(list.reply.indexOf('UA1234'));

    const id = (db.prepare(`SELECT id FROM flights WHERE airline = 'UA'`).get() as { id: number })
      .id;
    const rm = await handle('flight', 'remove', { id }, devin());
    expect(rm.reply).toMatch(/Removed UA1234/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM flights').get() as { n: number }).n).toBe(1);
  });

  it("won't remove someone else's flight", async () => {
    await handle('join', null, {}, devin());
    await handle('join', null, {}, andre());
    await handle('flight', 'add', ua, devin());
    const id = (db.prepare('SELECT id FROM flights').get() as { id: number }).id;
    const r = await handle('flight', 'remove', { id }, andre());
    expect(r.reply).toMatch(/isn't yours/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM flights').get() as { n: number }).n).toBe(1);
    expect((await handle('flight', 'remove', { id: 999 }, andre())).reply).toMatch(/No flight/);
  });

  it('hides flights that already departed from the list', async () => {
    await handle('join', null, {}, devin());
    await handle('flight', 'add', ua, devin());
    const later = ctxFor('u-devin', 'devin', new Date('2027-02-01T00:00:00Z'));
    expect((await handle('flight', 'list', {}, later)).reply).toMatch(/No upcoming flights/);
  });

  it.each([
    [{ date: '2027-02-30' }, /YYYY-MM-DD/],
    [{ date: '01/24/2027' }, /YYYY-MM-DD/],
    [{ date: '2026-01-01' }, /in the past/],
    [{ origin: 'NYC1' }, /Origin should be/],
    [{ airline: 'UNITED' }, /Airline should be/],
    [{ number: 'abc' }, /digits only/],
  ])('validates %j', async (bad, msg) => {
    await handle('join', null, {}, devin());
    const r = await handle('flight', 'add', { ...ua, ...bad }, devin());
    expect(r.ephemeral).toBe(true);
    expect(r.reply).toMatch(msg);
  });

  it('rejects a duplicate flight with a friendly message', async () => {
    await handle('join', null, {}, devin());
    await handle('flight', 'add', ua, devin());
    const r = await handle('flight', 'add', ua, devin());
    expect(r.reply).toMatch(/already on your list/);
  });
});

describe('/watch and /unwatch', () => {
  const status = (id: string) =>
    (db.prepare('SELECT status FROM expeditions WHERE id = ?').get(id) as { status: string })
      .status;

  it('moves proposed → watched → proposed', async () => {
    insertExpedition('niseko-0212', 'proposed');
    const w = await handle('watch', null, { id: 'niseko-0212' }, devin());
    expect(w.reply).toMatch(/Watching/);
    expect(status('niseko-0212')).toBe('watched');
    const u = await handle('unwatch', null, { id: 'niseko-0212' }, devin());
    expect(u.reply).toMatch(/Stopped/);
    expect(status('niseko-0212')).toBe('proposed');
  });

  it('explains why a transition is refused', async () => {
    insertExpedition('old', 'retired');
    insertExpedition('w', 'watched');
    expect((await handle('watch', null, { id: 'nope' }, devin())).reply).toMatch(/No expedition/);
    expect((await handle('watch', null, { id: 'old' }, devin())).reply).toMatch(
      /window has passed/,
    );
    expect((await handle('watch', null, { id: 'w' }, devin())).reply).toMatch(/already watched/);
    expect((await handle('unwatch', null, { id: 'old' }, devin())).reply).toMatch(
      /window has passed/,
    );
    expect(status('old')).toBe('retired');
    expect(status('w')).toBe('watched');
  });
});

describe('/quiet', () => {
  it('writes quiet_until and isQuiet respects the clock', async () => {
    expect(isQuiet(db, NOW)).toBe(false);
    const r = await handle('quiet', null, { days: 3 }, devin());
    expect(r.reply).toMatch(/2026-12-04/);
    expect(kvGet(db, 'quiet_until')).toBe('2026-12-04T12:00:00.000Z');
    expect(isQuiet(db, NOW)).toBe(true);
    expect(isQuiet(db, new Date('2026-12-04T11:59:00Z'))).toBe(true);
    expect(isQuiet(db, new Date('2026-12-04T12:00:00Z'))).toBe(false);
  });

  it.each([
    [0, 1],
    [-4, 1],
    [90, 30],
    ['7', 7],
  ])('clamps %j days to %i', async (input, expected) => {
    await handle('quiet', null, { days: input }, devin());
    const until = new Date(kvGet(db, 'quiet_until')!);
    expect((until.getTime() - NOW.getTime()) / 86_400_000).toBe(expected);
  });

  it('fails open on a garbage value', () => {
    db.prepare(`INSERT INTO kv (key, value) VALUES ('quiet_until', 'whenever')`).run();
    expect(isQuiet(db, NOW)).toBe(false);
  });
});

describe('/build', () => {
  it('returns the build action with parsed options', async () => {
    const r = await handle('build', null, { destination: 'Niseko', month: '2027-02' }, devin());
    expect(r.action).toEqual({ kind: 'build', destination: 'niseko', month: '2027-02' });
    expect(r.ephemeral).toBeFalsy();
  });

  it('omits options that were not given', async () => {
    const r = await handle('build', null, {}, devin());
    expect(r.action).toEqual({ kind: 'build' });
  });

  it('rejects an unknown destination or a malformed month without an action', async () => {
    const bad = await handle('build', null, { destination: 'narnia' }, devin());
    expect(bad.action).toBeUndefined();
    expect(bad.reply).toMatch(/isn't on the board/);
    const badMonth = await handle('build', null, { month: 'Feb' }, devin());
    expect(badMonth.action).toBeUndefined();
    expect(badMonth.reply).toMatch(/YYYY-MM/);
  });
});

describe('/trip', () => {
  it('falls back to the trip action when nothing is stored', async () => {
    const r = await handle('trip', null, {}, devin());
    expect(r).toEqual({ reply: 'no status yet', action: { kind: 'trip' } });
  });

  it('echoes the most recent anchor content, skipping bare message ids', async () => {
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('anchor:test', '123456789012345678', '2026-12-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('anchor:content', '❄️ ASPEN · 54 days out', '2026-11-30T00:00:00Z')`,
    ).run();
    const r = await handle('trip', null, {}, devin());
    expect(r.reply).toBe('❄️ ASPEN · 54 days out');
    expect(r.action).toEqual({ kind: 'trip' });
  });
});

describe('unknown', () => {
  it('replies ephemerally to an unknown command', async () => {
    const r = await handle('nope', null, {}, devin());
    expect(r.ephemeral).toBe(true);
  });
});
