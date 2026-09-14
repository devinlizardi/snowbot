import type { Config } from '../config.js';
import { optionalSecret } from '../config.js';
import type { DB } from '../db.js';
import { isQuiet } from '../discord/commands.js';
import type { GetOptions } from '../sources/_cache.js';
import { searchFlights, type FlightSearch, type FlightWindow } from '../sources/flights.js';
import type { Fetched } from '../sources/types.js';
import type { Job, JobContext } from './_runner.js';

/** The columns of `expeditions` this job reads. `plan_json` is Packet 12's
 *  Expedition, of which we depend on the tiny routing slice below. */
export type ExpeditionRow = {
  id: string;
  destination: string;
  window_start: string;
  window_end: string;
  plan_json: string;
  status: 'proposed' | 'watched' | 'retired';
  thread_id: string | null;
};

/** One exact round trip to re-price every day. `priceUsd` is the fare the
 *  dossier quoted, used as the baseline until fare_history has a row. */
export type WatchedItinerary = {
  member: string;
  origin: string;
  dest: string;
  depart: string;
  return: string;
  priceUsd: number | null;
};

export type ExpeditionWatchDeps = {
  /** Re-price one round trip. Tests stub this; production goes through the SerpApi cap. */
  searchFlights(
    db: DB,
    cfg: Config,
    params: FlightWindow,
    opts: GetOptions,
  ): Promise<Fetched<FlightSearch>>;
};

export type Move = 'flat' | 'up' | 'down' | 'new-floor';

export type WatchRow = {
  member: string;
  origin: string;
  today: number | null;
  /** Same member+origin on the previous check, or the dossier's quote on the first one. */
  last: number | null;
  /** Cheapest this member+origin has ever been seen at, prior checks only. */
  floor: number | null;
};

/** A ±10% move against yesterday is news; anything smaller is thread chatter. */
const PING_THRESHOLD = 0.1;

/* ------------------------------------------------------------ pure pieces */

type PerMember = { member: string; origin: string; priceUsd: number | null; dest?: string };

/**
 * Derive the round trips to watch from an expedition row. The plan's routing
 * block is owned by the builder and may change shape; everything here is read
 * as "if it looks like a per-member list, use it", falling back to the
 * independent routing and then to nothing rather than throwing.
 */
export function itinerariesFor(row: ExpeditionRow, cfg: Config): WatchedItinerary[] {
  let plan: unknown;
  try {
    plan = JSON.parse(row.plan_json);
  } catch {
    return [];
  }
  const routing = pick(plan, 'routing');
  const recommended = pick(routing, 'recommended');
  const strategy =
    (typeof recommended === 'string' ? pick(routing, recommended) : undefined) ??
    pick(routing, 'independent');
  const list = pick(strategy, 'perMember') ?? pick(pick(routing, 'independent'), 'perMember');
  if (!Array.isArray(list)) return [];

  const boardAirport = cfg.board.find((d) => d.id === row.destination)?.airport;
  const out: WatchedItinerary[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const pm = asPerMember(raw);
    if (!pm) continue;
    const dest = pm.dest ?? boardAirport;
    if (!dest) continue;
    const key = `${pm.member}|${pm.origin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      member: pm.member,
      origin: pm.origin,
      dest,
      depart: row.window_start,
      return: row.window_end,
      priceUsd: pm.priceUsd,
    });
  }
  return out;
}

/** True once the trip's first day has begun — there is nothing left to book. */
export function retireIfPast(row: Pick<ExpeditionRow, 'window_start'>, now: Date): boolean {
  const start = Date.parse(`${row.window_start}T00:00:00Z`);
  return !Number.isNaN(start) && now.getTime() > start;
}

/**
 * The ±10% test runs first because a 12% drop is bigger news than "also a new
 * low", and the root ping says both anyway. A first check has no floor to
 * beat, so it can only be flat or a move against the dossier's quote.
 */
export function classifyMove(
  prevAvg: number | null,
  newAvg: number,
  floorAvg: number | null,
): Move {
  if (prevAvg !== null && prevAvg > 0) {
    const delta = (newAvg - prevAvg) / prevAvg;
    if (delta <= -PING_THRESHOLD) return 'down';
    if (delta >= PING_THRESHOLD) return 'up';
  }
  if (floorAvg !== null && newAvg < floorAvg) return 'new-floor';
  return 'flat';
}

/** One monospace table: member · origin · today · Δ vs last · floor. */
export function renderWatchTable(rows: readonly WatchRow[]): string {
  const cells = rows.map((r) => [
    r.member,
    r.origin,
    usd(r.today),
    r.today !== null && r.last !== null ? deltaCell(r.today, r.last) : '—',
    usd(r.floor),
  ]);
  const header = ['member', 'origin', 'today', 'Δ vs last', 'floor'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd();
  return ['```', line(header), ...cells.map(line), '```'].join('\n');
}

/* ----------------------------------------------------------------- the job */

export async function runExpeditionWatch(ctx: JobContext, deps: ExpeditionWatchDeps): Promise<void> {
  const { db, cfg, poster, now, log } = ctx;
  const offline = ctx.dryRun && !optionalSecret('SERPAPI_KEY');
  if (offline) log.warn('no SERPAPI_KEY in a dry run — serving cache only');

  const rows = db
    .prepare(
      `SELECT id, destination, window_start, window_end, plan_json, status, thread_id
       FROM expeditions WHERE status = 'watched' ORDER BY window_start, id`,
    )
    .all() as ExpeditionRow[];
  if (rows.length === 0) {
    log.info('quiet — nothing watched');
    return;
  }

  for (const row of rows) {
    if (retireIfPast(row, now)) {
      db.prepare(`UPDATE expeditions SET status = 'retired' WHERE id = ?`).run(row.id);
      log.info('expedition retired', { id: row.id, windowStart: row.window_start });
      await poster.postThread(
        row.thread_id,
        `🏁 **${row.id}** — window passed (${row.window_start}), retiring the fare watch.`,
      );
      continue;
    }

    const itins = itinerariesFor(row, cfg);
    if (itins.length === 0) {
      log.warn('no itineraries in plan — nothing to re-price', { id: row.id });
      continue;
    }

    const history = loadHistory(db, row.id);
    const checkedAt = now.toISOString();
    const table: WatchRow[] = [];
    const insert = db.prepare(
      `INSERT INTO fare_history (expedition_id, checked_at, member_id, origin, price_usd)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const it of itins) {
      let today: number | null = null;
      try {
        const res = await deps.searchFlights(
          db,
          cfg,
          { origin: it.origin, dest: it.dest, depart: it.depart, return: it.return },
          { offline, now },
        );
        today = res.value.cheapest?.priceUsd ?? null;
      } catch (err) {
        log.warn(offline ? 'nothing cached, skipping' : 'fare search failed', {
          id: row.id,
          route: `${it.member} ${it.origin}→${it.dest}`,
          error: String(err),
        });
      }
      if (today !== null) {
        insert.run(row.id, checkedAt, memberIdFor(db, it.member), it.origin, today);
      }
      // A member with no `members` row is stored with a null member_id, so
      // their history is keyed by origin alone.
      const key = memberIdFor(db, it.member) === null ? `|${it.origin}` : `${it.member}|${it.origin}`;
      table.push({
        member: it.member,
        origin: it.origin,
        today,
        last: history.last.get(key) ?? (history.checks.length === 0 ? it.priceUsd : null),
        floor: history.floor.get(key) ?? null,
      });
    }

    const priced = table.filter((r) => r.today !== null).map((r) => r.today!);
    if (priced.length === 0) {
      log.warn('no fares at all today — no post', { id: row.id });
      continue;
    }
    const newAvg = mean(priced);
    const prevAvg =
      history.checks.at(-1)?.avg ??
      (itins.every((i) => i.priceUsd !== null) ? mean(itins.map((i) => i.priceUsd!)) : null);
    const floorAvg = history.checks.length ? Math.min(...history.checks.map((c) => c.avg)) : null;
    const move = classifyMove(prevAvg, newAvg, floorAvg);
    log.info('fare check', { id: row.id, avg: newAvg, prevAvg, floorAvg, move });

    const headline = `💸 **${row.id}** · ${checkedAt.slice(0, 10)} · ${usd(newAvg)}/pp avg` +
      (prevAvg !== null ? ` (${deltaCell(newAvg, prevAvg)} vs last)` : '') +
      (floorAvg !== null ? ` · floor ${usd(Math.min(floorAvg, newAvg))}` : '');
    await poster.postThread(row.thread_id, [headline, renderWatchTable(table)].join('\n'));

    if (move === 'flat') continue;
    if (isQuiet(db, now)) {
      log.info('move worth a ping, but /quiet is on — thread only', { id: row.id, move });
      continue;
    }
    await poster.postRoot(pingText(row, move, newAvg, prevAvg, floorAvg));
  }
}

/** Daily. Each watched expedition costs one SerpApi search per member+origin. */
export const expeditionWatchJob: Job = {
  name: 'expeditionWatch',
  run: (ctx) => runExpeditionWatch(ctx, { searchFlights }),
};

/* ---------------------------------------------------------------- helpers */

type History = {
  /** Per-check per-person average, oldest first. */
  checks: { checkedAt: string; avg: number }[];
  /** member|origin → price on the most recent check. */
  last: Map<string, number>;
  /** member|origin → cheapest ever seen. */
  floor: Map<string, number>;
};

function loadHistory(db: DB, expeditionId: string): History {
  const checks = db
    .prepare(
      `SELECT checked_at AS checkedAt, AVG(price_usd) AS avg FROM fare_history
       WHERE expedition_id = ? GROUP BY checked_at ORDER BY checked_at`,
    )
    .all(expeditionId) as { checkedAt: string; avg: number }[];
  const rows = db
    .prepare(
      `SELECT f.checked_at, COALESCE(m.name, '') AS member, f.origin, f.price_usd
       FROM fare_history f LEFT JOIN members m ON m.id = f.member_id
       WHERE f.expedition_id = ? ORDER BY f.checked_at`,
    )
    .all(expeditionId) as { checked_at: string; member: string; origin: string; price_usd: number }[];
  const lastAt = checks.at(-1)?.checkedAt;
  const last = new Map<string, number>();
  const floor = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.member}|${r.origin}`;
    if (r.checked_at === lastAt) last.set(key, r.price_usd);
    floor.set(key, Math.min(floor.get(key) ?? Infinity, r.price_usd));
  }
  return { checks, last, floor };
}

/** Members are keyed by name in the plan; the row may not exist yet if the
 *  builder priced someone straight off the config roster. */
function memberIdFor(db: DB, name: string): number | null {
  const row = db.prepare(`SELECT id FROM members WHERE lower(name) = lower(?)`).get(name) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

function pingText(
  row: ExpeditionRow,
  move: Move,
  newAvg: number,
  prevAvg: number | null,
  floorAvg: number | null,
): string {
  const where = row.thread_id ? ' — details in the thread.' : '.';
  const was = prevAvg !== null ? ` (was ${usd(prevAvg)})` : '';
  switch (move) {
    case 'down': {
      const floorNote = floorAvg !== null && newAvg < floorAvg ? ' New floor.' : '';
      return `📉 **${row.id}** fares down ${pct(newAvg, prevAvg)} — ${usd(newAvg)}/pp avg${was}.${floorNote}${where}`;
    }
    case 'up':
      return `📈 **${row.id}** fares up ${pct(newAvg, prevAvg)} — ${usd(newAvg)}/pp avg${was}.${where}`;
    case 'new-floor':
      return `🔻 **${row.id}** new floor — ${usd(newAvg)}/pp avg, the cheapest since we started watching${floorAvg !== null ? ` (was ${usd(floorAvg)})` : ''}.${where}`;
    case 'flat':
      return `**${row.id}** — ${usd(newAvg)}/pp avg${where}`;
  }
}

function pct(now: number, prev: number | null): string {
  if (prev === null || prev === 0) return '?%';
  return `${Math.round((Math.abs(now - prev) / prev) * 100)}%`;
}

function deltaCell(today: number, last: number): string {
  const d = today - last;
  if (Math.abs(d) < 0.5) return '$0';
  const sign = d > 0 ? '+' : '-';
  const p = last > 0 ? ` (${sign}${Math.round((Math.abs(d) / last) * 100)}%)` : '';
  return `${sign}$${Math.round(Math.abs(d)).toLocaleString('en-US')}${p}`;
}

function usd(n: number | null): string {
  return n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function pick(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

function asPerMember(raw: unknown): PerMember | null {
  const member = pick(raw, 'member');
  const origin = pick(raw, 'origin');
  if (typeof member !== 'string' || typeof origin !== 'string' || !member || !origin) return null;
  const price = pick(raw, 'priceUsd');
  const dest = pick(raw, 'dest');
  return {
    member,
    origin: origin.toUpperCase(),
    priceUsd: typeof price === 'number' && Number.isFinite(price) ? price : null,
    ...(typeof dest === 'string' && dest ? { dest: dest.toUpperCase() } : {}),
  };
}
