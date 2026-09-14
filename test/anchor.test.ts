import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { kvDelete, kvSet, openDb, type DB } from '../src/db.js';
import {
  anchorKeyFor,
  DISCORD_MAX_CHARS,
  readAnchorId,
  renderAnchor,
  upsertAnchor,
  type AnchorStatus,
} from '../src/discord/anchor.js';
import { Poster } from '../src/discord/client.js';
import { log } from '../src/logger.js';

let db: DB;
let cfg: Config;

beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({
    env: { DISCORD_TEST_CHANNEL_ID: 'test-channel', DISCORD_CHANNEL_ID: 'real-channel' },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const poster = (c: Config, d: DB, job = 'anchor-test') =>
  new Poster(c, d, { dryRun: true, target: 'test', job });

const count = (kind: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE kind = ?`).get(kind) as { n: number }).n;

const ctxFor = (p: Poster) => ({ poster: p, db, cfg, log });

describe('upsertAnchor', () => {
  it('creates on the first run and edits on every run after', async () => {
    const p = poster(cfg, db);
    const first = await upsertAnchor(ctxFor(p), 'v1');
    expect(first.created).toBe(true);
    expect(count('root')).toBe(1);

    const second = await upsertAnchor(ctxFor(p), 'v2');
    const third = await upsertAnchor(ctxFor(p), 'v3');
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(count('root')).toBe(1);
    expect(count('edit')).toBe(2);
  });

  it('remembers the id in kv under the channel key', async () => {
    const p = poster(cfg, db);
    expect(anchorKeyFor(p)).toBe('anchor:test-channel');
    expect(readAnchorId(db, anchorKeyFor(p))).toBeUndefined();
    await upsertAnchor(ctxFor(p), 'hello');
    expect(readAnchorId(db, anchorKeyFor(p))).toBeTruthy();
  });

  it('survives a restart: a fresh Poster over the same db still edits', async () => {
    await upsertAnchor(ctxFor(poster(cfg, db)), 'before restart');
    await upsertAnchor(ctxFor(poster(cfg, db)), 'after restart');
    expect(count('root')).toBe(1);
    expect(count('edit')).toBe(1);
  });

  it('posts exactly one new root when the record is lost', async () => {
    const p = poster(cfg, db);
    await upsertAnchor(ctxFor(p), 'v1');
    kvDelete(db, anchorKeyFor(p));
    await upsertAnchor(ctxFor(p), 'v2');
    await upsertAnchor(ctxFor(p), 'v3');
    expect(count('root')).toBe(2);
    expect(count('edit')).toBe(1);
  });

  it('posts exactly one new root when the live message was deleted', async () => {
    const p = poster(cfg, db);
    await upsertAnchor(ctxFor(p), 'v1');
    kvSet(db, anchorKeyFor(p), '111');
    // Pretend we are online and Discord no longer knows the message.
    vi.spyOn(p, 'connected', 'get').mockReturnValue(true);
    const fetch = vi.spyOn(p, 'fetchMessage').mockResolvedValue(undefined);
    const res = await upsertAnchor(ctxFor(p), 'v2');
    expect(res.created).toBe(true);
    expect(count('root')).toBe(2);
    expect(count('edit')).toBe(0);
    expect(fetch).toHaveBeenCalledWith('111');
    expect(readAnchorId(db, anchorKeyFor(p))).not.toBe('111');
  });

  it('edits when online and the message is still there', async () => {
    const p = poster(cfg, db);
    await upsertAnchor(ctxFor(p), 'v1');
    vi.spyOn(p, 'connected', 'get').mockReturnValue(true);
    // A dry-run id is a placeholder, so swap in something that looks real.
    kvSet(db, anchorKeyFor(p), '123456789');
    vi.spyOn(p, 'fetchMessage').mockResolvedValue({ id: '123456789' } as never);
    const res = await upsertAnchor(ctxFor(p), 'v2');
    expect(res).toEqual({ messageId: '123456789', created: false });
    expect(count('root')).toBe(1);
  });

  it('returns null instead of throwing when the root budget is spent', async () => {
    const p = poster(cfg, db);
    for (let i = 0; i < cfg.discord.max_root_posts_per_day; i++) await p.postRoot(`news ${i}`);
    const res = await upsertAnchor(ctxFor(p), 'status');
    expect(res).toEqual({ messageId: null, created: false });
    expect(readAnchorId(db, anchorKeyFor(p))).toBeUndefined();
    expect(count('suppressed')).toBe(1);
  });

  it('keeps two anchors apart when given distinct keys', async () => {
    const p = poster(cfg, db);
    await upsertAnchor(ctxFor(p), 'a', { key: 'anchor:a' });
    await upsertAnchor(ctxFor(p), 'b', { key: 'anchor:b' });
    await upsertAnchor(ctxFor(p), 'a2', { key: 'anchor:a' });
    expect(count('root')).toBe(2);
    expect(count('edit')).toBe(1);
    expect(readAnchorId(db, 'anchor:a')).not.toBe(readAnchorId(db, 'anchor:b'));
  });

  it('pins on create when configured, and only then', async () => {
    const p = poster(cfg, db);
    const pin = vi.spyOn(p, 'pin').mockResolvedValue();
    await upsertAnchor(ctxFor(p), 'v1');
    await upsertAnchor(ctxFor(p), 'v2');
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it('skips pinning when the config says so', async () => {
    const quiet: Config = { ...cfg, discord: { ...cfg.discord, anchor: { pin: false } } };
    const p = poster(quiet, db);
    const pin = vi.spyOn(p, 'pin').mockResolvedValue();
    await upsertAnchor({ poster: p, db, cfg: quiet, log }, 'v1');
    expect(pin).not.toHaveBeenCalled();
  });
});

describe('renderAnchor', () => {
  const base: AnchorStatus = {
    daysOut: 47,
    baseDepthIn: 34,
    nextStorm: { day: 'Thu', cm: 22, confidence: 'high' },
    updatedAt: new Date('2026-12-08T15:00:00Z'),
  };

  it('formats the header line the way the plan describes', () => {
    const first = renderAnchor(base).split('\n')[0];
    expect(first).toBe(
      '❄️ **ASPEN** · 47 days out · 34" base · next storm Thu ~22cm (high confidence)',
    );
  });

  it('drops header segments that are unknown rather than printing blanks', () => {
    const first = renderAnchor({ daysOut: 100, updatedAt: base.updatedAt }).split('\n')[0];
    expect(first).toBe('❄️ **ASPEN** · 100 days out');
  });

  it.each([
    [1, 'tomorrow'],
    [0, 'today'],
    [-2, 'day 3 of the trip'],
  ])('counts down sensibly at daysOut=%i', (daysOut, expected) => {
    expect(renderAnchor({ ...base, daysOut }).split('\n')[0]).toContain(expected);
  });

  it('includes headline, sections and the updated stamp', () => {
    const out = renderAnchor({
      ...base,
      timezone: 'America/Denver',
      headline: 'Models agree on a Thursday refill.',
      sections: [{ title: 'Packing', body: 'Shell + midlayer, it is cold.' }],
    });
    expect(out).toContain('Models agree on a Thursday refill.');
    expect(out).toContain('**Packing**\nShell + midlayer, it is cold.');
    expect(out).toMatch(/_Updated Dec 8, 8:00 AM MST_$/);
  });

  it('never exceeds the Discord limit and marks the cut', () => {
    const out = renderAnchor({
      ...base,
      sections: [
        { title: 'Forecast', body: 'x'.repeat(900) },
        { title: 'Packing', body: 'y'.repeat(900) },
        { title: 'Arrivals', body: 'z'.repeat(900) },
        { title: 'Ground', body: 'w'.repeat(900) },
      ],
    });
    expect(out.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
    expect(out).toContain('**Forecast**\n' + 'x'.repeat(900));
    expect(out).toContain('**Packing**\n' + 'y'.repeat(900));
    // Arrivals is where the cap lands: a partial body, then the marker, and
    // nothing after it except the stamp.
    expect(out).toMatch(/\*\*Arrivals\*\*\nz+\n… _\(truncated\)_\n\n_Updated .*_$/);
    expect(out).not.toContain('**Ground**');
  });

  it('leaves short content untouched', () => {
    const out = renderAnchor({ ...base, sections: [{ title: 'T', body: 'short' }] });
    expect(out).not.toContain('truncated');
    expect(out.length).toBeLessThan(200);
  });
});
