import type { Config, Destination } from './config.js';
import type { DB } from './db.js';
import type { JobContext } from './jobs/_runner.js';
import { originsToPrice, solveRouting, type Routing } from './routing.js';
import { cached } from './sources/_cache.js';
import { estimateCost, type CostBreakdown } from './sources/cost.js';
import {
  flights as flightsSource,
  searchFlights,
  searchFlightsFlex,
  shiftDate,
  type FlexResult,
  type FlightSearch,
} from './sources/flights.js';
import { lodging as lodgingSource, nightsBetween, searchLodging } from './sources/lodging.js';
import type { LodgingOption, LodgingSearch, LodgingType } from './sources/lodging.js';
import {
  groundTransportLookup,
  passStatusLookup,
  type GroundTransport,
  type LookupResult,
  type PassStatus,
} from './sources/lookup.js';
import { buildSnowReport, type Confidence, type SnowReport } from './sources/weather/consensus.js';
import { crosscheckFor } from './sources/weather/crosscheck.js';
import { ecmwfAifs, ecmwfIfs } from './sources/weather/ecmwf.js';
import type { ModelForecast } from './sources/weather/types.js';
import { weathernextSource, type WeatherNextForecast } from './sources/weather/weathernext.js';

/**
 * Assemble one complete, bookable `Expedition` from inputs that have already
 * been fetched. `buildExpedition` is pure data, no prose — Packet 13 hands the
 * object to Sonnet and Sonnet writes the dossier from it, quoting numbers it
 * finds here and nothing else.
 *
 * `gatherExpeditionInputs` at the bottom is the only I/O and is deliberately
 * thin: one call per source, failures degrade to null so a missing lookup
 * produces an honest `unverified` field instead of no plan at all.
 */

export type DateWindow = { start: string; end: string };

export type ExpeditionInputs = {
  dest: Destination;
  /** Depart and return dates, inclusive. */
  window: DateWindow;
  flights: {
    /** One search per origin from `originsToPrice(members)`; null when it failed. */
    byOrigin: Record<string, FlightSearch | null>;
    /** The ±flex attempts for `anchorOrigin`, cheapest first. Drives the volatility note. */
    attempts: FlexResult['attempts'];
    anchorOrigin: string;
  };
  lodging: LodgingSearch | null;
  ground: LookupResult<GroundTransport> | null;
  /** From the live lookup only. A null here becomes `passes.status: 'unverified'`. */
  passes: LookupResult<PassStatus> | null;
  weather: SnowReport;
  /** Anything else that contributed — a weathernext namespace, an archive row. */
  extraSources?: string[];
};

export type DayPlan = {
  date: string;
  plannedAt: 'on-snow' | 'travel' | 'rest';
  reason: string;
};

export type ExpeditionLodging = {
  name: string;
  type: LodgingType | 'band';
  nights: number;
  perPersonPerNightUsd: number;
  perPersonUsd: number;
  /** Whole property for the stay; null when only the band is known. */
  totalUsd: number | null;
  /** True when the number is the board's lodging band, not a priced listing. */
  estimated: boolean;
  link: string | null;
  note: string;
};

export type ExpeditionGround =
  | {
      status: 'looked-up';
      options: GroundTransport['options'];
      /** Cheapest option, round trip, per person; null when no option had a price. */
      perPersonUsd: number | null;
      sources: string[];
    }
  | {
      status: 'unverified';
      /** The board's one-line hint, e.g. "Bus CTS -> Hirafu". Not a price. */
      description: string;
      perPersonUsd: null;
    };

export type ExpeditionPasses =
  | {
      status: 'verified';
      pass: 'IKON';
      covered: boolean | null;
      daysIncluded: number | null;
      blackoutDates: string[];
      /** The subset of blackout dates that fall inside the window. */
      blackoutsInWindow: string[];
      notes: string;
      sources: string[];
      askedAt: string;
    }
  | { status: 'unverified' };

export type Expedition = {
  /** `<dest-id>-<MMDD>` of the departure date, e.g. `niseko-0206`. */
  id: string;
  destination: Destination;
  window: DateWindow;
  daysTotal: number;
  daysOnSnow: number;
  /** Weekdays inside the window — days off work the trip costs. */
  workingDays: number;
  minDaysNote: string;
  routing: Routing;
  lodging: ExpeditionLodging;
  ground: ExpeditionGround;
  passes: ExpeditionPasses;
  weather: { report: SnowReport; dayPlan: DayPlan[] };
  cost: {
    perMember: CostBreakdown[];
    /** Average over priced members. */
    perPersonUsd: number;
    groupUsd: number;
    ceilingUsd: number;
    overCeiling: boolean;
  };
  volatility: { note: string; decideBy: string };
  confidence: Confidence;
  /** Every cache namespace and URL that contributed. */
  sources: string[];
  asOf: string;
};

const DAY_MS = 86_400_000;
/** Book at least this far out; long-haul fares move well before then. */
const DECIDE_BY_LEAD_DAYS = 21;
/** But never sit on a plan longer than this — the point is to commit. */
const DECIDE_BY_MAX_WAIT_DAYS = 14;
/** A rest day is only worth its cost on a long trip. */
const REST_DAY_MIN_TOTAL = 8;

export function buildExpedition(inputs: ExpeditionInputs, cfg: Config, now: Date): Expedition {
  const { dest, window } = inputs;
  const nights = nightsBetween(window.start, window.end);
  const daysTotal = nights + 1;

  const routing = solveRouting(cfg.members, dest, inputs.flights.byOrigin, {
    arrivalWindowHours: cfg.expedition.arrival_window_hours,
  });
  const lodging = lodgingFor(inputs.lodging, dest, nights);
  const ground = groundFor(inputs.ground, dest);
  const passes = passesFor(inputs.passes, window);
  const dayPlan = planDays(window, inputs.weather, routing);
  const daysOnSnow = dayPlan.filter((d) => d.plannedAt === 'on-snow').length;
  const cost = costFor(inputs, cfg, routing, ground);

  return {
    id: expeditionId(dest, window),
    destination: dest,
    window,
    daysTotal,
    daysOnSnow,
    workingDays: weekdaysIn(window),
    minDaysNote: minDaysNote(dest, daysTotal, daysOnSnow),
    routing,
    lodging,
    ground,
    passes,
    weather: { report: inputs.weather, dayPlan },
    cost,
    volatility: volatilityFor(inputs.flights, window, now),
    confidence: inputs.weather.confidence,
    sources: sourcesFor(inputs),
    asOf: now.toISOString(),
  };
}

export function expeditionId(dest: Destination, window: DateWindow): string {
  return `${dest.id}-${window.start.slice(5, 7)}${window.start.slice(8, 10)}`;
}

/* ------------------------------------------------------------ lodging */

function lodgingFor(
  search: LodgingSearch | null,
  dest: Destination,
  nights: number,
): ExpeditionLodging {
  const pick: LodgingOption | null = search?.pick ?? null;
  if (pick) {
    return {
      name: pick.name,
      type: pick.type,
      nights,
      perPersonPerNightUsd: pick.perPersonPerNightUsd,
      perPersonUsd: Math.round(pick.perPersonPerNightUsd * nights),
      totalUsd: pick.totalUsd,
      estimated: false,
      link: pick.link,
      note:
        `${pick.name}, $${Math.round(pick.totalUsd)} for ${nights} nights` +
        (pick.sleeps !== null
          ? `, sleeps ${pick.sleeps}`
          : ', sleeps unknown — check before booking') +
        (pick.rating !== null ? `, rated ${pick.rating}` : ''),
    };
  }
  const [lo, hi] = dest.lodging_band_usd_pp_night;
  const mid = (lo + hi) / 2;
  return {
    name: `${dest.name} lodging band`,
    type: 'band',
    nights,
    perPersonPerNightUsd: mid,
    perPersonUsd: Math.round(mid * nights),
    totalUsd: null,
    estimated: true,
    link: null,
    note: `no listing priced; using the board's $${lo}–$${hi}/pp/night band at its midpoint`,
  };
}

/* ------------------------------------------------------------- ground */

function groundFor(
  lookup: LookupResult<GroundTransport> | null,
  dest: Destination,
): ExpeditionGround {
  if (!lookup) return { status: 'unverified', description: dest.ground, perPersonUsd: null };
  const prices = lookup.data.options
    .map((o) => o.priceUsdPp)
    .filter((p): p is number => p !== null && p >= 0);
  return {
    status: 'looked-up',
    options: lookup.data.options,
    perPersonUsd: prices.length ? Math.round(Math.min(...prices) * 2) : null,
    sources: lookup.sources,
  };
}

/* ------------------------------------------------------------- passes */

/** Passes come from the lookup or not at all. `dest.pass_verify` exists so
 *  nobody is tempted to put an IKON answer in config.yaml; nothing here reads it. */
function passesFor(lookup: LookupResult<PassStatus> | null, window: DateWindow): ExpeditionPasses {
  if (!lookup) return { status: 'unverified' };
  const d = lookup.data;
  return {
    status: 'verified',
    pass: 'IKON',
    covered: d.covered,
    daysIncluded: d.daysIncluded,
    blackoutDates: d.blackoutDates,
    blackoutsInWindow: d.blackoutDates.filter((b) => b >= window.start && b <= window.end),
    notes: d.notes,
    sources: lookup.sources,
    askedAt: lookup.askedAt,
  };
}

/* ----------------------------------------------------------- day plan */

/**
 * Travel days at both ends (plus the arrival day when the flight lands a
 * calendar day after it leaves — long-haul east of the dateline). Every other
 * day is on snow, except one rest day on a long trip, which goes on the
 * lightest forecast day so the biggest one is never wasted.
 */
export function planDays(window: DateWindow, report: SnowReport, routing: Routing): DayPlan[] {
  const dates = datesIn(window);
  const snowByDate = new Map<string, number | null>();
  for (const day of report.days) {
    const vals = Object.values(day.base).filter((v): v is number => v !== null);
    snowByDate.set(day.date, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  }

  const travel = new Set<string>([window.start, window.end]);
  const lastArrival = latestArrivalDate(routing);
  if (lastArrival && lastArrival > window.start && lastArrival < window.end)
    travel.add(lastArrival);

  const candidates = dates.filter((d) => !travel.has(d));
  const forecast = candidates.filter((d) => snowByDate.get(d) != null);
  let rest: string | null = null;
  if (dates.length >= REST_DAY_MIN_TOTAL && candidates.length > 1) {
    // Prefer the lightest forecast day; with no forecast at all, the midpoint.
    rest =
      forecast.length > 0
        ? forecast.reduce((lo, d) =>
            (snowByDate.get(d) ?? 0) < (snowByDate.get(lo) ?? 0) ? d : lo,
          )
        : candidates[Math.floor(candidates.length / 2)]!;
  }
  const biggest =
    forecast.length > 0
      ? forecast.reduce((hi, d) => ((snowByDate.get(d) ?? 0) > (snowByDate.get(hi) ?? 0) ? d : hi))
      : null;

  return dates.map((date) => {
    if (travel.has(date)) {
      const why =
        date === window.start
          ? 'fly out'
          : date === window.end
            ? 'fly home'
            : 'arrival day — lands after an overnight flight';
      return { date, plannedAt: 'travel', reason: why };
    }
    const cm = snowByDate.get(date);
    if (date === rest) {
      return {
        date,
        plannedAt: 'rest',
        reason:
          cm == null
            ? 'rest day, beyond the forecast horizon'
            : `lightest day in the forecast (${fmtCm(cm)})`,
      };
    }
    if (cm == null) return { date, plannedAt: 'on-snow', reason: 'beyond the forecast horizon' };
    if (date === biggest)
      return { date, plannedAt: 'on-snow', reason: `biggest forecast day, ${fmtCm(cm)}` };
    return { date, plannedAt: 'on-snow', reason: `${fmtCm(cm)} forecast` };
  });
}

function latestArrivalDate(routing: Routing): string | null {
  const strategy =
    routing.recommended === 'independent' ? routing.independent : routing.consolidateWest;
  const dates = strategy.perMember
    .map((r) => r.arriveAt?.slice(0, 10) ?? null)
    .filter((d): d is string => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
}

function fmtCm(cm: number): string {
  return `${Math.round(cm)}cm`;
}

/* --------------------------------------------------------------- days */

export function weekdaysIn(window: DateWindow): number {
  return datesIn(window).filter((d) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow >= 1 && dow <= 5;
  }).length;
}

/** Honest, not encouraging. The board's `min_days` is the floor below which
 *  the flight isn't worth it; `ideal_days` is what the bot builds to. */
export function minDaysNote(dest: Destination, daysTotal: number, daysOnSnow: number): string {
  const ride = `${daysOnSnow} on snow`;
  if (daysTotal < dest.min_days) {
    return (
      `${daysTotal} days (${ride}) is under the ${dest.min_days}-day floor for ${dest.name} — ` +
      `you'd be paying the flight for ${daysOnSnow} days of riding.`
    );
  }
  if (daysTotal >= dest.ideal_days) {
    return `${daysTotal} days (${ride}) is the full ${dest.ideal_days}-day trip ${dest.name} deserves; the floor is ${dest.min_days}.`;
  }
  return (
    `${daysTotal} days (${ride}) clears the ${dest.min_days}-day floor for ${dest.name} ` +
    `but is short of the ${dest.ideal_days} that makes the flight pay off.`
  );
}

/* --------------------------------------------------------------- cost */

function costFor(
  inputs: ExpeditionInputs,
  cfg: Config,
  routing: Routing,
  ground: ExpeditionGround,
): Expedition['cost'] {
  const strategy =
    routing.recommended === 'independent' ? routing.independent : routing.consolidateWest;
  const quotes: Record<string, FlightSearch> = {};
  for (const [origin, s] of Object.entries(inputs.flights.byOrigin)) if (s) quotes[origin] = s;

  const perMember = cfg.members.map((m) => {
    const base = estimateCost(
      m,
      inputs.dest,
      { depart: inputs.window.start, return: inputs.window.end },
      { flightsByOrigin: quotes, lodging: inputs.lodging },
      ground.perPersonUsd === null ? {} : { groundUsdPp: ground.perPersonUsd },
    );
    const route = strategy.perMember.find((r) => r.member === m.name);
    // estimateCost picks the cheapest raw fare; the routing decision may send
    // this member somewhere else (a hub, or home once the drive is counted).
    if (!route || route.unpriced || route.allInUsd === null) return base;
    if (route.origin === base.chosenOrigin && route.positioningUsd === 0) return base;
    return {
      ...base,
      chosenOrigin: route.origin,
      flightUsd: route.allInUsd,
      totalUsd: route.allInUsd + base.lodgingUsd + base.groundUsd,
      notes: [...base.notes, `routing (${routing.recommended}): ${route.note}`],
    };
  });

  const priced = perMember.filter((c) => c.flightUsd !== null);
  const groupUsd = priced.reduce((s, c) => s + c.totalUsd, 0);
  const perPersonUsd = priced.length ? Math.round(groupUsd / priced.length) : 0;
  const ceilingUsd =
    inputs.dest.region === 'US'
      ? cfg.expedition.ceiling_usd.domestic
      : cfg.expedition.ceiling_usd.international;
  return { perMember, perPersonUsd, groupUsd, ceilingUsd, overCeiling: perPersonUsd > ceilingUsd };
}

/* --------------------------------------------------------- volatility */

function volatilityFor(
  flights: ExpeditionInputs['flights'],
  window: DateWindow,
  now: Date,
): Expedition['volatility'] {
  const lead = Date.parse(`${window.start}T00:00:00Z`) - DECIDE_BY_LEAD_DAYS * DAY_MS;
  const wait = now.getTime() + DECIDE_BY_MAX_WAIT_DAYS * DAY_MS;
  const decideBy = new Date(Math.min(lead, wait)).toISOString().slice(0, 10);

  const prices = flights.attempts.map((a) => a.priceUsd).filter((p): p is number => p !== null);
  let note: string;
  if (prices.length < 2) {
    note = `Only one dated fare from ${flights.anchorOrigin} was priced, so there is no read on how much the dates matter.`;
  } else {
    const lo = Math.round(Math.min(...prices));
    const hi = Math.round(Math.max(...prices));
    const swing = Math.round(((hi - lo) / lo) * 100);
    const shape =
      swing < 10
        ? 'flat across the dates — the price is the price'
        : swing < 30
          ? 'moves with the dates; the chosen days are the cheap ones'
          : 'swings hard with the dates; shifting a day either way costs real money';
    note = `${flights.anchorOrigin} fares across the ±${Math.max(...flights.attempts.map((a) => Math.abs(a.offsetDays)))}-day windows ran $${lo}–$${hi} (${swing}% spread): ${shape}.`;
  }
  return { note: `${note} Decide by ${decideBy}.`, decideBy };
}

/* ------------------------------------------------------------ sources */

function sourcesFor(inputs: ExpeditionInputs): string[] {
  const out = new Set<string>();
  if (Object.values(inputs.flights.byOrigin).some((s) => s !== null)) out.add(flightsSource.name);
  if (inputs.lodging) out.add(lodgingSource.name);
  if (inputs.ground) {
    out.add('lookup:ground-transport');
    for (const u of inputs.ground.sources) out.add(u);
  }
  if (inputs.passes) {
    out.add('lookup:pass-status');
    for (const u of inputs.passes.sources) out.add(u);
  }
  for (const m of inputs.weather.asOf.contributing) out.add(`open-meteo:${m}`);
  if (inputs.weather.asOf.weathernext) out.add('weathernext:bigquery');
  for (const s of inputs.extraSources ?? []) out.add(s);
  return [...out];
}

function datesIn(w: DateWindow): string[] {
  const out: string[] = [];
  for (let d = w.start; d <= w.end; d = shiftDate(d, 1)) out.push(d);
  return out;
}

/* ----------------------------------------------------------- database */

export type ExpeditionRow = {
  id: string;
  destination: string;
  window_start: string;
  window_end: string;
  days_total: number;
  days_on_snow: number;
  plan_json: string;
  total_pp_usd: number;
  confidence: Confidence;
  status: 'proposed' | 'watched' | 'retired';
  root_message_id?: string | null;
  thread_id?: string | null;
};

export function expeditionToRow(e: Expedition): ExpeditionRow {
  return {
    id: e.id,
    destination: e.destination.id,
    window_start: e.window.start,
    window_end: e.window.end,
    days_total: e.daysTotal,
    days_on_snow: e.daysOnSnow,
    plan_json: JSON.stringify(e),
    total_pp_usd: e.cost.perPersonUsd,
    confidence: e.confidence,
    status: 'proposed',
  };
}

/** `plan_json` is the whole object, so the columns are only there for SQL. */
export function rowToExpedition(row: Pick<ExpeditionRow, 'plan_json'>): Expedition {
  return JSON.parse(row.plan_json) as Expedition;
}

/** Insert, or refresh the plan of an existing id without touching its
 *  status or Discord ids — a rebuild of the same window is an update, not a
 *  second expedition. */
export function insertExpedition(db: DB, e: Expedition): void {
  const r = expeditionToRow(e);
  db.prepare(
    `INSERT INTO expeditions
       (id, destination, window_start, window_end, days_total, days_on_snow,
        plan_json, total_pp_usd, confidence, status)
     VALUES (@id, @destination, @window_start, @window_end, @days_total, @days_on_snow,
        @plan_json, @total_pp_usd, @confidence, @status)
     ON CONFLICT(id) DO UPDATE SET
       days_total = excluded.days_total,
       days_on_snow = excluded.days_on_snow,
       plan_json = excluded.plan_json,
       total_pp_usd = excluded.total_pp_usd,
       confidence = excluded.confidence`,
  ).run(r);
}

/* ------------------------------------------------------------ gather */

/**
 * The I/O half. Flex-searches the anchor origin (the first member's home
 * airport) to pick the dates, then prices every other origin on those exact
 * dates so the routing solver compares like with like. Each source that
 * fails becomes a null the builder knows how to flag; only the anchor search
 * is fatal, because without dates there is nothing to build.
 */
export async function gatherExpeditionInputs(
  ctx: Pick<JobContext, 'cfg' | 'db' | 'llm' | 'now' | 'log'>,
  dest: Destination,
  window: DateWindow,
  opts: { offline?: boolean } = {},
): Promise<ExpeditionInputs> {
  const { cfg, db, now } = ctx;
  const get = { offline: opts.offline ?? false, now };
  const origins = originsToPrice(cfg.members);
  const anchorOrigin = origins[0] ?? 'JFK';

  const flex = await searchFlightsFlex(
    db,
    cfg,
    { origin: anchorOrigin, dest: dest.airport, depart: window.start, return: window.end },
    cfg.flights.date_flex_days,
    get,
  );
  const chosen = { start: flex.depart, end: flex.return };
  const byOrigin: Record<string, FlightSearch | null> = { [anchorOrigin]: flex.search };
  for (const origin of origins.filter((o) => o !== anchorOrigin)) {
    byOrigin[origin] = await attempt(
      ctx,
      `flights ${origin}`,
      async () =>
        (
          await searchFlights(
            db,
            cfg,
            { origin, dest: dest.airport, depart: chosen.start, return: chosen.end },
            get,
          )
        ).value,
    );
  }

  const lodging = await attempt(
    ctx,
    'lodging',
    async () =>
      (
        await searchLodging(
          db,
          cfg,
          { resort: dest.name, checkIn: chosen.start, checkOut: chosen.end },
          get,
        )
      ).value,
  );
  const ground = await attempt(
    ctx,
    'ground lookup',
    async () =>
      (
        await cached(
          db,
          groundTransportLookup(ctx.llm),
          { airport: dest.airport, resort: dest.name },
          get,
        )
      ).value,
  );
  const passes = await attempt(
    ctx,
    'pass lookup',
    async () =>
      (
        await cached(
          db,
          passStatusLookup(ctx.llm),
          { resort: dest.name, pass: 'IKON', dates: chosen },
          get,
        )
      ).value,
  );

  const ttl = cfg.weather.cache_ttl_minutes.forecast;
  const forecastDays = cfg.weather.open_meteo.forecast_days;
  const base = { lat: dest.lat, lon: dest.lon, label: 'base', elevationM: dest.base_elevation_m };
  const models: ModelForecast[] = [];
  for (const src of [ecmwfIfs, ecmwfAifs, ...crosscheckFor(dest.region)]) {
    const f = await attempt(
      ctx,
      src.name,
      async () =>
        (await cached(db, src, { coord: base, forecastDays, ttlMinutes: ttl }, get)).value,
    );
    if (f) models.push(f);
  }
  const weathernext: WeatherNextForecast | null = cfg.bigquery.projectId
    ? await attempt(
        ctx,
        'weathernext',
        async () =>
          (
            await cached(
              db,
              weathernextSource(cfg),
              { coord: base, hours: forecastDays * 24, ttlMinutes: ttl },
              get,
            )
          ).value,
      )
    : null;

  // The forecast only reaches so far; the report window is clipped to it so a
  // day the models never saw is not quoted as "0cm".
  const horizon = shiftDate(now.toISOString().slice(0, 10), forecastDays - 1);
  const weather = buildSnowReport({
    window: { start: chosen.start, end: chosen.end < horizon ? chosen.end : horizon },
    base: models,
    ...(weathernext ? { weathernext } : {}),
    baseElevationM: dest.base_elevation_m,
    summitElevationM: dest.summit_elevation_m,
  });

  return {
    dest,
    window: chosen,
    flights: { byOrigin, attempts: flex.attempts, anchorOrigin },
    lodging,
    ground,
    passes,
    weather,
  };
}

async function attempt<T>(
  ctx: Pick<JobContext, 'log'>,
  what: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    ctx.log.warn('expedition input unavailable', { what, error: String(err) });
    return null;
  }
}
