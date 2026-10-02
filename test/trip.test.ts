import { beforeEach, describe, expect, it } from 'vitest';
import { kvSet, openDb, type DB } from '../src/db.js';
import { KV_LAST_BRIEFING, KV_LAST_STATUS } from '../src/jobs/aspenUpdate.js';
import { tripText } from '../src/serve.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('tripText (/trip)', () => {
  it('echoes the rendered status, never the JSON change-detection snapshot', () => {
    kvSet(db, KV_LAST_BRIEFING, JSON.stringify({ cadence: 'monthly', totalCm: null }));
    kvSet(db, KV_LAST_STATUS, '❄️ **ASPEN** · 47 days out');
    expect(tripText(db)).toBe('❄️ **ASPEN** · 47 days out');
  });

  it('says nothing rather than dumping the snapshot when no status text exists yet', () => {
    kvSet(db, KV_LAST_BRIEFING, JSON.stringify({ cadence: 'monthly', totalCm: null }));
    expect(tripText(db)).toBeUndefined();
  });
});
