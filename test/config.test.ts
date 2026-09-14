import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepMerge, loadConfig, requireSecret } from '../src/config.js';

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays wholesale', () => {
    const base = { a: 1, nest: { x: 1, y: 2 }, list: [1, 2, 3] };
    const out = deepMerge(base, { nest: { y: 9 }, list: [7] });
    expect(out).toEqual({ a: 1, nest: { x: 1, y: 9 }, list: [7] });
  });
});

describe('loadConfig', () => {
  it('loads the real config.yaml and resolves env indirection', () => {
    const cfg = loadConfig({
      env: {
        DISCORD_TEST_GUILD_ID: 'tg',
        DISCORD_TEST_CHANNEL_ID: 'tc',
        DISCORD_GUILD_ID: 'rg',
        DISCORD_CHANNEL_ID: 'rc',
        GCP_PROJECT_ID: 'proj',
        GCP_DATASET_ID: 'weathernext_3',
        DISCORD_USER_DEVIN: '123',
      },
    });
    expect(cfg.members).toHaveLength(5);
    expect(cfg.channels.test).toEqual({ guildId: 'tg', channelId: 'tc' });
    expect(cfg.channels.real).toEqual({ guildId: 'rg', channelId: 'rc' });
    expect(cfg.bigquery).toEqual({
      projectId: 'proj',
      datasetId: 'weathernext_3',
      table: 'weathernext_3_0_0_0p1deg',
    });
    expect(cfg.members.find((m) => m.name === 'Devin')?.discordId).toBe('123');
  });

  it('prices both of Elliot and Jeremy airports and only the first for everyone else', () => {
    const cfg = loadConfig({ env: {} });
    const by = (n: string) => cfg.members.find((m) => m.name === n)!;
    expect(by('Elliot').pricedAirports).toEqual(['BUR', 'LAX']);
    expect(by('Jeremy').pricedAirports).toEqual(['SNA', 'LAX']);
    expect(by('Devin').pricedAirports).toEqual(['JFK']);
    expect(by('Hagen').pricedAirports).toEqual(['SFO']);
  });

  it('models Aspen as two distinct points with the summit above the base', () => {
    const cfg = loadConfig({ env: {} });
    expect(cfg.aspen.summit.elevation_m).toBeGreaterThan(cfg.aspen.base.elevation_m);
    // The two points must actually be different places, or "summit forecast"
    // is just the base forecast with a different label.
    expect(cfg.aspen.summit.lat).not.toBe(cfg.aspen.base.lat);
    expect(cfg.aspen.summit.lon).not.toBe(cfg.aspen.base.lon);
  });

  it('rejects a summit that is not above the base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snowbot-cfg-'));
    const local = join(dir, 'config.local.yaml');
    writeFileSync(local, 'aspen:\n  summit:\n    elevation_m: 100\n');
    expect(() => loadConfig({ localPath: local, env: {} })).toThrow(/summit is not above base/);
  });

  it('keeps the board internally consistent', () => {
    const cfg = loadConfig({ env: {} });
    for (const d of cfg.board) {
      expect(d.min_days).toBeLessThanOrEqual(d.ideal_days);
      expect(d.summit_elevation_m).toBeGreaterThan(d.base_elevation_m);
      const [lo, hi] = d.lodging_band_usd_pp_night;
      expect(lo).toBeLessThan(hi);
    }
    expect(new Set(cfg.board.map((d) => d.id)).size).toBe(cfg.board.length);
  });

  it('applies config.local.yaml over the base file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snowbot-cfg-'));
    const local = join(dir, 'config.local.yaml');
    writeFileSync(local, 'discord:\n  max_root_posts_per_day: 9\n');
    const cfg = loadConfig({ localPath: local, env: {} });
    expect(cfg.discord.max_root_posts_per_day).toBe(9);
  });

  it('rejects ranking weights that do not sum to 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snowbot-cfg-'));
    const local = join(dir, 'config.local.yaml');
    writeFileSync(local, 'expedition:\n  ranking_weights:\n    cost: 0.9\n');
    expect(() => loadConfig({ localPath: local, env: {} })).toThrow(/weights must sum to 1/);
  });
});

describe('requireSecret', () => {
  it('names the missing variable', () => {
    expect(() => requireSecret('NOPE', {})).toThrow(/NOPE/);
  });
});
