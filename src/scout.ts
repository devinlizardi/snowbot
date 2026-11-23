import { AIRPORT_COORDS, haversineKm } from './airports.js';
import type { Config, Destination, Member } from './config.js';
import type { DB } from './db.js';
import type { Logger } from './logger.js';
import { passCheck, type PassCheck } from './passCheck.js';
import {
  CONFIDENCE_WEIGHT,
  HISTORY_UNKNOWN,
  OBSERVED_REFERENCE_CM,
  historicalScore,
} from './ranking.js';
import {
  addDays,
  composeSnapshot,
  DISCORD_MAX_CHARS,
  gatherSnapshot,
  rangeText,
  sqliteUtcToIso,
  weekday,
  type SnapshotFetch,
  type SpotSnapshot,
} from './snapshot.js';
import { cached } from './sources/_cache.js';
import type { PassAccess } from './sources/lookup.js';
import { archive, trailingWeek } from './sources/weather/archive.js';
import type { Climatology } from './sources/weather/climatology.js';
import { modelName, type DateWindow, type SnowDay } from './sources/weather/consensus.js';

/*
 * `/build` with no arguments: "what's worth watching". Up to three spots where
 * the weather is doing something, ranked on weather alone — this week's
 * modelled snow, what days 8–15 are starting to show, what fell last week, and
 * how the coming weeks usually go there. No cost term and no SerpApi: money is
 * the 💲 Price it button, and only when someone presses it.
 *
 * Every number in the reply is a modelled total, an archive figure or a pass
 * fact from the lookup. Templated, no LLM.
 */

/** cm over 7 days that fills the forecast term. */
export const SNOW7_REFERENCE_CM = 50;
/** cm over days 8–15 that fills the look-ahead term. */
export const LOOKAHEAD_REFERENCE_CM = 50;
/** A day counts as a snow day for a model at this much. */
const DAY_SNOW_CM = 5;
/** A signal needs this much in the biggest model… */
const SIGNAL_MIN_CM = 10;
/** …from at least this many models. */
const SIGNAL_MIN_MODELS = 2;
/** Within this, a member could drive instead of fly. */
export const DRIVE_KM = 450;

export const PRICE_PREFIX = 'price';

/* ---------------------------------------------------------------- types */

export type ScoutCandidate = {
  dest: Destination;
  /** The snapshot row: 7-day report plus days 8–15. */
  row: SpotSnapshot;
  observed7dCm: number | null;
  historical: number | null;
  historicalReason: string | null;
};

export type ScoutPick = {
  dest: Destination;
  score: number;
  /** The biggest modelled snow day, resort-local. */
  peakDay: string | null;
  window: DateWindow;
  story: string;
  drive: string[];
  fly: string[];
  pass: PassCheck | null;
};

export type ScoutResult = {
  picks: ScoutPick[];
  text: string;
  /** One 💲 Price it button per pick. */
  buttons: { customId: string; label: string }[];
};

type Weights = Config['scout']['weights'];

/* -------------------------------------------------------------- scoring */

const clip01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function scoutScore(c: ScoutCandidate, w: Weights): number {
  const snow7 = (c.row.snow?.models ?? []).map((m) => m.totalCm);
  const conf = c.row.snow?.confidence ?? 'low';
  const forecast = clip01(mean(snow7) / SNOW7_REFERENCE_CM) * CONFIDENCE_WEIGHT[conf];
  const ahead = (c.row.lookAhead?.models ?? []).map((m) => m.totalCm);
  const look = clip01(mean(ahead) / LOOKAHEAD_REFERENCE_CM) * CONFIDENCE_WEIGHT.low;
  const observed = clip01((c.observed7dCm ?? 0) / OBSERVED_REFERENCE_CM);
  const history = clip01(c.historical ?? HISTORY_UNKNOWN);
  const s =
    w.forecast_7d * forecast +
    w.lookahead_8_15 * look +
    w.observed_7d * observed +
    w.historical * history;
  return Math.round(s * 1000) / 1000;
}

/** Real snow in the models: the biggest at SIGNAL_MIN_CM, at least two showing some. */
export function hasSignal(row: SpotSnapshot): boolean {
  for (const report of [row.snow, row.lookAhead]) {
    const totals = (report?.models ?? []).map((m) => m.totalCm);
    if (
      totals.length &&
      Math.max(...totals) >= SIGNAL_MIN_CM &&
      totals.filter((t) => t >= DAY_SNOW_CM).length >= SIGNAL_MIN_MODELS
    ) {
      return true;
    }
  }
  return false;
}

/** Per-day median across models over all 15 days. */
function dailyMedians(row: SpotSnapshot): { date: string; cm: number; showing: number }[] {
  const days: SnowDay[] = [...(row.snow?.days ?? []), ...(row.lookAhead?.days ?? [])];
  return days.map((d) => {
    const v = Object.values(d.base)
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    const cm = v.length ? (v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2) : 0;
    return { date: d.date, cm, showing: v.filter((x) => x >= DAY_SNOW_CM).length };
  });
}

export function peakDay(row: SpotSnapshot): string | null {
  const best = dailyMedians(row).reduce<{ date: string; cm: number } | null>(
    (a, d) => (a === null || d.cm > a.cm ? d : a),
    null,
  );
  return best && best.cm >= 2 ? best.date : null;
}

/** "When the snow lands plus a few days": from the peak day, for the spot's ideal length. */
export function suggestedWindow(dest: Destination, peak: string): DateWindow {
  return { start: peak, end: addDays(peak, dest.ideal_days - 1) };
}

export function sameStorm(
  a: { dest: Destination; peakDay: string | null },
  b: { dest: Destination; peakDay: string | null },
  km: number,
): boolean {
  if (!a.peakDay || !b.peakDay) return false;
  const apart = Math.abs(Date.parse(a.peakDay) - Date.parse(b.peakDay)) / 86_400_000;
  return apart <= 1 && haversineKm(a.dest, b.dest) <= km;
}

export function travelFor(
  members: readonly Member[],
  dest: Destination,
): { drive: string[]; fly: string[] } {
  const drive: string[] = [];
  const fly: string[] = [];
  for (const m of members) {
    const near = m.airports.some((a) => {
      const at = AIRPORT_COORDS[a];
      return at !== undefined && haversineKm(at, dest) <= DRIVE_KM;
    });
    (near ? drive : fly).push(m.name);
  }
  return { drive, fly };
}

/**
 * Highest score first; at most one per display group; never two under the
 * same storm (the Whistler + Revelstoke case).
 */
export function choosePicks(
  candidates: readonly ScoutCandidate[],
  cfg: Pick<Config, 'scout'>,
): { c: ScoutCandidate; score: number; peakDay: string | null }[] {
  const scored = candidates
    .filter((c) => hasSignal(c.row))
    .map((c) => ({ c, score: scoutScore(c, cfg.scout.weights), peakDay: peakDay(c.row) }))
    .filter((x) => x.score >= cfg.scout.min_score && x.peakDay !== null)
    .sort((a, b) => b.score - a.score);
  const out: typeof scored = [];
  for (const x of scored) {
    if (out.length >= cfg.scout.max_picks) break;
    if (out.some((p) => p.c.dest.group === x.c.dest.group)) continue;
    if (
      out.some((p) =>
        sameStorm(
          { dest: p.c.dest, peakDay: p.peakDay },
          { dest: x.c.dest, peakDay: x.peakDay },
          cfg.scout.same_storm_km,
        ),
      )
    )
      continue;
    out.push(x);
  }
  return out;
}

/** The weather in a line or two. Numbers are modelled totals or the archive's. */
export function storyFor(c: ScoutCandidate, peak: string | null): string {
  const bits: string[] = [];
  const snow = c.row.snow;
  const totals = (snow?.models ?? []).map((m) => Math.round(m.totalCm));
  if (totals.length && Math.max(...totals) >= SIGNAL_MIN_CM) {
    const words =
      snow!.confidence === 'high'
        ? 'and they agree'
        : snow!.confidence === 'medium'
          ? 'roughly in step'
          : 'but they disagree';
    const top = [...snow!.models].sort((a, b) => b.totalCm - a.totalCm)[0]!;
    bits.push(
      `Models show ${rangeText({ lowCm: Math.min(...totals), highCm: Math.max(...totals) })} this week, ${words}` +
        (snow!.confidence === 'low' ? ` (${modelName(top.model)} is the big one)` : '') +
        (peak ? `; the biggest day is ${weekday(peak)} ${shortDate(peak)}.` : '.'),
    );
  }
  const ahead = (c.row.lookAhead?.models ?? []).map((m) => Math.round(m.totalCm));
  if (ahead.length && ahead.filter((t) => t >= DAY_SNOW_CM).length >= SIGNAL_MIN_MODELS) {
    bits.push(
      `Days 8–15 show ${rangeText({ lowCm: Math.min(...ahead), highCm: Math.max(...ahead) })} more — low confidence.`,
    );
  }
  if (c.observed7dCm !== null && c.observed7dCm >= 1) {
    bits.push(`${Math.round(c.observed7dCm)}cm fell last week.`);
  }
  if (c.historicalReason) bits.push(`History: ${c.historicalReason}.`);
  return bits.join(' ');
}

/** "Nothing's going off yet — the earliest real signal is X." */
export function emptyLine(candidates: readonly ScoutCandidate[]): string {
  let earliest: { date: string; label: string } | null = null;
  for (const c of candidates) {
    for (const d of dailyMedians(c.row)) {
      if (d.showing >= SIGNAL_MIN_MODELS && (!earliest || d.date < earliest.date)) {
        earliest = { date: d.date, label: c.row.spot.label };
      }
    }
  }
  return earliest
    ? `🧊 **Nothing's going off yet** — the earliest real signal is ${earliest.label} around ${weekday(earliest.date)} ${shortDate(earliest.date)}, and it's early.`
    : "🧊 **Nothing's going off yet** — no storm in the 15-day models that two of them agree on.";
}

/* --------------------------------------------------------------- render */

export function renderScout(
  picks: readonly ScoutPick[],
  candidates: readonly ScoutCandidate[],
  asOf: string | null,
): string {
  const lines = [`🔭 **What's worth watching** · next 15 days · weather only, no prices`];
  if (!picks.length) {
    lines.push(emptyLine(candidates));
  }
  picks.forEach((p, i) => {
    lines.push('');
    lines.push(`**${i + 1}. ${p.dest.name}** · ${p.dest.group}`);
    if (p.story) lines.push(p.story);
    const who = [
      p.drive.length ? `drive: ${p.drive.join(', ')}` : null,
      p.fly.length ? `fly: ${p.fly.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`🗓️ ${fmtWindow(p.window)} · ${who}`);
    if (p.pass) lines.push(`🎟️ ${p.pass.summary}`);
  });
  const foot = [
    'ranked on weather alone',
    picks.length ? '💲 Price it runs flights and lodging for that spot and window' : null,
    asOf ? `as of ${asOf}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  lines.push(`-# ${foot}`);
  const text = lines.join('\n');
  return text.length > DISCORD_MAX_CHARS ? text.slice(0, DISCORD_MAX_CHARS - 1) + '…' : text;
}

/** Spot and window travel in the button, so a press survives a restart without state. */
export function priceButtonId(id: string, w: DateWindow): string {
  return `${PRICE_PREFIX}:${id}:${w.start}:${w.end}`;
}

export function parsePriceButton(
  customId: string,
): { destination: string; window: DateWindow } | null {
  const m = /^price:([a-z0-9-]+):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(customId);
  if (!m || m[3]! < m[2]!) return null;
  return { destination: m[1]!, window: { start: m[2]!, end: m[3]! } };
}

/* ------------------------------------------------------------------ run */

export type ScoutContext = { cfg: Config; db: DB; log: Logger; now: Date };

export type ScoutDeps = {
  offline: boolean;
  /** Tests answer by source name; production goes through `cached()`. Never called for SerpApi. */
  fetch?: SnapshotFetch;
  weathernext?: boolean;
  /** History for a window; null when there isn't enough. */
  climatology?: (dest: Destination, window: DateWindow) => Promise<Climatology | null>;
  /** The pass lookup for a pick, or null. */
  passAccess?: (dest: Destination) => Promise<PassAccess | null>;
};

export async function runScout(ctx: ScoutContext, deps: ScoutDeps): Promise<ScoutResult> {
  const { cfg, db, log, now } = ctx;
  const fetch: SnapshotFetch =
    deps.fetch ?? ((source, params) => cached(db, source, params, { offline: deps.offline, now }));
  const inputs = await gatherSnapshot(ctx, {
    offline: deps.offline,
    fetch,
    ...(deps.weathernext !== undefined ? { weathernext: deps.weathernext } : {}),
    only: cfg.board.map((d) => d.id),
  });
  const snapshot = composeSnapshot(inputs);

  const candidates: ScoutCandidate[] = [];
  for (const row of snapshot.spots) {
    const dest = cfg.board.find((d) => d.id === row.spot.id);
    if (!dest || row.snow === null) continue;
    let observed7dCm: number | null = null;
    try {
      const got = await fetch(archive, {
        coord: row.spot.base,
        ...trailingWeek(now),
        ttlMinutes: cfg.weather.cache_ttl_minutes.archive,
      });
      observed7dCm = got.value.trailing7dCm;
    } catch (err) {
      log.warn('scout: archive unavailable', { spot: dest.id, error: String(err) });
    }
    let historical: number | null = null;
    let historicalReason: string | null = null;
    const peak = peakDay(row);
    if (deps.climatology && peak) {
      try {
        const h = await deps.climatology(dest, suggestedWindow(dest, peak));
        historical = historicalScore(h, null);
        if (h)
          historicalReason = `snow on ~${h.typicalSnowDays} of ${h.windowDays} days here in a typical season`;
      } catch (err) {
        log.warn('scout: history unavailable', { spot: dest.id, error: String(err) });
      }
    }
    candidates.push({ dest, row, observed7dCm, historical, historicalReason });
  }

  const chosen = choosePicks(candidates, cfg);
  const picks: ScoutPick[] = [];
  for (const { c, score, peakDay: peak } of chosen) {
    const window = suggestedWindow(c.dest, peak!);
    let access: PassAccess | null = null;
    if (deps.passAccess) {
      try {
        access = await deps.passAccess(c.dest);
      } catch (err) {
        log.warn('scout: pass lookup unavailable', { spot: c.dest.id, error: String(err) });
      }
    }
    picks.push({
      dest: c.dest,
      score,
      peakDay: peak,
      window,
      story: storyFor(c, peak),
      ...travelFor(cfg.members, c.dest),
      pass: passCheck(c.dest, window, access, cfg.group.pass),
    });
  }
  log.info('scout', {
    candidates: candidates.map((c) => `${c.dest.id}:${scoutScore(c, cfg.scout.weights)}`),
    picks: picks.map((p) => p.dest.id),
  });

  const asOf = snapshot.oldestFetch
    ? clockShort(sqliteUtcToIso(snapshot.oldestFetch), cfg.timezone)
    : null;
  return {
    picks,
    text: renderScout(picks, candidates, asOf),
    buttons: picks.map((p) => ({
      customId: priceButtonId(p.dest.id, p.window),
      label: `💲 Price ${p.dest.name}`.slice(0, 80),
    })),
  };
}

/* -------------------------------------------------------------- helpers */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(d: string): string {
  return `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
}

export function fmtWindow(w: DateWindow): string {
  return `${weekday(w.start)} ${shortDate(w.start)} – ${weekday(w.end)} ${shortDate(w.end)}`;
}

function clockShort(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
    .format(new Date(iso))
    .replace(',', '');
}
