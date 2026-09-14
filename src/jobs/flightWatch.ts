import { optionalSecret } from '../config.js';
import type { DB } from '../db.js';
import { cached } from '../sources/_cache.js';
import { flightStatus, type FlightStatus, type FlightStatusParams } from '../sources/flightStatus.js';
import type { Job, JobContext } from './_runner.js';

/** A `flights` row joined to its member. `last_status` is the JSON of the
 *  {@link FlightStatus} seen on the previous run, or null on first sight. */
export type FlightRow = {
  id: number;
  member_name: string;
  airline: string;
  number: string;
  date: string;
  origin: string;
  dest: string;
  last_status: string | null;
  last_checked_at: string | null;
};

export type FlightWatchDeps = {
  /** Resolve a status, or throw. Tests stub this; production goes through the cache. */
  fetchStatus(params: FlightStatusParams, opts: { offline: boolean }): Promise<FlightStatus>;
};

export type StatusDiff = {
  changed: boolean;
  /** Worth breaking the root-post budget for: cancelled, diverted, or delay moved ≥ 30 min. */
  urgent: boolean;
  reasons: string[];
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Half-width of each milestone window. The job runs hourly, so ±35 min guarantees exactly one hit. */
const MILESTONE_SLOP_MIN = 35;
const MILESTONE_HOURS_BEFORE = [24, 3] as const;
const URGENT_DELAY_MIN = 30;

/* ------------------------------------------------------------ pure pieces */

/** Only flights departing yesterday through the day after tomorrow are worth a
 *  thought; the rest of the roster's itinerary is inert until then. */
export function selectFlightsToCheck<T extends { date: string }>(rows: readonly T[], now: Date): T[] {
  const lo = utcDate(new Date(now.getTime() - DAY));
  const hi = utcDate(new Date(now.getTime() + 2 * DAY));
  return rows.filter((r) => r.date >= lo && r.date <= hi);
}

/** True when `now` sits within ±35 min of T-24h or T-3h before the scheduled departure. */
export function isMilestone(scheduledOut: string, now: Date): boolean {
  const dep = Date.parse(scheduledOut);
  if (Number.isNaN(dep)) return false;
  return MILESTONE_HOURS_BEFORE.some(
    (h) => Math.abs(now.getTime() - (dep - h * HOUR)) <= MILESTONE_SLOP_MIN * MIN,
  );
}

/** Between the first milestone and a while after departure, status can move
 *  without us asking; this is when hourly polling is worth the API call. */
function isActive(scheduledOut: string, now: Date): boolean {
  const dep = Date.parse(scheduledOut);
  if (Number.isNaN(dep)) return false;
  const t = now.getTime();
  return t >= dep - (24 * HOUR + MILESTONE_SLOP_MIN * MIN) && t <= dep + 12 * HOUR;
}

/** What changed between two sightings. A first sighting is never a change:
 *  nobody wants "UA1234 is scheduled" as news a month out. */
export function diffStatus(prev: FlightStatus | null, next: FlightStatus): StatusDiff {
  if (!prev) return { changed: false, urgent: false, reasons: [] };
  const reasons: string[] = [];
  let urgent = false;

  if (next.status !== prev.status) {
    reasons.push(`${prev.status} → ${next.status}`);
    if (next.status === 'cancelled' || next.status === 'diverted') urgent = true;
  }
  const delayMoved = (next.delayMin ?? 0) - (prev.delayMin ?? 0);
  if (Math.abs(delayMoved) >= URGENT_DELAY_MIN) {
    reasons.push(`delay ${fmtDelay(prev.delayMin)} → ${fmtDelay(next.delayMin)}`);
    urgent = true;
  }
  return { changed: reasons.length > 0, urgent, reasons };
}

export type TableRow = {
  member: string;
  flight: string;
  origin: string;
  dest: string;
  status: FlightStatus | null;
};

/** One monospace table for the whole group. Times are UTC because that is what
 *  AeroAPI speaks and five people are leaving from four time zones. */
export function renderFlightTable(rows: readonly TableRow[]): string {
  const cells = rows.map((r) => [
    r.member,
    r.flight,
    `${r.origin}→${r.dest}`,
    r.status ? hhmm(r.status.scheduledOut) : '--:--',
    r.status ? hhmm(r.status.estimatedOut ?? r.status.actualOut ?? r.status.scheduledOut) : '--:--',
    r.status ? statusCell(r.status) : 'no data',
  ]);
  const header = ['member', 'flight', 'route', 'sched', 'est', 'status'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd();
  return ['```', line(header), ...cells.map(line), '```', '_times UTC_'].join('\n');
}

/* ----------------------------------------------------------------- the job */

export async function runFlightWatch(ctx: JobContext, deps: FlightWatchDeps): Promise<void> {
  const { db, poster, now, log } = ctx;
  const offline = ctx.dryRun && !optionalSecret('FLIGHTAWARE_API_KEY');
  if (offline) log.warn('no FLIGHTAWARE_API_KEY in a dry run — serving cache only');

  const rows = selectFlightsToCheck(loadFlights(db), now);
  if (rows.length === 0) {
    log.info('quiet — no flights near today');
    return;
  }

  const table: TableRow[] = [];
  let milestone = false;
  let changed = false;
  let urgent = false;
  const headlines: string[] = [];

  for (const row of rows) {
    const prev = row.last_status ? (JSON.parse(row.last_status) as FlightStatus) : null;
    const ident = `${row.airline}${row.number}`;
    const label = `${row.member_name} ${ident} ${row.origin}→${row.dest} ${row.date}`;

    // First sight always fetches, to learn scheduled_out. After that, only the
    // travel day earns a call; the rest of the month rides on the stored copy.
    const wantFetch = !prev || isActive(prev.scheduledOut, now);
    let next: FlightStatus | null = prev;
    if (wantFetch) {
      try {
        next = await deps.fetchStatus({ ident, date: row.date, origin: row.origin }, { offline });
      } catch (err) {
        log.warn(offline ? 'nothing cached, skipping' : 'status fetch failed', { flight: label, error: String(err) });
      }
    }

    if (next && next !== prev) {
      const diff = diffStatus(prev, next);
      if (diff.changed) {
        changed = true;
        headlines.push(`${row.member_name} ${ident}: ${diff.reasons.join(', ')}`);
        log.info('flight changed', { flight: label, reasons: diff.reasons, urgent: diff.urgent });
      }
      urgent ||= diff.urgent;
      db.prepare('UPDATE flights SET last_status = ?, last_checked_at = ? WHERE id = ?').run(
        JSON.stringify(next),
        now.toISOString(),
        row.id,
      );
    }

    if (next && isMilestone(next.scheduledOut, now)) milestone = true;
    table.push({ member: row.member_name, flight: ident, origin: row.origin, dest: row.dest, status: next });
  }

  if (!milestone && !changed) {
    log.info('quiet — nothing in window, nothing changed', { flights: rows.length });
    return;
  }

  const title = urgent
    ? '🚨 **Flight watch**'
    : changed
      ? '✈️ **Flight watch** — update'
      : `✈️ **Flight watch** — ${milestoneLabel(table, now)}`;
  const body = [title, ...headlines.map((h) => `• ${h}`), renderFlightTable(table)].join('\n');

  if (urgent) {
    await poster.postRoot(body, { urgent: true });
    return;
  }
  const anchorId = findAnchor(db, ctx.target);
  if (anchorId) {
    const threadId = await poster.ensureThread(anchorId, 'Flight watch');
    await poster.postThread(threadId, body);
  } else {
    log.info('no Aspen anchor yet — posting flight watch to root');
    await poster.postRoot(body);
  }
}

/** Hourly, from a few days before the first departure until the last arrival. */
export const flightWatchJob: Job = {
  name: 'flightWatch',
  run: (ctx) =>
    runFlightWatch(ctx, {
      fetchStatus: async (params, { offline }) =>
        (await cached(ctx.db, flightStatus, params, { offline, now: ctx.now })).value,
    }),
};

/* ---------------------------------------------------------------- helpers */

function loadFlights(db: DB): FlightRow[] {
  return db
    .prepare(
      `SELECT f.id, m.name AS member_name, f.airline, f.number, f.date, f.origin, f.dest,
              f.last_status, f.last_checked_at
       FROM flights f JOIN members m ON m.id = f.member_id
       ORDER BY f.date, f.id`,
    )
    .all() as FlightRow[];
}

/** Packet 5 owns the anchor's kv key; we only need *an* anchor to hang a
 *  thread off, preferring the one for the channel we are posting to. */
function findAnchor(db: DB, target: string): string | undefined {
  const rows = db
    .prepare(`SELECT key, value FROM kv WHERE key LIKE 'anchor:%' ORDER BY key`)
    .all() as { key: string; value: string }[];
  const mine = rows.find((r) => r.key === `anchor:${target}` || r.key.endsWith(`:${target}`));
  return (mine ?? rows[0])?.value;
}

function milestoneLabel(table: readonly TableRow[], now: Date): string {
  const first = table.find((r) => r.status && isMilestone(r.status.scheduledOut, now));
  if (!first?.status) return 'check-in';
  const hours = (Date.parse(first.status.scheduledOut) - now.getTime()) / HOUR;
  return Math.abs(hours - 24) < Math.abs(hours - 3) ? 'T-24h' : 'T-3h';
}

function statusCell(s: FlightStatus): string {
  if (s.status === 'delayed' && s.delayMin) return `delayed ${fmtDelay(s.delayMin)}`;
  if (s.gate && (s.status === 'scheduled' || s.status === 'delayed')) return `${s.status} · gate ${s.gate}`;
  return s.status;
}

function fmtDelay(min: number | null): string {
  if (min === null) return 'n/a';
  return min >= 0 ? `+${min}m` : `${min}m`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toISOString().slice(11, 16);
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
