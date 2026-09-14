import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import { requireSecret } from '../config.js';
import type { DB } from '../db.js';
import { log } from '../logger.js';

/** USD per million tokens. Verified against the console in Packet 15; if a
 *  model is missing here the call still runs, it just logs zero cost loudly. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
};

/** Server-side web search is billed per search on top of tokens. */
export const WEB_SEARCH_USD_PER_1000 = 10;

/** Anthropic's hosted web search tool. `max_uses` caps searches per call so a
 *  single fuzzy lookup can't quietly burn a dollar. */
export const WEB_SEARCH_TOOL: Anthropic.Messages.WebSearchTool20250305 = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
};

export type CompleteOptions = {
  model?: 'fast' | 'smart' | (string & {});
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Anthropic server-side tools, e.g. web search for Packet 6. */
  tools?: Anthropic.Messages.ToolUnion[];
};

export class LlmClient {
  private sdk: Anthropic | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly db: DB,
    private readonly job: string,
  ) {}

  private client(): Anthropic {
    this.sdk ??= new Anthropic({ apiKey: requireSecret('ANTHROPIC_API_KEY') });
    return this.sdk;
  }

  resolveModel(m: CompleteOptions['model']): string {
    if (m === 'smart') return this.cfg.llm.smart_model;
    if (m === 'fast' || m === undefined) return this.cfg.llm.fast_model;
    return m;
  }

  /** USD spent this calendar month across every job. */
  spentThisMonthUsd(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage WHERE at >= datetime('now','start of month')`)
      .get() as { total: number };
    return row.total;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const model = this.resolveModel(opts.model);

    const spent = this.spentThisMonthUsd();
    if (spent >= this.cfg.llm.monthly_usd_cap) {
      throw new Error(
        `LLM monthly cap reached ($${spent.toFixed(2)} of $${this.cfg.llm.monthly_usd_cap}) — ` +
          'raise llm.monthly_usd_cap in config.yaml if this is expected.',
      );
    }

    const res = await this.client().messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    this.recordUsage(
      model,
      res.usage.input_tokens,
      res.usage.output_tokens,
      res.usage.server_tool_use?.web_search_requests ?? 0,
    );

    return res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  recordUsage(model: string, inputTokens: number, outputTokens: number, webSearches = 0): number {
    const price = PRICING[model];
    if (!price) log.warn('no pricing entry for model, cost logged as 0', { model });
    const tokenCost = price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : 0;
    const cost = tokenCost + (webSearches * WEB_SEARCH_USD_PER_1000) / 1000;
    this.db
      .prepare(
        `INSERT INTO llm_usage (job, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.job, model, inputTokens, outputTokens, cost);
    log.debug('llm usage', { job: this.job, model, inputTokens, outputTokens, webSearches, cost });
    return cost;
  }
}
