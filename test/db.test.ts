import { beforeEach, describe, expect, it } from 'vitest';
import { kvDelete, kvGet, kvSet, migrate, openDb, type DB } from '../src/db.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('migrations', () => {
  it('creates every table on a fresh database', () => {
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      'members',
      'flights',
      'expeditions',
      'near_misses',
      'fare_history',
      'source_cache',
      'posts',
      'llm_usage',
      'kv',
      'job_runs',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent', () => {
    const v = db.pragma('user_version', { simple: true });
    expect(migrate(db)).toBeGreaterThan(0);
    expect(db.pragma('user_version', { simple: true })).toBe(v);
  });

  it('refuses to run against a newer schema than it knows', () => {
    db.pragma('user_version = 99');
    expect(() => migrate(db)).toThrow(/older image against a newer database/);
  });
});

describe('constraints', () => {
  it('enforces the confidence and status enums on expeditions', () => {
    const insert = (confidence: string, status: string) =>
      db
        .prepare(
          `INSERT INTO expeditions (id, destination, window_start, window_end, days_total,
             days_on_snow, plan_json, total_pp_usd, confidence, status)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(`${confidence}-${status}`, 'niseko', '2027-02-12', '2027-02-20', 9, 7, '{}', 2340, confidence, status);
    expect(() => insert('high', 'proposed')).not.toThrow();
    expect(() => insert('certain', 'proposed')).toThrow();
    expect(() => insert('high', 'booked')).toThrow();
  });

  it('cascades fare_history when an expedition is deleted', () => {
    db.prepare(
      `INSERT INTO expeditions (id, destination, window_start, window_end, days_total,
         days_on_snow, plan_json, total_pp_usd, confidence, status)
       VALUES ('x','niseko','2027-02-12','2027-02-20',9,7,'{}',2340,'high','watched')`,
    ).run();
    db.prepare(`INSERT INTO fare_history (expedition_id, origin, price_usd) VALUES ('x','JFK',698)`).run();
    db.prepare(`DELETE FROM expeditions WHERE id = 'x'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fare_history`).get()).toEqual({ n: 0 });
  });
});

describe('kv', () => {
  it('round-trips, overwrites and deletes', () => {
    expect(kvGet(db, 'anchor')).toBeUndefined();
    kvSet(db, 'anchor', '111');
    expect(kvGet(db, 'anchor')).toBe('111');
    kvSet(db, 'anchor', '222');
    expect(kvGet(db, 'anchor')).toBe('222');
    kvDelete(db, 'anchor');
    expect(kvGet(db, 'anchor')).toBeUndefined();
  });
});
