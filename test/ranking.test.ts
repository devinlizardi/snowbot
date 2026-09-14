import { describe, expect, it } from 'vitest';
import { loadConfig, type Destination } from '../src/config.js';
import {
  AIRFARE_PRIOR_USD,
  ceilingFor,
  estimateCostForRanking,
  logisticsEaseFor,
  rankBoard,
  scoreDestination,
  type ScoreInput,
} from '../src/ranking.js';
import type { Confidence } from '../src/sources/weather/consensus.js';

const cfg = loadConfig({ env: {} });
const W = cfg.expedition.ranking_weights;
const NOW = new Date('2026-09-14T12:00:00Z');
const by = (id: string): Destination => cfg.board.find((d) => d.id === id)!;

function input(
  dest: Destination,
  over: Partial<Omit<ScoreInput, 'dest' | 'snow'>> & { cm?: number; conf?: Confidence } = {},
): ScoreInput {
  const { cm = 40, conf = 'medium', ...rest } = over;
  return {
    dest,
    snow: { forecast10dCm: cm, confidence: conf },
    observed7dCm: 20,
    estCostPp: estimateCostForRanking(dest),
    ceilingUsd: ceilingFor(dest, cfg),
    logisticsEase: logisticsEaseFor(dest),
    ...rest,
  };
}

describe('scoreDestination', () => {
  it.each<[string, number, Confidence, number]>([
    ['nothing forecast', 0, 'low', 0],
    ['a disputed dusting', 20, 'low', 0.2 * 0.4],
    ['a moderate storm the models agree on', 60, 'high', 0.6],
    ['a big one, medium', 100, 'medium', 0.7],
    ['off the top of the reference, still capped', 250, 'high', 1],
  ])('snow term — %s', (_label, cm, conf, expectedSnowTerm) => {
    const i = input(by('niseko'), { cm, conf, observed7dCm: 0, estCostPp: 2600, logisticsEase: 0 });
    // Only the snow term is live: observed 0, cost at the ceiling, logistics 0.
    expect(scoreDestination(i, W)).toBeCloseTo(
      W.forecast_snow_10d_confidence_weighted * expectedSnowTerm,
      3,
    );
  });

  it('an agreeing moderate forecast beats a disputed big one', () => {
    const agreed = scoreDestination(input(by('niseko'), { cm: 60, conf: 'high' }), W);
    const disputed = scoreDestination(input(by('niseko'), { cm: 120, conf: 'low' }), W);
    expect(agreed).toBeGreaterThan(disputed);
  });

  it('weights every term as PLAN §5 says', () => {
    const i = input(by('whistler'), {
      cm: 50,
      conf: 'high',
      observed7dCm: 35,
      estCostPp: 1300,
      ceilingUsd: 2600,
      logisticsEase: 0.9,
    });
    const expected = 0.45 * 0.5 + 0.2 * 0.5 + 0.2 * 0.5 + 0.15 * 0.9;
    expect(scoreDestination(i, W)).toBeCloseTo(expected, 3);
  });

  it('clips a cost above the ceiling to zero rather than going negative', () => {
    const cheap = input(by('jackson'), { estCostPp: 1000, ceilingUsd: 1400 });
    const pricey = input(by('jackson'), { estCostPp: 3000, ceilingUsd: 1400 });
    expect(scoreDestination(pricey, W)).toBeLessThan(scoreDestination(cheap, W));
    expect(scoreDestination(pricey, W)).toBeCloseTo(
      scoreDestination(input(by('jackson'), { estCostPp: 1400, ceilingUsd: 1400 }), W),
      6,
    );
  });
});

describe('logisticsEaseFor / estimateCostForRanking', () => {
  it.each([
    ['whistler', 0.9], // coach
    ['zermatt', 0.9], // train
    ['jackson', 0.9], // shuttle
    ['revelstoke', 0.6], // rental car
    ['nozawa', 0.5], // shinkansen + bus
  ])('%s → %s', (id, ease) => {
    expect(logisticsEaseFor(by(id))).toBe(ease);
  });

  it('is the lodging band midpoint for the ideal trip plus the regional prior', () => {
    // Niseko: (110+160)/2 × 9 nights + JP prior.
    expect(estimateCostForRanking(by('niseko'))).toBe(135 * 9 + AIRFARE_PRIOR_USD.JP);
    expect(estimateCostForRanking(by('jackson'))).toBe(180 * 5 + AIRFARE_PRIOR_USD.US);
  });
});

describe('rankBoard', () => {
  const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 86_400_000).toISOString();

  it('orders by score with the snowiest agreeing forecast first', () => {
    const r = rankBoard(
      [
        input(by('niseko'), { cm: 90, conf: 'high' }),
        input(by('whistler'), { cm: 30, conf: 'medium' }),
        input(by('jackson'), { cm: 10, conf: 'low' }),
      ],
      cfg,
      [],
      NOW,
    );
    expect(r.ranked.map((x) => x.dest.id)).toEqual(['niseko', 'whistler', 'jackson']);
    expect(r.ranked[0]!.reasons[0]).toBe('90cm forecast over 10 days, high confidence');
    expect(r.nearMisses).toEqual([]);
  });

  it('excludes a destination built 2 weeks ago and admits one built 5 weeks ago', () => {
    const r = rankBoard(
      [input(by('niseko'), { cm: 90, conf: 'high' }), input(by('whistler'))],
      cfg,
      [
        { destination: 'niseko', createdAt: weeksAgo(2) },
        { destination: 'whistler', createdAt: weeksAgo(5) },
      ],
      NOW,
    );
    expect(r.ranked.map((x) => x.dest.id)).toEqual(['whistler']);
    expect(r.cooledDown.map((c) => c.dest.id)).toEqual(['niseko']);
  });

  it('reads SQLite timestamps as UTC when judging the cooldown', () => {
    // 27 days ago in SQLite's format is inside a 4-week cooldown whatever the host zone.
    const at = new Date(NOW.getTime() - 27 * 86_400_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const r = rankBoard(
      [input(by('niseko'))],
      cfg,
      [{ destination: 'niseko', createdAt: at }],
      NOW,
    );
    expect(r.ranked).toEqual([]);
    expect(r.cooledDown).toHaveLength(1);
  });

  it('returns anything over the ceiling as a near miss, and ignores the ceiling when told to', () => {
    const cands = [
      input(by('niseko'), { estCostPp: 2900 }),
      input(by('jackson'), { estCostPp: 1200 }),
    ];
    const r = rankBoard(cands, cfg, [], NOW);
    expect(r.ranked.map((x) => x.dest.id)).toEqual(['jackson']);
    expect(r.nearMisses).toHaveLength(1);
    expect(r.nearMisses[0]).toMatchObject({ estCostPp: 2900, ceilingUsd: 2600 });
    expect(r.nearMisses[0]!.reason).toMatch(/\$2900\/pp over the \$2600 ceiling/);

    const forced = rankBoard(cands, cfg, [], NOW, { ignoreCeiling: true });
    expect(forced.ranked).toHaveLength(2);
    expect(forced.nearMisses).toEqual([]);
  });

  it('the real board all sits under its ceilings on the priors alone', () => {
    const r = rankBoard(
      cfg.board.map((d) => input(d)),
      cfg,
      [],
      NOW,
    );
    expect(r.nearMisses).toEqual([]);
    expect(r.ranked).toHaveLength(cfg.board.length);
  });
});
