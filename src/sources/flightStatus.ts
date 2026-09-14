import { requireSecret } from '../config.js';
import type { Source } from './types.js';

export const AEROAPI_URL = 'https://aeroapi.flightaware.com/aeroapi';

export type FlightStatusParams = {
  /** Airline code + number, e.g. `UA1234`. IATA or ICAO both resolve. */
  ident: string;
  /** Departure date, YYYY-MM-DD, in the origin's local day. */
  date: string;
  /** IATA airport code, used to disambiguate multi-leg idents. */
  origin: string;
};

export type FlightStatusKind =
  | 'scheduled'
  | 'delayed'
  | 'departed'
  | 'arrived'
  | 'cancelled'
  | 'diverted'
  | 'unknown';

/** What the watch job stores in `flights.last_status` and diffs between runs.
 *  Every timestamp is an ISO-8601 UTC string straight from AeroAPI. */
export type FlightStatus = {
  ident: string;
  date: string;
  origin: string;
  dest: string;
  status: FlightStatusKind;
  scheduledOut: string;
  estimatedOut: string | null;
  actualOut: string | null;
  scheduledIn: string | null;
  estimatedIn: string | null;
  /** Departure delay in minutes; negative means early; null when AeroAPI has no opinion. */
  delayMin: number | null;
  gate?: string | null;
  terminal?: string | null;
  /** The raw payload is deliberately not kept: it is large and the cache row is the audit trail. */
  raw?: never;
};

/** The subset of AeroAPI v4's `/flights/{ident}` entries we read. */
export type AeroApiFlight = {
  ident?: string;
  ident_iata?: string | null;
  ident_icao?: string | null;
  status?: string | null;
  cancelled?: boolean;
  diverted?: boolean;
  scheduled_out?: string | null;
  estimated_out?: string | null;
  actual_out?: string | null;
  actual_off?: string | null;
  scheduled_in?: string | null;
  estimated_in?: string | null;
  actual_in?: string | null;
  /** Seconds. */
  departure_delay?: number | null;
  origin?: { code_iata?: string | null; code?: string | null } | null;
  destination?: { code_iata?: string | null; code?: string | null } | null;
  gate_origin?: string | null;
  terminal_origin?: string | null;
};

export type AeroApiResponse = { flights?: AeroApiFlight[] };

/**
 * Pick the matching leg out of AeroAPI's answer and flatten it.
 *
 * `/flights/{ident}` returns every leg flying under that number across the
 * date range, so a through-flight (SFO→DEN→ASE as UA1234) shows up twice. The
 * origin filter picks the leg; the date match picks the day. Because
 * `scheduled_out` is UTC, an evening west-coast departure lands on the next
 * UTC date, so an origin-only match within a day of the request is accepted
 * when nothing matches the calendar date exactly.
 */
export function parseAeroApi(json: unknown, sel: { date: string; origin: string }): FlightStatus {
  const flights = (json as AeroApiResponse | null)?.flights;
  if (!Array.isArray(flights)) throw new Error('aeroapi: response has no flights array');

  const origin = sel.origin.toUpperCase();
  const legs = flights.filter((f) => f.scheduled_out && airportCode(f.origin) === origin);
  const exact = legs.find((f) => f.scheduled_out!.slice(0, 10) === sel.date);
  const noon = Date.parse(`${sel.date}T12:00:00Z`);
  const near = legs
    .filter((f) => Math.abs(Date.parse(f.scheduled_out!) - noon) <= 36 * 3_600_000)
    .sort((a, b) => Math.abs(Date.parse(a.scheduled_out!) - noon) - Math.abs(Date.parse(b.scheduled_out!) - noon))[0];
  const leg = exact ?? near;
  if (!leg) {
    throw new Error(`aeroapi: no leg from ${origin} on ${sel.date} among ${flights.length} result(s)`);
  }

  const delaySec = leg.departure_delay;
  return {
    ident: leg.ident_iata ?? leg.ident ?? leg.ident_icao ?? '',
    date: sel.date,
    origin,
    dest: airportCode(leg.destination) ?? '',
    status: classify(leg),
    scheduledOut: leg.scheduled_out!,
    estimatedOut: leg.estimated_out ?? null,
    actualOut: leg.actual_out ?? leg.actual_off ?? null,
    scheduledIn: leg.scheduled_in ?? null,
    estimatedIn: leg.estimated_in ?? null,
    delayMin: typeof delaySec === 'number' ? Math.round(delaySec / 60) : null,
    gate: leg.gate_origin ?? null,
    terminal: leg.terminal_origin ?? null,
  };
}

/**
 * AeroAPI's `status` is free text ("Scheduled / Delayed", "En Route / On
 * Time", "Arrived / Delayed"...). The boolean flags and the actual_* stamps are
 * the reliable signal; the text only breaks ties between scheduled and delayed.
 */
function classify(f: AeroApiFlight): FlightStatusKind {
  if (f.cancelled) return 'cancelled';
  if (f.diverted) return 'diverted';
  const text = (f.status ?? '').toLowerCase();
  if (f.actual_in || text.startsWith('arrived') || text.startsWith('landed')) return 'arrived';
  if (f.actual_out || f.actual_off || /en route|taxiing|left gate|airborne/.test(text)) return 'departed';
  if (text.includes('delayed') || (f.departure_delay ?? 0) >= 15 * 60) return 'delayed';
  if (text.includes('scheduled') || text.includes('on time')) return 'scheduled';
  return 'unknown';
}

function airportCode(a: AeroApiFlight['origin']): string | undefined {
  const code = a?.code_iata ?? a?.code;
  return code ? code.toUpperCase() : undefined;
}

export async function fetchAeroApi(ident: string, date: string): Promise<unknown> {
  const key = requireSecret('FLIGHTAWARE_API_KEY');
  // Two days past the requested date so a late local departure that falls on
  // the next UTC day is still inside the range.
  const end = new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  const url = `${AEROAPI_URL}/flights/${encodeURIComponent(ident)}?start=${date}&end=${end}`;
  const res = await fetch(url, { headers: { 'x-apikey': key, accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`aeroapi ${res.status} for ${ident}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Status is worth re-asking about every 20 minutes on the day; the watch job
 *  only fetches inside its windows anyway, so this mostly dedupes hourly runs. */
export const flightStatus: Source<FlightStatusParams, FlightStatus> = {
  name: 'aeroapi:flight-status',
  key: (p) => `${p.ident.toUpperCase()}:${p.date}:${p.origin.toUpperCase()}`,
  ttlMinutes: () => 20,
  fetch: async (p) => parseAeroApi(await fetchAeroApi(p.ident, p.date), p),
};
