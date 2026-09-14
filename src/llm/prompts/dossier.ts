import type { DateWindow, Expedition } from '../../builder.js';
import type { Destination } from '../../config.js';
import { formatSnowLine } from '../../sources/weather/consensus.js';

/**
 * The expedition dossier: PLAN.md §1B, written by Sonnet from the Expedition
 * object and nothing else.
 *
 * Three consumers work from the same object. `renderDossierPrompt` hands Sonnet
 * a trimmed copy (no raw quotes, no per-day per-model tables); `fallbackRender`
 * writes the same sections deterministically when there is no key, the model
 * fails, or it invents a number; `unquotedNumbers` is the check that decides
 * which of the two the group reads.
 */

/** Discord's limit is 2000; the rest is headroom for the job's own footer. */
export const DOSSIER_MAX_CHARS = 1900;

const FLAGS: Record<Destination['region'], string> = {
  JP: '🇯🇵',
  CA: '🇨🇦',
  US: '🇺🇸',
  EU: '🇪🇺',
};

export const DOSSIER_SYSTEM_PROMPT = `You write the weekly expedition dossier for a five-person snowboarding group's Discord. The bot has already built a complete, bookable plan; your job is to present it so the group can say yes in one message.

You are handed a JSON expedition. Write from it and only from it.

Rules, in order of importance:
1. Every dollar figure and every snowfall figure you write must appear verbatim in the JSON (same value; thousands separators are fine). Never round, convert, add up, average, or infer a number. If the JSON has no number for something, say so in words.
2. Commit to the plan. This is not a menu and not a comparison against Aspen.
3. Structure, in this order, each section on its own line starting with the bold label:
   - Header line: "<flag> <DESTINATION NAME IN CAPS> — <window> — $<perPersonUsd>/person — <daysTotal> days (<daysOnSnow> on snow)". Use the "headerLine" field verbatim.
   - One italic line on the snow: the "snow.line" and "snow.explanation" fields, in words.
   - **Getting there** — the recommended routing and why, then the "routing.deltaLines" entries copied verbatim, one per member.
   - **Where you sleep** — nights, the property (or the band if estimated — say it is an estimate), $/pp/night.
   - **Ground** — the ground leg. If ground.status is "unverified", say it is unverified.
   - **Passes** — IKON coverage and blackout dates inside the window. If passes.status is not "verified", write exactly that pass coverage is unverified and must be checked before booking.
   - **Time off** — days door to door, working days burned, and the "minDaysNote" verbatim.
   - **The plan** — the day plan, compactly, one short clause per day.
   - **The catch** — the "volatility.note", and "Decide by <volatility.decideBy>" in bold.
   - Footer: "\`/watch <id>\` to start daily fare tracking." then an "as of" line naming the sources.
4. Plain Discord markdown, no headings, no emoji beyond the flag. At most ${DOSSIER_MAX_CHARS} characters.
5. Sound like a friend who has already done the research, not a travel agent. No hedging boilerplate.`;

/**
 * What the model sees. Raw flight quotes (legs, airlines, durations) and the
 * per-model per-day snow table are dropped: they are where a model goes to
 * find a number to misquote, and nothing in the dossier needs them.
 */
export function trimForPrompt(e: Expedition) {
  const strategy = pick(e);
  return {
    id: e.id,
    headerLine: headerLine(e),
    watchCommand: `/watch ${e.id}`,
    destination: {
      id: e.destination.id,
      name: e.destination.name,
      region: e.destination.region,
      airport: e.destination.airport,
      ground: e.destination.ground,
      min_days: e.destination.min_days,
      ideal_days: e.destination.ideal_days,
    },
    window: e.window,
    windowLabel: fmtWindow(e.window),
    daysTotal: e.daysTotal,
    daysOnSnow: e.daysOnSnow,
    workingDays: e.workingDays,
    minDaysNote: e.minDaysNote,
    snow: {
      line: formatSnowLine(e.weather.report),
      explanation: e.weather.report.explanation,
      confidence: e.weather.report.confidence,
      models: e.weather.report.models.map((m) => ({ model: m.model, totalCm: m.totalCm })),
      tempRange: e.weather.report.tempRange,
      rainRiskAtBase: e.weather.report.rainRiskAtBase,
      maxGustKmh: e.weather.report.maxGustKmh,
      summitNote: e.weather.report.summitNote,
    },
    routing: {
      recommended: e.routing.recommended,
      reason: e.routing.reason,
      deltaLines: e.routing.deltaLines,
      arrivalSpreadHours: strategy.arrivalSpreadHours,
      feasible: strategy.feasible,
      perMember: strategy.perMember.map((r) => ({
        member: r.member,
        origin: r.origin,
        priceUsd: r.priceUsd,
        positioningUsd: r.positioningUsd,
        allInUsd: r.allInUsd,
        arriveAt: r.arriveAt,
        note: r.note,
      })),
    },
    lodging: e.lodging,
    ground: e.ground,
    passes: e.passes,
    dayPlan: e.weather.dayPlan,
    cost: {
      perPersonUsd: e.cost.perPersonUsd,
      groupUsd: e.cost.groupUsd,
      ceilingUsd: e.cost.ceilingUsd,
      overCeiling: e.cost.overCeiling,
      perMember: e.cost.perMember.map((c) => ({
        member: c.member,
        chosenOrigin: c.chosenOrigin,
        flightUsd: c.flightUsd,
        lodgingUsd: c.lodgingUsd,
        groundUsd: c.groundUsd,
        totalUsd: c.totalUsd,
      })),
    },
    volatility: e.volatility,
    sources: e.sources,
    asOf: e.asOf,
  };
}

export function renderDossierPrompt(e: Expedition): string {
  return `Write the dossier for this expedition.\n\nExpedition JSON:\n${JSON.stringify(trimForPrompt(e), null, 2)}`;
}

/* --------------------------------------------------------------- fallback */

/**
 * The dossier without a model. Every dry run prints this when there is no
 * ANTHROPIC_API_KEY and every live run falls back to it, so it has to read as
 * a finished post. Same sections, same order as the prompt asks for.
 */
export function fallbackRender(e: Expedition): string {
  const full = sections(e, false).join('\n');
  if (full.length <= DOSSIER_MAX_CHARS) return full;
  // The day plan is the only section that can be said shorter without losing a number.
  const short = sections(e, true).join('\n');
  return clamp(short, DOSSIER_MAX_CHARS);
}

function sections(e: Expedition, compactPlan: boolean): string[] {
  const r = e.weather.report;
  const out: string[] = [];

  out.push(`**${headerLine(e)}**`);
  // The explanation already quotes every model total, so the snow line is not repeated.
  out.push(`*${fmtWindow(r.window)}: ${r.explanation}*`);

  out.push(`**Getting there** — ${routingLine(e)}`);
  for (const line of e.routing.deltaLines) out.push(`• ${line}`);

  out.push(`**Where you sleep** — ${lodgingLine(e)}`);
  out.push(`**Ground** — ${groundLine(e)}`);
  out.push(`**Passes** — ${passesLine(e)}`);
  out.push(
    `**Time off** — ${e.daysTotal} days door to door, ${e.workingDays} working days. ${e.minDaysNote}`,
  );
  out.push(`**The plan** — ${compactPlan ? compactDayPlan(e) : dayPlanLines(e)}`);
  out.push(
    `**The catch** — ${e.volatility.note.replace(/\s*Decide by [\d-]+\.?$/, '')} **Decide by ${e.volatility.decideBy}.**`,
  );
  out.push('');
  out.push(`\`/watch ${e.id}\` to start daily fare tracking.`);
  out.push(
    `_As of ${e.asOf.slice(0, 16).replace('T', ' ')} UTC · sources: ${sourceNames(e).join(', ')}_`,
  );
  return out;
}

export function headerLine(e: Expedition): string {
  return (
    `${FLAGS[e.destination.region]} ${e.destination.name.toUpperCase()} — ${fmtWindow(e.window)} — ` +
    `${usd(e.cost.perPersonUsd)}/person — ${e.daysTotal} days (${e.daysOnSnow} on snow)`
  );
}

function routingLine(e: Expedition): string {
  const strategy = pick(e);
  const who = strategy.perMember
    .filter((m) => !m.unpriced && m.allInUsd !== null)
    .map((m) => `${m.member} ${m.origin} ${usd(m.allInUsd ?? 0)}`)
    .join(', ');
  const unpriced = strategy.unpriced.length
    ? ` No fare yet for ${strategy.unpriced.join(', ')}.`
    : '';
  const spread =
    strategy.arrivalSpreadHours === null
      ? ''
      : ` Everyone lands at ${e.destination.airport} within ${strategy.arrivalSpreadHours}h.`;
  return `${e.routing.reason} ${who ? `All-in: ${who}.` : ''}${unpriced}${spread}`.trim();
}

function lodgingLine(e: Expedition): string {
  const l = e.lodging;
  const each = `${usd(l.perPersonPerNightUsd)}/pp/night, ${usd(l.perPersonUsd)}/pp for the stay`;
  if (l.estimated) return `${l.nights} nights, estimate only: ${l.note} (${each}).`;
  // The builder's note already names the property, its total, sleeps and rating.
  return `${l.nights} nights, ${l.note} — ${each}.`;
}

function groundLine(e: Expedition): string {
  const g = e.ground;
  if (g.status === 'unverified') return `${g.description} — unverified, no price yet.`;
  const opts = g.options
    .map((o) => {
      const price = o.priceUsdPp === null ? 'price unknown' : `${usd(o.priceUsdPp)} pp each way`;
      const who = o.operator ? ` (${o.operator})` : '';
      const dur = o.durationMin === null ? '' : `, ~${Math.round(o.durationMin / 6) / 10}h`;
      return `${o.mode.replace('_', ' ')}${who} ${price}${dur}${o.notes ? `, ${o.notes}` : ''}`;
    })
    .join('; ');
  const total = g.perPersonUsd === null ? '' : ` Budgeted ${usd(g.perPersonUsd)}/pp round trip.`;
  return `${opts}.${total}`;
}

function passesLine(e: Expedition): string {
  const p = e.passes;
  if (p.status !== 'verified') return 'IKON coverage is unverified — check before booking.';
  const cover =
    p.covered === null
      ? 'IKON coverage could not be confirmed'
      : p.covered
        ? `IKON covers ${p.daysIncluded === null ? 'this resort' : `${p.daysIncluded} days`}`
        : 'not on IKON';
  const blackout = p.blackoutsInWindow.length
    ? ` Blackout inside the window: ${p.blackoutsInWindow.join(', ')}.`
    : ' No blackout dates inside the window.';
  return `${cover}.${blackout}${p.notes ? ` ${p.notes}.` : ''}`;
}

function dayPlanLines(e: Expedition): string {
  return (
    '\n' +
    e.weather.dayPlan
      .map(
        (d) =>
          `• ${dayLabel(d.date)} — ${d.plannedAt === 'on-snow' ? 'ride' : d.plannedAt}: ${d.reason}`,
      )
      .join('\n')
  );
}

function compactDayPlan(e: Expedition): string {
  const ride = e.weather.dayPlan.filter((d) => d.plannedAt === 'on-snow');
  const big = ride.find((d) => /biggest/.test(d.reason));
  const rest = e.weather.dayPlan.find((d) => d.plannedAt === 'rest');
  const bits = [`${ride.length} days riding`];
  if (big) bits.push(`biggest day ${dayLabel(big.date)} (${big.reason})`);
  if (rest) bits.push(`rest ${dayLabel(rest.date)}`);
  return bits.join(', ') + '.';
}

function sourceNames(e: Expedition): string[] {
  // URLs from the lookups are in the object for the record; the footer names feeds.
  return e.sources.filter((s) => !/^https?:/.test(s));
}

/* ------------------------------------------------------------- the audit */

/**
 * The rule the prompt asks for, checked rather than trusted: every `$N` and
 * `Ncm` in the text must be a number that exists somewhere in the Expedition.
 * The whole object is walked — numeric leaves, and dollar and centimetre
 * tokens inside string leaves such as the delta lines — so a figure the
 * builder wrote into a note counts as quoted. Returns the offenders.
 */
export function unquotedNumbers(text: string, e: Expedition): string[] {
  const allowed = new Set<string>();
  const add = (n: number) => {
    if (!Number.isFinite(n)) return;
    allowed.add(String(n));
    allowed.add(String(Math.round(n)));
  };
  walk(e, (leaf) => {
    if (typeof leaf === 'number') add(leaf);
    else if (typeof leaf === 'string') {
      for (const m of leaf.matchAll(MONEY)) add(Number(m[1]!.replace(/,/g, '')));
      for (const m of leaf.matchAll(CM)) add(Number(m[1]));
    }
  });

  const bad: string[] = [];
  for (const m of text.matchAll(MONEY)) {
    const n = m[1]!.replace(/,/g, '');
    if (!allowed.has(n)) bad.push(`$${m[1]}`);
  }
  for (const m of text.matchAll(CM)) {
    if (!allowed.has(m[1]!)) bad.push(`${m[1]}cm`);
  }
  return bad;
}

const MONEY = /\$(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)/g;
const CM = /(\d+(?:\.\d+)?)\s*cm\b/gi;

function walk(v: unknown, visit: (leaf: unknown) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) walk(x, visit);
  } else {
    visit(v);
  }
}

/* ---------------------------------------------------------------- helpers */

function pick(e: Expedition) {
  return e.routing.recommended === 'independent'
    ? e.routing.independent
    : e.routing.consolidateWest;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Feb 6–15" or "Jan 30–Feb 2". Parsed by hand so no timezone can shift a day. */
export function fmtWindow(w: DateWindow): string {
  const [, sm, sd] = w.start.split('-').map(Number);
  const [, em, ed] = w.end.split('-').map(Number);
  const start = `${MONTHS[(sm ?? 1) - 1]} ${sd}`;
  if (w.start === w.end) return start;
  return sm === em ? `${start}–${ed}` : `${start}–${MONTHS[(em ?? 1) - 1]} ${ed}`;
}

function dayLabel(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  const d = new Date(t);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}`;
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
