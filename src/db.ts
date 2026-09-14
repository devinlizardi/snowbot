import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './logger.js';

export type DB = Database.Database;

/** Ordered, append-only. Never edit a migration that has shipped — add one. */
const MIGRATIONS: { readonly name: string; readonly sql: string }[] = [
  {
    name: '001-initial',
    sql: `
    CREATE TABLE members (
      id            INTEGER PRIMARY KEY,
      discord_id    TEXT UNIQUE,
      name          TEXT NOT NULL UNIQUE,
      airports_json TEXT NOT NULL,
      currency      TEXT NOT NULL DEFAULT 'USD',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE flights (
      id              INTEGER PRIMARY KEY,
      member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      airline         TEXT NOT NULL,
      number          TEXT NOT NULL,
      date            TEXT NOT NULL,
      origin          TEXT NOT NULL,
      dest            TEXT NOT NULL,
      last_status     TEXT,
      last_checked_at TEXT,
      UNIQUE (member_id, airline, number, date)
    );
    CREATE INDEX flights_by_date ON flights(date);

    CREATE TABLE expeditions (
      id              TEXT PRIMARY KEY,
      destination     TEXT NOT NULL,
      window_start    TEXT NOT NULL,
      window_end      TEXT NOT NULL,
      days_total      INTEGER NOT NULL,
      days_on_snow    INTEGER NOT NULL,
      plan_json       TEXT NOT NULL,
      total_pp_usd    REAL NOT NULL,
      confidence      TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
      status          TEXT NOT NULL CHECK (status IN ('proposed','watched','retired')),
      root_message_id TEXT,
      thread_id       TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX expeditions_by_status ON expeditions(status);
    CREATE INDEX expeditions_by_dest ON expeditions(destination, created_at);

    CREATE TABLE near_misses (
      id           INTEGER PRIMARY KEY,
      destination  TEXT NOT NULL,
      window_start TEXT NOT NULL,
      total_pp_usd REAL NOT NULL,
      reason       TEXT NOT NULL,
      at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE fare_history (
      id            INTEGER PRIMARY KEY,
      expedition_id TEXT NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
      checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
      member_id     INTEGER,
      origin        TEXT NOT NULL,
      price_usd     REAL NOT NULL
    );
    CREATE INDEX fare_history_by_exp ON fare_history(expedition_id, checked_at);

    -- Generic source cache. One row per (namespace, key); value is JSON.
    CREATE TABLE source_cache (
      namespace  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
    CREATE INDEX source_cache_expiry ON source_cache(expires_at);

    -- Every message the bot sends or edits, so the root-post budget is auditable.
    CREATE TABLE posts (
      id          INTEGER PRIMARY KEY,
      job         TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      message_id  TEXT,
      kind        TEXT NOT NULL CHECK (kind IN ('root','edit','thread','suppressed')),
      dry_run     INTEGER NOT NULL DEFAULT 0,
      summary     TEXT,
      at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX posts_by_day ON posts(at, kind);

    CREATE TABLE llm_usage (
      id            INTEGER PRIMARY KEY,
      job           TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd      REAL NOT NULL,
      at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX llm_usage_by_month ON llm_usage(at);

    -- Small durable odds and ends: the anchor message id, job watermarks.
    CREATE TABLE kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE job_runs (
      id         INTEGER PRIMARY KEY,
      job        TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      ok         INTEGER,
      dry_run    INTEGER NOT NULL DEFAULT 0,
      error      TEXT
    );
    CREATE INDEX job_runs_by_job ON job_runs(job, started_at);
    `,
  },
];

export function openDb(path = process.env.SNOWBOT_DB_PATH ?? './data/snowbot.sqlite'): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database is at schema v${current} but this build only knows ${MIGRATIONS.length} migrations — ` +
        'you are running an older image against a newer database.',
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
    log.info('migration applied', { migration: m.name, version: v + 1 });
  }
  return MIGRATIONS.length;
}

/* --------------------------------------------------------------------- kv */

export function kvGet(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function kvDelete(db: DB, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}
