import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { LlmClient, PRICING } from '../src/llm/client.js';

let db: DB;
let cfg: Config;
beforeEach(() => {
  db = openDb(':memory:');
  cfg = loadConfig({ env: {} });
});

describe('LlmClient', () => {
  it('resolves the fast and smart aliases from config', () => {
    const llm = new LlmClient(cfg, db, 'j');
    expect(llm.resolveModel('fast')).toBe(cfg.llm.fast_model);
    expect(llm.resolveModel('smart')).toBe(cfg.llm.smart_model);
    expect(llm.resolveModel(undefined)).toBe(cfg.llm.fast_model);
    expect(llm.resolveModel('claude-opus-4-1')).toBe('claude-opus-4-1');
  });

  it('prices usage and accumulates it for the month', () => {
    const llm = new LlmClient(cfg, db, 'aspenUpdate');
    const model = cfg.llm.fast_model;
    const price = PRICING[model]!;
    const cost = llm.recordUsage(model, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(price.input + price.output, 6);
    llm.recordUsage(model, 1_000_000, 0);
    expect(llm.spentThisMonthUsd()).toBeCloseTo(price.input * 2 + price.output, 6);
  });

  it('logs an unknown model at zero cost rather than throwing', () => {
    const llm = new LlmClient(cfg, db, 'j');
    expect(llm.recordUsage('claude-from-the-future', 1000, 1000)).toBe(0);
  });

  it('ignores usage from a previous month', () => {
    const llm = new LlmClient(cfg, db, 'j');
    llm.recordUsage(cfg.llm.fast_model, 1_000_000, 0);
    db.prepare(`UPDATE llm_usage SET at = datetime('now','-2 months')`).run();
    expect(llm.spentThisMonthUsd()).toBe(0);
  });

  it('has a price for every model the config names', () => {
    expect(PRICING[cfg.llm.fast_model]).toBeDefined();
    expect(PRICING[cfg.llm.smart_model]).toBeDefined();
  });
});
