import type { Destination, Member } from './config.js';
import type { FlightQuote, FlightSearch } from './sources/flights.js';

/**
 * The convergence solver from PLAN.md §0.
 *
 * Two East Coast members and three in California means every plan is a
 * question of where the group buys its flights. Two strategies are computed
 * for every build, side by side:
 *
 *   - independent: everyone flies from whichever of their own priced airports
 *     is cheapest all-in, and we check that the arrivals land inside the
 *     shared window.
 *   - consolidate-west: the California members drive to a hub (LAX, or SFO for
 *     the Bay Area) and buy the same itinerary, positioning cost included.
 *
 * Two different numbers do two different jobs: the raw fare delta between
 * home and hub is what the "worth the drive" threshold is judged on, and the
 * all-in figure (fare + positioning) is what the group total is built from.
 *
 * Pure: quotes are handed in already fetched, keyed by origin IATA. No I/O,
 * no clock.
 */

export type StrategyName = 'independent' | 'consolidate-west';

/** One `FlightSearch` per priced origin, plus LAX/SFO when consolidation is
 *  on the table. `null` means the search ran and came back empty or failed. */
export type RoutingQuotes = Record<string, FlightSearch | null>;

export type RoutingOptions = {
  /** Everyone must land inside this many hours of each other. From config. */
  arrivalWindowHours: number;
  /** Fare saving a member needs to see before we tell them to drive to the hub. */
  driveDeltaThresholdUsd?: number;
  /** Keyed `HOME->HUB`, e.g. `BUR->LAX`. Round trip, per person. */
  positioningUsd?: Record<string, number>;
};

export const DEFAULT_DRIVE_DELTA_USD = 150;

/** Gas or a rideshare each way. An estimate, not a quote — every route that
 *  uses one says so in its note. */
export const DEFAULT_POSITIONING_USD: Record<string, number> = {
  'BUR->LAX': 40,
  'SNA->LAX': 40,
  'OAK->SFO': 40,
  'SJC->SFO': 40,
};

/** Where each California airport consolidates to. */
export const WEST_HUBS: Record<string, 'LAX' | 'SFO'> = {
  LAX: 'LAX',
  BUR: 'LAX',
  SNA: 'LAX',
  SFO: 'SFO',
  OAK: 'SFO',
  SJC: 'SFO',
};

export type MemberRoute = {
  member: string;
  /** The airport they'd book from. The home airport when nothing priced. */
  origin: string;
  /** Round-trip fare, before positioning. null when unpriced. */
  priceUsd: number | null;
  /** Estimated cost of getting to `origin` when it isn't the home airport. */
  positioningUsd: number;
  /** Fare plus positioning; what the group total is built from. */
  allInUsd: number | null;
  arriveAt: string | null;
  quote: FlightQuote | null;
  /** Raw fare difference against the member's alternative airport, before
   *  positioning: the `vs` fare minus this fare, so positive means this
   *  origin is cheaper. Negative under consolidation means the hub costs more. */
  delta?: { vs: string; usd: number };
  /** True when the member is being sent to a hub that isn't their home airport. */
  viaHub: boolean;
  unpriced: boolean;
  note: string;
};

export type Strategy = {
  name: StrategyName;
  perMember: MemberRoute[];
  /** Sum of `allInUsd` over priced members. */
  groupTotalUsd: number;
  perPersonAvgUsd: number;
  /** Hours between the first and last arrival; null when fewer than two
   *  members have a parseable arrival time. */
  arrivalSpreadHours: number | null;
  /** null when the spread is unknown. */
  feasible: boolean | null;
  /** Members whose fare could not be established under this strategy. */
  unpriced: string[];
};

export type Routing = {
  independent: Strategy;
  consolidateWest: Strategy;
  recommended: StrategyName;
  reason: string;
  /** One line per member with a drive-or-not decision, e.g.
   *  `Elliot: BUR $684 / LAX $511 — worth the drive (...)`. */
  deltaLines: string[];
};

type Positioning = Record<string, number>;

export function solveRouting(
  members: Member[],
  dest: Destination,
  quotes: RoutingQuotes,
  opts: RoutingOptions,
): Routing {
  const threshold = opts.driveDeltaThresholdUsd ?? DEFAULT_DRIVE_DELTA_USD;
  const positioning: Positioning = { ...DEFAULT_POSITIONING_USD, ...(opts.positioningUsd ?? {}) };

  const independent = summarize(
    'independent',
    members.map((m) => independentRoute(m, quotes, positioning)),
    opts.arrivalWindowHours,
  );
  const consolidateWest = summarize(
    'consolidate-west',
    members.map((m) => consolidatedRoute(m, quotes, positioning, threshold)),
    opts.arrivalWindowHours,
  );

  const deltaLines = members
    .map((m) => deltaLine(m, quotes, positioning, threshold))
    .filter((l): l is string => l !== null);

  const { recommended, reason } = recommend(independent, consolidateWest, threshold, dest);
  return { independent, consolidateWest, recommended, reason, deltaLines };
}

/* ----------------------------------------------------------- strategies */

/** Cheapest all-in among the member's own priced airports. A $19 saving at
 *  LAX is not a saving once the drive is counted, so positioning is in the
 *  comparison, not just the total. */
function independentRoute(m: Member, quotes: RoutingQuotes, positioning: Positioning): MemberRoute {
  const home = homeOf(m);
  const priced = pricedOrigins(m, quotes)
    .map((p) => {
      const move = p.origin === home ? 0 : (positioning[`${home}->${p.origin}`] ?? 0);
      return { ...p, move, allIn: dollars(p.price + move) };
    })
    .sort((a, b) => a.allIn - b.allIn);
  const best = priced[0];
  if (!best) {
    return unpricedRoute(m, home, `${m.name}: no fare from ${m.pricedAirports.join('/')}`);
  }
  const runnerUp = priced[1];
  const missing = m.pricedAirports.filter((o) => !priced.some((p) => p.origin === o));
  const notes = [`${m.name}: ${best.origin} $${best.price}`];
  if (best.move > 0) notes.push(positioningNote(best.move, best.origin));
  if (missing.length) notes.push(`no fare from ${missing.join('/')}`);
  const route: MemberRoute = {
    member: m.name,
    origin: best.origin,
    priceUsd: best.price,
    positioningUsd: best.move,
    allInUsd: best.allIn,
    arriveAt: best.quote.arriveAt || null,
    quote: best.quote,
    viaHub: false,
    unpriced: false,
    note: notes.join('; '),
  };
  if (runnerUp) route.delta = { vs: runnerUp.origin, usd: dollars(runnerUp.price - best.price) };
  return route;
}

function consolidatedRoute(
  m: Member,
  quotes: RoutingQuotes,
  positioning: Positioning,
  threshold: number,
): MemberRoute {
  const home = homeOf(m);
  const hub = hubFor(m);
  // East Coast members have no hub; they fly independently under both strategies.
  if (!hub) return independentRoute(m, quotes, positioning);

  const hubQuote = quotes[hub]?.cheapest ?? null;
  if (!hubQuote) {
    // The hub search failed, so fall back to their own best fare rather than
    // pretend consolidation priced everyone.
    const fallback = independentRoute(m, quotes, positioning);
    return { ...fallback, note: `${fallback.note}; no ${hub} fare, so not consolidated` };
  }

  const fare = dollars(hubQuote.priceUsd);
  const move = hub === home ? 0 : (positioning[`${home}->${hub}`] ?? 0);
  const notes = [`${m.name}: ${hub} $${fare}`];
  if (move > 0) notes.push(positioningNote(move, hub));
  const route: MemberRoute = {
    member: m.name,
    origin: hub,
    priceUsd: fare,
    positioningUsd: move,
    allInUsd: fare + move,
    arriveAt: hubQuote.arriveAt || null,
    quote: hubQuote,
    viaHub: hub !== home,
    unpriced: false,
    note: notes.join('; '),
  };
  const homeFare = quotes[home]?.cheapest?.priceUsd ?? null;
  if (hub !== home && homeFare !== null) {
    const saved = dollars(homeFare - fare);
    route.delta = { vs: home, usd: saved };
    route.note += `; ${verdict(saved, home, hub, move, threshold)}`;
  }
  return route;
}

function unpricedRoute(m: Member, origin: string, note: string): MemberRoute {
  return {
    member: m.name,
    origin,
    priceUsd: null,
    positioningUsd: 0,
    allInUsd: null,
    arriveAt: null,
    quote: null,
    viaHub: false,
    unpriced: true,
    note,
  };
}

function summarize(name: StrategyName, perMember: MemberRoute[], windowHours: number): Strategy {
  const priced = perMember.filter((r) => r.allInUsd !== null);
  const groupTotalUsd = priced.reduce((s, r) => s + (r.allInUsd ?? 0), 0);
  const arrivalSpreadHours = spreadHours(perMember.map((r) => r.arriveAt));
  return {
    name,
    perMember,
    groupTotalUsd,
    perPersonAvgUsd: priced.length ? Math.round(groupTotalUsd / priced.length) : 0,
    arrivalSpreadHours,
    feasible: arrivalSpreadHours === null ? null : arrivalSpreadHours <= windowHours,
    unpriced: perMember.filter((r) => r.unpriced).map((r) => r.member),
  };
}

/* ------------------------------------------------------------ decision */

function recommend(
  ind: Strategy,
  con: Strategy,
  threshold: number,
  dest: Destination,
): { recommended: StrategyName; reason: string } {
  // Consolidation must not have lost anyone the independent solve priced.
  const nobodyLost = con.unpriced.length <= ind.unpriced.length;
  const saving = ind.groupTotalUsd - con.groupTotalUsd;
  const moved = con.perMember.filter((r) => r.viaHub && r.delta);
  const driversWin = moved.length > 0 && moved.every((r) => (r.delta?.usd ?? 0) > threshold);

  if (ind.feasible === false && con.feasible !== false) {
    return {
      recommended: 'consolidate-west',
      reason:
        `Flying independently spreads arrivals at ${dest.airport} over ` +
        `${ind.arrivalSpreadHours}h; consolidating brings that to ` +
        `${con.arrivalSpreadHours ?? '?'}h and ` +
        (saving >= 0 ? `saves the group $${dollars(saving)}.` : `costs $${dollars(-saving)} more.`),
    };
  }
  // `>= 0`: when the hub already wins on fare, the independent solve picks it
  // too and the totals tie — consolidation is still the call because it puts
  // the drivers on the same itinerary.
  if (nobodyLost && saving >= 0 && driversWin) {
    const who = moved.map((r) => r.member).join(', ');
    return {
      recommended: 'consolidate-west',
      reason:
        `${who} each save more than $${threshold} on the fare by driving to the hub; ` +
        `group total $${con.groupTotalUsd} all-in` +
        (saving > 0 ? ` ($${dollars(saving)} under flying independently).` : '.'),
    };
  }
  if (!nobodyLost) {
    return {
      recommended: 'independent',
      reason: `Hub fares are missing for ${con.unpriced.join(', ')}; everyone books their own.`,
    };
  }
  const why =
    saving < 0
      ? `consolidating would cost the group $${dollars(-saving)} more`
      : moved.length === 0
        ? 'there is no hub fare to consolidate on'
        : `the drivers save $${moved.map((r) => r.delta?.usd ?? 0).join('/')} on the fare, under the $${threshold} bar`;
  return {
    recommended: 'independent',
    reason:
      `Everyone flies from home: ${why}` +
      (ind.feasible === null ? '; arrival spread unknown.' : '.'),
  };
}

/* -------------------------------------------------------------- deltas */

/** "Elliot: BUR $684 / LAX $511 — worth the drive (...)". Only for members
 *  who have a real choice: two priced airports, or a hub priced next to home. */
function deltaLine(
  m: Member,
  quotes: RoutingQuotes,
  positioning: Positioning,
  threshold: number,
): string | null {
  const home = m.pricedAirports[0] ?? m.airports[0];
  if (!home) return null;
  const hub = hubFor(m);
  const alternatives = new Set<string>(m.pricedAirports.slice(1));
  if (hub && hub !== home) alternatives.add(hub);
  if (alternatives.size === 0) return null;

  const fares = [home, ...alternatives].map((o) => ({
    origin: o,
    price: quotes[o]?.cheapest?.priceUsd ?? null,
  }));
  const list = fares
    .map((f) => `${f.origin} ${f.price === null ? 'n/a' : `$${dollars(f.price)}`}`)
    .join(' / ');
  const homeFare = fares[0]?.price ?? null;
  const priced = fares
    .slice(1)
    .filter((f): f is { origin: string; price: number } => f.price !== null)
    .sort((a, b) => a.price - b.price);
  if (homeFare === null) {
    const tail = priced[0] ? `no ${home} fare, fly from ${priced[0].origin}` : 'nothing priced';
    return `${m.name}: ${list} — ${tail}`;
  }
  const best = priced[0];
  if (!best) return `${m.name}: ${list} — only ${home} priced`;

  const move = positioning[`${home}->${best.origin}`] ?? 0;
  const saved = dollars(homeFare - best.price);
  return `${m.name}: ${list} — ${verdict(saved, home, best.origin, move, threshold)}`;
}

/** `saved` is the raw fare difference; the positioning estimate is shown
 *  beside it rather than netted out, so the reader sees both numbers. */
function verdict(
  saved: number,
  home: string,
  alt: string,
  move: number,
  threshold: number,
): string {
  const drive = move > 0 ? `, figure ~$${move} to get to ${alt}` : '';
  if (saved > threshold) return `worth the drive ($${saved} cheaper${drive})`;
  if (saved > 0) return `${alt} is only $${saved} cheaper${drive} — fly from ${home}`;
  if (saved === 0) return `same price, fly from ${home}`;
  return `fly from ${home} (${alt} is $${-saved} more)`;
}

/* ------------------------------------------------------------- helpers */

function positioningNote(move: number, hub: string): string {
  return `+ ~$${move} to get to ${hub} (estimate: gas or rideshare)`;
}

function homeOf(m: Member): string {
  return m.pricedAirports[0] ?? m.airports[0] ?? '???';
}

function pricedOrigins(
  m: Member,
  quotes: RoutingQuotes,
): { origin: string; price: number; quote: FlightQuote }[] {
  return m.pricedAirports.flatMap((origin) => {
    const q = quotes[origin]?.cheapest;
    return q ? [{ origin, price: dollars(q.priceUsd), quote: q }] : [];
  });
}

/** The hub a member consolidates through, or null for anyone not in California. */
export function hubFor(m: Member): 'LAX' | 'SFO' | null {
  for (const a of m.airports) {
    const hub = WEST_HUBS[a];
    if (hub) return hub;
  }
  return null;
}

/** Origins a build must price so both strategies can be solved. */
export function originsToPrice(members: Member[]): string[] {
  const out = new Set<string>();
  for (const m of members) {
    for (const a of m.pricedAirports) out.add(a);
    const hub = hubFor(m);
    if (hub) out.add(hub);
  }
  return [...out];
}

/**
 * Hours between the earliest and latest arrival. SerpApi gives destination-
 * local wall-clock times ("2027-02-07 21:05"); every member lands at the same
 * airport, so the times compare directly without a timezone.
 */
export function spreadHours(arrivals: (string | null)[]): number | null {
  const ts = arrivals.map(parseLocal).filter((t): t is number => t !== null);
  if (ts.length < 2) return null;
  return Math.round(((Math.max(...ts) - Math.min(...ts)) / 3_600_000) * 10) / 10;
}

function parseLocal(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y!, mo! - 1, d, h, mi);
}

function dollars(n: number): number {
  return Math.round(n);
}
