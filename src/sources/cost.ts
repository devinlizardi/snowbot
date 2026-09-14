import type { Destination, Member } from '../config.js';
import type { FlightSearch } from './flights.js';
import type { FxTable } from './fx.js';
import { nightsBetween, type LodgingSearch } from './lodging.js';

export type CostQuotes = {
  /** Keyed by origin IATA; one search per entry in `member.pricedAirports`. */
  flightsByOrigin: Record<string, FlightSearch>;
  lodging: LodgingSearch | null;
  fx?: FxTable;
};

export type CostBreakdown = {
  member: string;
  originsPriced: { origin: string; priceUsd: number | null }[];
  /** Cheapest priced origin, or the member's first choice when nothing priced. */
  chosenOrigin: string;
  /** null when no origin returned a quote — the total then excludes the flight. */
  flightUsd: number | null;
  lodgingUsd: number;
  groundUsd: number;
  /** Whole dollars, per person. */
  totalUsd: number;
  notes: string[];
};

/**
 * Per-person USD estimate for one member. Pure: everything it needs is passed
 * in, so the same quotes give the same number in a test and in a dossier.
 *
 * Flights are already USD (we ask SerpApi for USD) and the lodging band is
 * USD by definition, so `fx` is only recorded for the "as of" note; it's here
 * so a future non-USD quote has somewhere to go.
 */
export function estimateCost(
  member: Member,
  destination: Destination,
  window: { depart: string; return: string },
  quotes: CostQuotes,
  opts: { groundUsdPp?: number } = {},
): CostBreakdown {
  const notes: string[] = [];

  const originsPriced = member.pricedAirports.map((origin) => {
    const search = quotes.flightsByOrigin[origin];
    return { origin, priceUsd: search?.cheapest?.priceUsd ?? null };
  });
  for (const o of originsPriced) {
    if (o.priceUsd === null) notes.push(`${o.origin}: no fare returned`);
  }

  const priced = originsPriced.filter(
    (o): o is { origin: string; priceUsd: number } => o.priceUsd !== null,
  );
  priced.sort((a, b) => a.priceUsd - b.priceUsd);
  const cheapest = priced[0];
  const chosenOrigin = cheapest?.origin ?? member.pricedAirports[0] ?? member.airports[0] ?? '???';
  const flightUsd = cheapest ? Math.round(cheapest.priceUsd) : null;

  // The roster rule: when a member has two priced airports, say the delta
  // out loud so the drive-or-not call comes with the number attached.
  if (priced.length >= 2 && cheapest) {
    const list = originsPriced
      .map((o) => `${o.origin} ${o.priceUsd === null ? 'n/a' : `$${Math.round(o.priceUsd)}`}`)
      .join(' / ');
    const runnerUp = priced[1]!;
    const delta = Math.round(runnerUp.priceUsd - cheapest.priceUsd);
    const preferred = member.pricedAirports[0];
    const verdict =
      delta === 0
        ? 'same price, fly from home'
        : chosenOrigin === preferred
          ? `${chosenOrigin} wins by $${delta}`
          : `${chosenOrigin} is $${delta} cheaper than ${preferred}, worth the drive`;
    notes.push(`${member.name}: ${list} — ${verdict}`);
  } else if (!cheapest) {
    notes.push(
      `${member.name}: no flight priced from ${member.pricedAirports.join('/')}; total excludes airfare`,
    );
  }

  const nights = nightsBetween(window.depart, window.return);
  let lodgingUsd: number;
  const pick = quotes.lodging?.pick ?? null;
  if (pick) {
    lodgingUsd = Math.round(pick.perPersonPerNightUsd * nights);
    notes.push(`lodging: ${pick.name} $${Math.round(pick.totalUsd)} total, ${nights} nights`);
  } else {
    const [lo, hi] = destination.lodging_band_usd_pp_night;
    lodgingUsd = Math.round(((lo + hi) / 2) * nights);
    notes.push(
      `lodging: no listing priced, using ${destination.name} band midpoint $${(lo + hi) / 2}/pp/night`,
    );
  }

  const groundUsd = Math.round(opts.groundUsdPp ?? 0);
  if (opts.groundUsdPp === undefined) notes.push('ground: not estimated');

  if (quotes.fx) notes.push(`fx: USD table dated ${quotes.fx.date}`);

  return {
    member: member.name,
    originsPriced,
    chosenOrigin,
    flightUsd,
    lodgingUsd,
    groundUsd,
    totalUsd: (flightUsd ?? 0) + lodgingUsd + groundUsd,
    notes,
  };
}
