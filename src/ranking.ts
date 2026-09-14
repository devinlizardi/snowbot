import type { Config, Destination } from './config.js';
import type { Confidence } from './sources/weather/consensus.js';

/**
 * Destination ranking, PLAN.md §5:
 *
 *   0.45 · forecast_snow_10d (confidence-weighted)
 * + 0.20 · observed_snow_7d
 * + 0.20 · (1 − est_cost_pp / ceiling)
 * + 0.15 · logistics_ease
 *
 * Every term is clipped to [0, 1] before it is weighted, so a monster forecast
 * cannot buy its way past a bad price and a cheap trip with no snow still
 * scores as a trip with no snow. Hard filters (ceiling, cooldown) are applied
 * in `rankBoard` before scoring — a filtered destination has no score, only a
 * reason.
 *
 * Pure: the board, the weather numbers and the clock are all handed in.
 */

export type Weights = Config['expedition']['ranking_weights'];

export type SnowSignal = {
  /** Mean of the modelled 10-day totals at the base, cm. */
  forecast10dCm: number;
  confidence: Confidence;
};

export type ScoreInput = {
  dest: Destination;
  snow: SnowSignal;
  /** Trailing seven days at the base, cm. */
  observed7dCm: number;
  /** A ranking estimate, never a quote — see `AIRFARE_PRIOR_USD`. */
  estCostPp: number;
  ceilingUsd: number;
  /** 0–1; see `logisticsEaseFor`. */
  logisticsEase: number;
};

export type Ranked = {
  dest: Destination;
  score: number;
  reasons: string[];
};

export type NearMiss = {
  dest: Destination;
  estCostPp: number;
  ceilingUsd: number;
  reason: string;
};

export type RankResult = {
  /** Best first. */
  ranked: Ranked[];
  /** Filtered out by the ceiling; the job writes these to `near_misses`. */
  nearMisses: NearMiss[];
  /** Filtered out by the cooldown; logged, not persisted. */
  cooledDown: { dest: Destination; lastBuiltAt: string }[];
};

/** A low-confidence forecast is worth less than half a high-confidence one. */
export const CONFIDENCE_WEIGHT: Record<Confidence, number> = { high: 1, medium: 0.7, low: 0.4 };

/** 100cm in ten days is a full score; anything more is still a full score. */
export const SNOW_REFERENCE_CM = 100;
/** Same daily rate over the trailing week. */
export const OBSERVED_REFERENCE_CM = 70;

/**
 * Round-trip airfare priors by region, USD per person. These exist only so
 * the pre-rank can put a rough number against the ceiling before any SerpApi
 * search is spent; they are never quoted to the group and never reach a
 * dossier — the built Expedition carries real fares.
 */
export const AIRFARE_PRIOR_USD: Record<Destination['region'], number> = {
  JP: 950,
  EU: 800,
  CA: 550,
  US: 450,
};

/**
 * How much friction the ground leg adds, read off the board's one-line hint.
 * A scheduled coach or train the group boards together is easy; a rental car
 * means someone drives three hours in the snow; a multi-leg journey means a
 * missed connection somewhere.
 */
export function logisticsEaseFor(dest: Pick<Destination, 'ground'>): number {
  const g = dest.ground.toLowerCase();
  if (/\+|then|transfer at|change at/.test(g)) return 0.5;
  if (/rental car|drive/.test(g)) return 0.6;
  if (/shuttle|bus|coach|train|shinkansen|airporter|transfer/.test(g)) return 0.9;
  return 0.7;
}

/** Ranking-only cost estimate: the board's lodging band midpoint for the
 *  ideal trip, plus the regional airfare prior. */
export function estimateCostForRanking(dest: Destination): number {
  const [lo, hi] = dest.lodging_band_usd_pp_night;
  const nights = Math.max(1, dest.ideal_days - 1);
  return Math.round(((lo + hi) / 2) * nights + AIRFARE_PRIOR_USD[dest.region]);
}

export function ceilingFor(dest: Pick<Destination, 'region'>, cfg: Config): number {
  return dest.region === 'US'
    ? cfg.expedition.ceiling_usd.domestic
    : cfg.expedition.ceiling_usd.international;
}

export function scoreDestination(input: ScoreInput, weights: Weights): number {
  const snow =
    clip01(input.snow.forecast10dCm / SNOW_REFERENCE_CM) * CONFIDENCE_WEIGHT[input.snow.confidence];
  const observed = clip01(input.observed7dCm / OBSERVED_REFERENCE_CM);
  const cost = clip01(1 - input.estCostPp / input.ceilingUsd);
  const logistics = clip01(input.logisticsEase);
  return round3(
    weights.forecast_snow_10d_confidence_weighted * snow +
      weights.observed_snow_7d * observed +
      weights.cost * cost +
      weights.logistics_ease * logistics,
  );
}

export type RecentBuild = {
  destination: string;
  /** `expeditions.created_at`: ISO, or SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string;
};

export function rankBoard(
  candidates: ScoreInput[],
  cfg: Config,
  recent: RecentBuild[],
  now: Date,
  opts: { ignoreCeiling?: boolean } = {},
): RankResult {
  const cooldownMs = cfg.expedition.repeat_cooldown_weeks * 7 * 86_400_000;
  const lastBuilt = new Map<string, string>();
  for (const r of recent) {
    const prev = lastBuilt.get(r.destination);
    if (!prev || parseWhen(r.createdAt) > parseWhen(prev))
      lastBuilt.set(r.destination, r.createdAt);
  }

  const ranked: Ranked[] = [];
  const nearMisses: NearMiss[] = [];
  const cooledDown: RankResult['cooledDown'] = [];

  for (const c of candidates) {
    const last = lastBuilt.get(c.dest.id);
    if (last !== undefined && now.getTime() - parseWhen(last) < cooldownMs) {
      cooledDown.push({ dest: c.dest, lastBuiltAt: last });
      continue;
    }
    if (!opts.ignoreCeiling && c.estCostPp > c.ceilingUsd) {
      nearMisses.push({
        dest: c.dest,
        estCostPp: c.estCostPp,
        ceilingUsd: c.ceilingUsd,
        reason: `pre-rank estimate $${c.estCostPp}/pp over the $${c.ceilingUsd} ceiling`,
      });
      continue;
    }
    ranked.push({
      dest: c.dest,
      score: scoreDestination(c, cfg.expedition.ranking_weights),
      reasons: reasonsFor(c),
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.dest.id.localeCompare(b.dest.id));
  return { ranked, nearMisses, cooledDown };
}

/** Why it scored what it did, in the terms a person would argue about. */
function reasonsFor(c: ScoreInput): string[] {
  return [
    `${Math.round(c.snow.forecast10dCm)}cm forecast over 10 days, ${c.snow.confidence} confidence`,
    `${Math.round(c.observed7dCm)}cm fell in the last 7 days`,
    `~$${c.estCostPp}/pp against a $${c.ceilingUsd} ceiling (estimate, not a quote)`,
    `ground: ${c.dest.ground}`,
  ];
}

function parseWhen(s: string): number {
  // SQLite's datetime('now') has no zone marker and V8 would read it as local
  // time; it is UTC, so say so before parsing.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return Date.parse(s.replace(' ', 'T') + 'Z');
  return Date.parse(s);
}

function clip01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
