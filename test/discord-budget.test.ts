import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { Poster } from '../src/discord/client.js';

let db: DB;
let cfg: Config;

beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({ env: { DISCORD_TEST_CHANNEL_ID: 'test-channel', DISCORD_CHANNEL_ID: 'real-channel' } });
});

const poster = (c: Config, d: DB, job = 'test-job') =>
  new Poster(c, d, { dryRun: true, target: 'test', job });

describe('root-post budget', () => {
  it('allows posts up to the cap and suppresses the rest', async () => {
    const p = poster(cfg, db);
    const cap = cfg.discord.max_root_posts_per_day;
    for (let i = 0; i < cap; i++) {
      expect((await p.postRoot(`news ${i}`)).suppressed).toBe(false);
    }
    const over = await p.postRoot('one too many');
    expect(over.suppressed).toBe(true);
    expect(over.reason).toMatch(/budget spent/);
  });

  it('lets urgent posts through anyway', async () => {
    const p = poster(cfg, db);
    for (let i = 0; i < cfg.discord.max_root_posts_per_day; i++) await p.postRoot(`news ${i}`);
    expect((await p.postRoot('flight cancelled', { urgent: true })).suppressed).toBe(false);
  });

  it('records a suppression so the budget can be tuned', async () => {
    const p = poster(cfg, db);
    for (let i = 0; i < cfg.discord.max_root_posts_per_day + 1; i++) await p.postRoot(`news ${i}`);
    const row = db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE kind = 'suppressed'`).get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('does not count edits or thread replies against the budget', async () => {
    const p = poster(cfg, db);
    for (let i = 0; i < 10; i++) {
      await p.editMessage('anchor-1', `status ${i}`);
      await p.postThread('thread-1', `fare update ${i}`);
    }
    expect(p.rootPostsToday()).toBe(0);
    expect((await p.postRoot('actual news')).suppressed).toBe(false);
  });

  it('budgets per channel, so test traffic cannot starve the real one', async () => {
    const test = new Poster(cfg, db, { dryRun: true, target: 'test', job: 'j' });
    const real = new Poster(cfg, db, { dryRun: true, target: 'real', job: 'j' });
    for (let i = 0; i < 5; i++) await test.postRoot(`noise ${i}`);
    expect(real.rootPostsToday()).toBe(0);
  });

  it('ages out of the window after 24h', async () => {
    const p = poster(cfg, db);
    await p.postRoot('yesterday');
    db.prepare(`UPDATE posts SET at = datetime('now','-2 days')`).run();
    expect(p.rootPostsToday()).toBe(0);
  });

  it('refuses to send for real without a token', async () => {
    const live = new Poster(cfg, db, { dryRun: false, target: 'test', job: 'j' });
    const saved = process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    await expect(live.connect()).rejects.toThrow(/not a dry run/);
    if (saved) process.env.DISCORD_BOT_TOKEN = saved;
  });
});

describe('threads, live', () => {
  /** A live poster whose Discord client is a stub: enough to reach the thread code paths. */
  function live(message: unknown) {
    const p = new Poster(cfg, db, { dryRun: false, target: 'test', job: 'expeditionBuild' });
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      messages: {
        fetch: async () => {
          if (message === undefined) throw new Error('Missing Access');
          return message;
        },
      },
    };
    (p as unknown as { client: unknown }).client = { channels: { fetch: async () => channel } };
    return p;
  }

  it('drops nothing silently: a live reply with no thread is recorded as suppressed', async () => {
    const r = await live({}).postThread(null, '✈️ Getting there');
    expect(r).toMatchObject({ suppressed: true, reason: 'no thread to post into' });
    const row = db.prepare(`SELECT kind, summary FROM posts`).get() as { kind: string; summary: string };
    expect(row.kind).toBe('suppressed');
    expect(row.summary).toMatch(/^no thread to post into: ✈️/);
  });

  it('names Read Message History when the bot cannot read its own post back', async () => {
    await expect(live(undefined).ensureThread('m1', 'Niseko')).rejects.toThrow(/Read Message History/);
  });

  it('names the thread permissions when Discord refuses to start one', async () => {
    const msg = {
      hasThread: false,
      startThread: async () => {
        throw new Error('Missing Permissions');
      },
    };
    await expect(live(msg).ensureThread('m1', 'Niseko')).rejects.toThrow(
      /Missing Permissions.*Create Public Threads and Send Messages in Threads/,
    );
  });
});
