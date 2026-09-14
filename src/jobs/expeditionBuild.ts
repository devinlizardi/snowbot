import {
  buildExpedition,
  gatherExpeditionInputs,
  insertExpedition,
  type DateWindow,
  type Expedition,
  type ExpeditionInputs,
} from '../builder.js';
import { optionalSecret, type Destination } from '../config.js';
import type { DB } from '../db.js';
import { kvDelete, kvGet } from '../db.js';
import { isQuiet } from '../discord/commands.js';
import type { CompleteOptions } from '../llm/client.js';
import {
  DOSSIER_MAX_CHARS,
  DOSSIER_SYSTEM_PROMPT,
  fallbackRender,
  fmtWindow,
  renderDossierPrompt,
  unquotedNumbers,
} from '../llm/prompts/dossier.js';
import {
  ceilingFor,
  estimateCostForRanking,
  logisticsEaseFor,
  rankBoard,
  type RecentBuild,
  type ScoreInput,
} from '../ranking.js';
import { cached } from '../sources/_cache.js';
import { archive, trailingWeek } from '../sources/weather/archive.js';
import { buildSnowReport, type Confidence } from '../sources/weather/consensus.js';
import { crosscheckFor } from '../sources/weather/crosscheck.js';
import { ecmwfIfs } from '../sources/weather/ecmwf.js';
import type { Coord, ModelForecast } from '../sources/weather/types.js';
import type { Job, JobContext } from './_runner.js';

/**
 * The weekly Expedition Builder (PLAN.md §1B).
 *
 *   rank the board on weather alone → pick the top candidate → gather the
 *   real inputs → build → if it blows the ceiling, log a near miss and try the
 *   next one → insert → Sonnet writes the dossier → one root post + its thread.
 *
 * The pre-rank is deliberately cheap: Open-Meteo is free, SerpApi is not, so
 * flights are only priced for a destination that has already earned it. The
 * cost term in the pre-rank is a prior (`AIRFARE_PRIOR_USD`), never quoted.
 *
 * `/build [destination] [month]` arrives through kv (`serve.ts` writes it),
 * skips the ranking and ignores the ceiling: someone asked for this one.
 */

export const KV_BUILD_REQUEST = 'expedition:build_request';

/** Earliest a window may start: fares need a lead, and so does the group. */
export const MIN_LEAD_DAYS = 21;
/** Never plan on top of the Aspen trip or its travel days. */
export const ASPEN_BUFFER_DAYS = 3;
/** How many ranked candidates get a real (paid) build before giving up. */
export const MAX_BUILD_ATTEMPTS = 3;
/** The pre-rank forecast horizon, matching the ranking formula's 10 days. */
const PRERANK_DAYS = 10;

export type SnowSignal = {
  forecast10dCm: number;
  confidence: Confidence;
  observed7dCm: number;
};

export type BuildRequest = { destination?: string; month?: string };

export type ExpeditionBuildDeps = {
  /** The expensive half: SerpApi + lookups. Stubbed in tests. */
  gather(ctx: JobContext, dest: Destination, window: DateWindow): Promise<ExpeditionInputs>;
  /** The cheap half: Open-Meteo at the base, for the pre-rank only. */
  fetchSnow(dest: Destination): Promise<SnowSignal>;
  /** Sonnet, in production; a stub or a thrower in tests. */
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
};

export type BuildOutcome = {
  expedition: Expedition;
  dossier: string;
  posted: boolean;
  forced: boolean;
};

/* ------------------------------------------------------------- windows */

/**
 * The next window starting on a Friday or Saturday at least `MIN_LEAD_DAYS`
 * out (or inside the hinted month), `ideal_days` long, clear of `avoid` by
 * `ASPEN_BUFFER_DAYS` on either side. A hinted month that has no such window
 * falls through to the first one after it, since a plan a week late beats no
 * plan at all.
 */
export type Season = { start: string; end: string };
export const DEFAULT_SEASON: Season = { start: '12-01', end: '04-15' };

/** Is a YYYY-MM-DD date inside the riding season? The span may wrap New Year. */
export function inSeason(date: string, season: Season): boolean {
  const md = date.slice(5);
  return season.start <= season.end
    ? md >= season.start && md <= season.end
    : md >= season.start || md <= season.end;
}

export function pickWindow(
  dest: Pick<Destination, 'ideal_days'>,
  now: Date,
  monthHint?: string,
  avoid?: DateWindow,
  season: Season = DEFAULT_SEASON,
): DateWindow {
  const today = now.toISOString().slice(0, 10);
  const earliest = addDays(today, MIN_LEAD_DAYS);
  const hinted = monthHint && /^\d{4}-\d{2}$/.test(monthHint) ? monthHint : undefined;
  let start = hinted && `${hinted}-01` > earliest ? `${hinted}-01` : earliest;
  // A September build must not propose October: nothing is open. Roll forward
  // to the first day of the season instead. (A hinted month is taken at face
  // value — a person asking for it presumably knows the lifts are running.)
  if (!hinted && !inSeason(start, season)) {
    const y = Number(start.slice(0, 4));
    const candidate = `${y}-${season.start}`;
    start = candidate > start ? candidate : `${y + 1}-${season.start}`;
  }

  const blocked = avoid
    ? {
        start: addDays(avoid.start, -ASPEN_BUFFER_DAYS),
        end: addDays(avoid.end, ASPEN_BUFFER_DAYS),
      }
    : null;
  const fits = (s: string, e: string) => !blocked || e < blocked.start || s > blocked.end;

  for (let i = 0; i < 400; i += 1) {
    const dow = new Date(`${start}T00:00:00Z`).getUTCDay();
    if (dow === 5 || dow === 6) {
      const end = addDays(start, dest.ideal_days - 1);
      // Inside the hinted month, or past it with nothing found inside: take it.
      // Inside the hinted month the hint wins; anywhere else, only open lifts count.
      const open =
        (hinted !== undefined && start.startsWith(hinted)) ||
        (inSeason(start, season) && inSeason(end, season));
      if (open && fits(start, end) && (!hinted || start.startsWith(hinted) || start > `${hinted}-31`)) {
        return { start, end };
      }
    }
    start = addDays(start, 1);
  }
  throw new Error(`no window found for a ${dest.ideal_days}-day trip after ${earliest}`);
}

/* ------------------------------------------------------------- the job */

export async function runExpeditionBuild(
  ctx: JobContext,
  deps: ExpeditionBuildDeps,
): Promise<BuildOutcome | null> {
  const { cfg, db, now, log } = ctx;
  const request = takeBuildRequest(db, log);
  const forcedDest = request?.destination
    ? cfg.board.find((d) => d.id === request.destination)
    : undefined;
  if (request?.destination && !forcedDest) {
    throw new Error(`"${request.destination}" is not on the board`);
  }
  const aspen: DateWindow = { start: cfg.aspen.window_start, end: cfg.aspen.window_end };

  let candidates: Destination[];
  if (forcedDest) {
    log.info('forced build — skipping the ranking and the ceiling', {
      destination: forcedDest.id,
      month: request?.month,
    });
    candidates = [forcedDest];
  } else {
    candidates = await prerank(ctx, deps, aspen);
    if (candidates.length === 0) {
      log.warn('nothing on the board survived the filters — no build this week');
      return null;
    }
  }

  const forced = forcedDest !== undefined;
  let built: Expedition | null = null;
  for (const dest of candidates.slice(0, MAX_BUILD_ATTEMPTS)) {
    const window = pickWindow(dest, now, request?.month, aspen, cfg.expedition.season);
    log.info('building', { destination: dest.id, window });
    let inputs: ExpeditionInputs;
    try {
      inputs = await deps.gather(ctx, dest, window);
    } catch (err) {
      log.warn('could not gather inputs — trying the next candidate', {
        destination: dest.id,
        error: String(err),
      });
      continue;
    }
    const e = buildExpedition(inputs, cfg, now);
    if (e.cost.overCeiling && !forced) {
      const reason = `built plan $${e.cost.perPersonUsd}/pp over the $${e.cost.ceilingUsd} ceiling`;
      log.info('over ceiling — near miss, trying the next candidate', { id: e.id, reason });
      writeNearMiss(db, dest.id, e.window.start, e.cost.perPersonUsd, reason);
      continue;
    }
    built = e;
    break;
  }
  if (!built) {
    const tried = Math.min(MAX_BUILD_ATTEMPTS, candidates.length);
    throw new Error(
      forced
        ? `could not build ${forcedDest?.id}: inputs unavailable`
        : `none of the top ${tried} candidates could be built — each either had no flight/lodging quotes (see warnings above) or came in over the ceiling (see near_misses)`,
    );
  }

  const existing = db
    .prepare(`SELECT root_message_id, thread_id FROM expeditions WHERE id = ?`)
    .get(built.id) as { root_message_id: string | null; thread_id: string | null } | undefined;
  insertExpedition(db, built);

  const dossier = await writeDossier(ctx, deps, built);
  const posted = await publish(ctx, built, dossier, existing ?? null);
  return { expedition: built, dossier, posted, forced };
}

/** Weekly. The scheduler picks the day; `/build` fires it on demand. */
export const expeditionBuildJob: Job = {
  name: 'expeditionBuild',
  run: async (ctx) => {
    const offline = ctx.dryRun && !optionalSecret('OPEN_METEO_LIVE');
    if (offline) ctx.log.warn('dry run without OPEN_METEO_LIVE — serving cache only');
    await runExpeditionBuild(ctx, {
      gather: (c, dest, window) => gatherExpeditionInputs(c, dest, window, { offline }),
      fetchSnow: (dest) => fetchSnowSignal(ctx, dest, { offline }),
      complete: (prompt, opts) => ctx.llm.complete(prompt, opts),
    });
  },
};

/* ------------------------------------------------------------ pre-rank */

async function prerank(
  ctx: JobContext,
  deps: ExpeditionBuildDeps,
  aspen: DateWindow,
): Promise<Destination[]> {
  const { cfg, db, now, log } = ctx;
  const inputs: ScoreInput[] = [];
  for (const dest of cfg.board) {
    let snow: SnowSignal;
    try {
      snow = await deps.fetchSnow(dest);
    } catch (err) {
      log.warn('no weather for pre-rank — scoring on cost and logistics only', {
        destination: dest.id,
        error: String(err),
      });
      snow = { forecast10dCm: 0, confidence: 'low', observed7dCm: 0 };
    }
    inputs.push({
      dest,
      snow: { forecast10dCm: snow.forecast10dCm, confidence: snow.confidence },
      observed7dCm: snow.observed7dCm,
      estCostPp: estimateCostForRanking(dest),
      ceilingUsd: ceilingFor(dest, cfg),
      logisticsEase: logisticsEaseFor(dest),
    });
  }

  const result = rankBoard(inputs, cfg, recentBuilds(db), now);
  for (const miss of result.nearMisses) {
    writeNearMiss(
      db,
      miss.dest.id,
      pickWindow(miss.dest, now, undefined, aspen).start,
      miss.estCostPp,
      miss.reason,
    );
  }
  log.info('pre-rank', {
    ranked: result.ranked.map((r) => `${r.dest.id}:${r.score}`),
    nearMisses: result.nearMisses.map((m) => m.dest.id),
    cooledDown: result.cooledDown.map((c) => c.dest.id),
  });
  return result.ranked.map((r) => r.dest);
}

/**
 * The weather half of the ranking for one destination: ECMWF IFS plus the
 * regional cross-check at the base over the next ten days, and the archive's
 * trailing week. Each source is optional; with none the signal is zero.
 */
export async function fetchSnowSignal(
  ctx: Pick<JobContext, 'cfg' | 'db' | 'now' | 'log'>,
  dest: Destination,
  opts: { offline: boolean },
): Promise<SnowSignal> {
  const { cfg, db, now, log } = ctx;
  const get = { offline: opts.offline, now };
  const base: Coord = {
    lat: dest.lat,
    lon: dest.lon,
    label: 'base',
    elevationM: dest.base_elevation_m,
  };
  const ttl = cfg.weather.cache_ttl_minutes.forecast;
  const forecastDays = cfg.weather.open_meteo.forecast_days;

  const models: ModelForecast[] = [];
  for (const src of [ecmwfIfs, ...crosscheckFor(dest.region)]) {
    try {
      models.push(
        (await cached(db, src, { coord: base, forecastDays, ttlMinutes: ttl }, get)).value,
      );
    } catch (err) {
      log.warn('pre-rank source unavailable', {
        destination: dest.id,
        source: src.name,
        error: String(err),
      });
    }
  }
  const today = now.toISOString().slice(0, 10);
  const report = buildSnowReport({
    window: { start: today, end: addDays(today, PRERANK_DAYS - 1) },
    base: models,
    baseElevationM: dest.base_elevation_m,
    summitElevationM: dest.summit_elevation_m,
  });
  const totals = report.models.map((m) => m.totalCm);
  const forecast10dCm = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;

  let observed7dCm = 0;
  try {
    const week = trailingWeek(now);
    observed7dCm = (
      await cached(
        db,
        archive,
        { coord: base, ...week, ttlMinutes: cfg.weather.cache_ttl_minutes.archive },
        get,
      )
    ).value.trailing7dCm;
  } catch (err) {
    log.warn('pre-rank archive unavailable', { destination: dest.id, error: String(err) });
  }

  return {
    forecast10dCm: Math.round(forecast10dCm * 10) / 10,
    confidence: report.confidence,
    observed7dCm,
  };
}

/* -------------------------------------------------------------- dossier */

/** Sonnet when we can, the deterministic dossier when we can't or it invents a number. */
async function writeDossier(
  ctx: JobContext,
  deps: ExpeditionBuildDeps,
  e: Expedition,
): Promise<string> {
  if (ctx.dryRun && !optionalSecret('ANTHROPIC_API_KEY')) {
    ctx.log.info('dry run without ANTHROPIC_API_KEY — using the fallback dossier');
    return fallbackRender(e);
  }
  try {
    const text = await deps.complete(renderDossierPrompt(e), {
      model: 'smart',
      system: DOSSIER_SYSTEM_PROMPT,
      maxTokens: 1500,
    });
    if (!text.trim()) throw new Error('empty completion');
    const invented = unquotedNumbers(text, e);
    if (invented.length) {
      ctx.log.warn('model quoted numbers not in the expedition — using fallback', { invented });
      return fallbackRender(e);
    }
    if (text.length > DOSSIER_MAX_CHARS) {
      ctx.log.warn('dossier over length — using fallback', { chars: text.length });
      return fallbackRender(e);
    }
    return text;
  } catch (err) {
    ctx.log.warn('llm failed — using fallback dossier', { error: String(err) });
    return fallbackRender(e);
  }
}

/**
 * One root message and its thread. A rebuild of a window that already has a
 * message edits it instead (PLAN.md §2: new roots are for news). Quiet mode
 * keeps the row and skips the post; the plan is still there for `/watch`.
 */
async function publish(
  ctx: JobContext,
  e: Expedition,
  dossier: string,
  existing: { root_message_id: string | null; thread_id: string | null } | null,
): Promise<boolean> {
  const { db, poster, now, log } = ctx;
  if (existing?.root_message_id) {
    log.info('rebuild of a posted expedition — editing in place', { id: e.id });
    await poster.editMessage(existing.root_message_id, dossier);
    return true;
  }
  if (isQuiet(db, now)) {
    log.info('quiet mode — expedition saved, dossier not posted', { id: e.id });
    return false;
  }
  const posted = await poster.postRoot(dossier);
  if (posted.suppressed) {
    log.warn('dossier root post suppressed — row kept', { id: e.id, reason: posted.reason });
    return false;
  }
  if (posted.messageId) {
    const threadId = await poster.ensureThread(
      posted.messageId,
      `${e.destination.name} ${fmtWindow(e.window)}`,
    );
    db.prepare(`UPDATE expeditions SET root_message_id = ?, thread_id = ? WHERE id = ?`).run(
      posted.messageId,
      threadId,
      e.id,
    );
  }
  return true;
}

/* ------------------------------------------------------------- helpers */

/** Read and clear the `/build` request, so a crash mid-build does not replay it forever. */
function takeBuildRequest(db: DB, log: JobContext['log']): BuildRequest | null {
  const raw = kvGet(db, KV_BUILD_REQUEST);
  if (!raw) return null;
  kvDelete(db, KV_BUILD_REQUEST);
  try {
    const parsed = JSON.parse(raw) as { destination?: unknown; month?: unknown };
    return {
      ...(typeof parsed.destination === 'string' ? { destination: parsed.destination } : {}),
      ...(typeof parsed.month === 'string' ? { month: parsed.month } : {}),
    };
  } catch {
    log.warn('unreadable build request ignored', { raw });
    return null;
  }
}

function recentBuilds(db: DB): RecentBuild[] {
  return (
    db
      .prepare(`SELECT destination, created_at FROM expeditions ORDER BY created_at DESC`)
      .all() as { destination: string; created_at: string }[]
  ).map((r) => ({ destination: r.destination, createdAt: r.created_at }));
}

function writeNearMiss(
  db: DB,
  destination: string,
  windowStart: string,
  totalPp: number,
  reason: string,
) {
  db.prepare(
    `INSERT INTO near_misses (destination, window_start, total_pp_usd, reason) VALUES (?, ?, ?, ?)`,
  ).run(destination, windowStart, totalPp, reason);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
