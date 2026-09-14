import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { LlmClient, PRICING, WEB_SEARCH_TOOL, WEB_SEARCH_USD_PER_1000 } from '../src/llm/client.js';

describe('web search cost accounting', () => {
  it('adds $10 per 1,000 searches on top of token cost', () => {
    const cfg = loadConfig({ env: {} });
    const llm = new LlmClient(cfg, openDb(':memory:'), 'lookup');
    const model = cfg.llm.smart_model;
    const price = PRICING[model]!;
    const tokensOnly = llm.recordUsage(model, 1000, 500);
    expect(tokensOnly).toBeCloseTo((1000 * price.input + 500 * price.output) / 1_000_000, 9);
    const withSearch = llm.recordUsage(model, 1000, 500, 5);
    expect(withSearch - tokensOnly).toBeCloseTo((5 * WEB_SEARCH_USD_PER_1000) / 1000, 9);
    expect(llm.spentThisMonthUsd()).toBeCloseTo(tokensOnly + withSearch, 9);
  });

  it('still bills searches for a model with no token pricing', () => {
    const cfg = loadConfig({ env: {} });
    const llm = new LlmClient(cfg, openDb(':memory:'), 'lookup');
    expect(llm.recordUsage('claude-from-the-future', 1, 1, 1000)).toBe(WEB_SEARCH_USD_PER_1000);
  });

  it('describes the hosted web search tool with a per-call cap', () => {
    expect(WEB_SEARCH_TOOL).toEqual({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    });
  });
});
