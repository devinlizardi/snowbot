import { z } from 'zod';
import type { DateWindow, Expedition, ExpeditionLodgingOption } from '../../builder.js';
import type { Destination } from '../../config.js';
import { formatSnowLine } from '../../sources/weather/consensus.js';

/**
 * The expedition dossier: PLAN.md §1B, reworked Sept 2026 to sell the trip.
 *
 * It is two things now, both built from the Expedition object and nothing else:
 *
 *   - a **root post** in the channel: the pitch. Header, the hook, why go, the
 *     snow story, what it costs all-in, the catch, a call to commit.
 *   - a **thread** under it: the dossier proper, one message per section —
 *     flights (a table), where you sleep (a table + links), the day-by-day
 *     plan with ground, passes and time off.
 *
 * Sonnet writes the *words* as a JSON object of fields (`DossierCopy`); the
 * code draws every table, price and link itself, so the numbers people book
 * from are never paraphrased. Each field the model writes is audited on its
 * own (`unquotedNumbers`) and a field that invents a number, or runs long, is
 * swapped for the deterministic version (`fallbackCopy`) — one bad sentence
 * no longer costs the whole post its voice.
 */

/** Discord's limit is 2000 per message; the rest is headroom. */
export const DOSSIER_MAX_CHARS = 1900;

const FLAGS: Record<Destination['region'], string> = {
  JP: '🇯🇵',
  CA: '🇨🇦',
  US: '🇺🇸',
  EU: '🇪🇺',
};

/** Per-field ceilings. The root post has to hold hook + pitch + snow + catch + signoff. */
export const COPY_LIMITS = {
  hook: 140,
  pitch: 480,
  snow: 400,
  flightsNote: 420,
  lodgingNote: 320,
  planLine: 110,
  catch: 240,
  signoff: 110,
} as const;

export const DossierCopySchema = z.object({
  hook: z.string(),
  pitch: z.string(),
  snow: z.string(),
  flightsNote: z.string(),
  lodgingNote: z.string(),
  plan: z.array(z.object({ date: z.string(), line: z.string() })),
  catch: z.string(),
  signoff: z.string(),
});
export type DossierCopy = z.infer<typeof DossierCopySchema>;

export type RenderedDossier = {
  /** The pitch, posted to the channel. */
  root: string;
  /** The dossier, one thread message per section, in order. */
  details: string[];
};

export const DOSSIER_SYSTEM_PROMPT = `You write the weekly expedition dossier for a snowboarding crew's Discord: five friends split between New York and California who ride together every winter. The bot has already built a complete, bookable trip. Your job is to make them want it.

This post should be the thing they look forward to landing every Monday, and it should make a real case for going. Write like the friend in the group chat who did all the research, is genuinely excited, and is trying to get everyone to commit: specific, vivid, a little funny, never a travel agent.

You are handed a JSON expedition. Everything factual you write comes from it.

HOW TO SELL IT
- Lead with the single most compelling true thing about this trip: the snow history, the terrain, the price, the timing. Make them picture it: first chair on a storm morning, the onsen after, dinner in town.
- destination.pitch (hook, terrain, off_snow, heads_up) is hand-written by the group for exactly this. Lean on it and rephrase it; don't add resort facts of your own beyond it.
- Lodging highlights (hot tub, onsen, ski-in/ski-out, kitchen…) are selling points. Use them.
- Be specific. "New snow on 6 of these 10 days in a typical year" beats "great snow". Talk to people by name when it helps ("M3, drive to LAX for this one").
- No clichés: nothing "nestled", no "winter wonderland", "unforgettable", "epic adventure", "look no further", "hidden gem". One exclamation point at most.
- Honesty is what makes the pitch land. A friend who oversells gets ignored. Put the real downside in "catch", plainly.

THE SNOW (it matters most to them)
- snow.mode "history": the trip is beyond any forecast. Never describe its weather as forecast, expected or predicted. Tell them what this window usually delivers, from snow.history (typical snow days out of the window, how many seasons delivered, how this stretch compares to the rest of the season, the peak month) and snow.resort (the resort's own average snowfall). Say when the real forecast starts to see the trip (snow.forecastVisibleFrom). If snow.history.seasonToDate is present, say how this season is running.
- snow.history is counts and ratios on purpose: the reanalysis grid undercounts mountain snow. Never turn it into centimetres. Snow amounts come only from snow.resort (resort-reported averages; say they are the resort's figures) or, in "forecast" mode, snow.forecast.
- snow.mode "forecast": lead with snow.forecast (line, explanation, confidence) and use history as context.
- If a snow field is null, don't invent it. Say so in words or leave it out.

NUMBERS (checked by machine)
Every dollar figure, snow amount (cm or m), percentage and "N of M" count you write must appear in the JSON (thousands separators are fine; rounding a decimal to the nearest whole number is fine). Never add, subtract, convert, average or estimate. Write snow in cm or m, never inches. A field with a number that isn't in the JSON is thrown away and replaced with a flat automatic version, so one invented number costs you the whole field.

WHAT TO RETURN
Only a JSON object, no code fences, with exactly these fields. The bot draws the flight table, the lodging table, the links, the header and the price line itself; your job is the words around them. Discord markdown inside strings (**bold**, *italic*) is fine; no headings, links, tables or emoji beyond one or two that earn their place.
- hook (≤${COPY_LIMITS.hook} chars): one line, the reason to go, in your own voice. Not the name and dates; the header has those. The bot prints a real, attributed quote (the "quote" field) just above your hook, so never write your own quotation or attribute words to anyone, and don't repeat the quote.
- pitch (≤${COPY_LIMITS.pitch} chars): 2–4 sentences making the case: why this place, why these dates, what the trip feels like.
- snow (≤${COPY_LIMITS.snow} chars): the snow story, per THE SNOW.
- flightsNote (≤${COPY_LIMITS.flightsNote} chars): why the routing works: who flies from where, anyone who should drive to a hub and why, how close together everyone lands. It sits under the flight table; don't repeat the table row by row. The per-member delta lines are printed separately.
- lodgingNote (≤${COPY_LIMITS.lodgingNote} chars): why option 1 is the one, and what 2 and 3 trade (cheaper, nicer). It sits under the lodging table and links. If lodging.estimated is true there is no listing, so say the price is an estimate.
- plan: one entry per day in dayPlan, same dates, same order: {"date": "YYYY-MM-DD", "line": "≤${COPY_LIMITS.planLine} chars"}. Keep each day's type (travel, rest, on-snow) but give it life: arrival-night ramen, the rest-day onsen, the last-night dinner. Use pitch.off_snow and lodging highlights; don't invent named restaurants or events.
- catch (≤${COPY_LIMITS.catch} chars): the honest downside and why deciding soon matters, from volatility.note and pitch.heads_up. The bot appends the decide-by date.
- signoff (≤${COPY_LIMITS.signoff} chars): a one-line closer that asks them to commit.`;

/* ------------------------------------------------------------ the prompt */

/**
 * What the model sees. Raw flight quotes (legs, durations) and the per-model
 * per-day snow table are dropped: they are where a model goes to find a
 * number to misquote, and the tables that need them are drawn by code.
 */
export function trimForPrompt(e: Expedition) {
  const strategy = pick(e);
  const r = e.weather.report;
  const forecastMode = e.climate.mode === 'forecast';
  return {
    id: e.id,
    headerLine: headerLine(e),
    quote: e.quote ? { text: e.quote.text, by: e.quote.by } : null,
    watchCommand: `/watch ${e.id}`,
    destination: {
      id: e.destination.id,
      name: e.destination.name,
      region: e.destination.region,
      airport: e.destination.airport,
      ground: e.destination.ground,
      min_days: e.destination.min_days,
      ideal_days: e.destination.ideal_days,
      pitch: e.destination.pitch,
    },
    window: e.window,
    windowLabel: fmtWindow(e.window),
    daysTotal: e.daysTotal,
    daysOnSnow: e.daysOnSnow,
    workingDays: e.workingDays,
    minDaysNote: e.minDaysNote,
    snow: {
      mode: e.climate.mode,
      forecastVisibleFrom: e.climate.forecastVisibleFrom,
      forecast: forecastMode
        ? {
            line: formatSnowLine(r),
            explanation: r.explanation,
            confidence: r.confidence,
            models: r.models.map((m) => ({ model: m.model, totalCm: m.totalCm })),
            tempRange: r.tempRange,
            rainRiskAtBase: r.rainRiskAtBase,
            maxGustKmh: r.maxGustKmh,
            summitNote: r.summitNote,
          }
        : null,
      history: e.climate.history
        ? {
            seasons: e.climate.history.seasons,
            firstSeason: e.climate.history.firstSeason,
            lastSeason: e.climate.history.lastSeason,
            windowDays: e.climate.history.windowDays,
            typicalSnowDays: e.climate.history.typicalSnowDays,
            seasonsWithSnow: e.climate.history.seasonsWithSnow,
            seasonsHalfSnowy: e.climate.history.seasonsHalfSnowy,
            vsSeasonPct: e.climate.history.vsSeasonPct,
            peakMonth: e.climate.history.peakMonth,
            windowMonth: e.climate.history.windowMonth,
            windowMonthRank: e.climate.history.windowMonthRank,
            seasonMonths: e.climate.history.seasonMonths,
            bestSeason: e.climate.history.bestSeason,
            quietestSeason: e.climate.history.quietestSeason,
            seasonToDate: e.climate.history.seasonToDate,
            caveat: e.climate.history.caveat,
          }
        : null,
      resort: e.climate.resort
        ? {
            annualCm: e.climate.resort.annualCm,
            annualM: e.climate.resort.annualM,
            measuredWhere: e.climate.resort.measuredWhere,
            windowMonth: e.climate.resort.windowMonth,
            windowMonthCm: e.climate.resort.windowMonthCm,
            snowiestMonth: e.climate.resort.snowiestMonth,
            notes: e.climate.resort.notes,
          }
        : null,
    },
    routing: {
      recommended: e.routing.recommended,
      reason: e.routing.reason,
      deltaLines: e.routing.deltaLines,
      arrivalSpreadHours: strategy.arrivalSpreadHours,
      feasible: strategy.feasible,
      perMember: strategy.perMember.map((m) => ({
        member: m.member,
        origin: m.origin,
        priceUsd: m.priceUsd,
        positioningUsd: m.positioningUsd,
        allInUsd: m.allInUsd,
        arriveAt: m.arriveAt,
        airlines: m.quote?.airlines ?? [],
        stops: m.quote?.stops ?? null,
        note: m.note,
      })),
    },
    lodging: {
      nights: e.lodging.nights,
      estimated: e.lodging.estimated,
      note: e.lodging.note,
      options: e.lodging.options.map((o) => ({
        n: o.n,
        role: o.role,
        name: o.name,
        type: o.type,
        units: o.units,
        sleeps: o.sleeps,
        bedrooms: o.bedrooms,
        perPersonPerNightUsd: o.perPersonPerNightUsd,
        perPersonUsd: o.perPersonUsd,
        rating: o.rating,
        reviews: o.reviews,
        highlights: o.highlights,
      })),
      perPersonPerNightUsd: e.lodging.perPersonPerNightUsd,
      perPersonUsd: e.lodging.perPersonUsd,
    },
    ground: e.ground,
    passes: e.passes,
    dayPlan: e.weather.dayPlan.map((d) => ({
      date: d.date,
      day: dayLabel(d.date),
      plannedAt: d.plannedAt,
      reason: /beyond the forecast horizon/.test(d.reason) ? null : d.reason,
    })),
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
  };
}

export function renderDossierPrompt(e: Expedition): string {
  return `Write the dossier copy for this expedition.\n\nExpedition JSON:\n${JSON.stringify(trimForPrompt(e), null, 2)}`;
}

/* ------------------------------------------------------- model → copy */

export type CopyResult = {
  copy: DossierCopy;
  /** Fields that came from `fallbackCopy` instead of the model, with why. */
  replaced: { field: string; why: string }[];
};

/**
 * Parse the model's reply and merge it with the fallback field by field. A
 * reply that isn't the JSON object at all falls back entirely; otherwise only
 * the fields that invented a number or can't be cut to length are replaced.
 */
export function composeCopy(reply: string | null, e: Expedition): CopyResult {
  const base = fallbackCopy(e);
  if (reply === null) return { copy: base, replaced: [{ field: '*', why: 'no model reply' }] };
  const parsed = parseCopy(reply);
  if (!parsed.ok) return { copy: base, replaced: [{ field: '*', why: parsed.error }] };
  const m = parsed.value;
  const replaced: CopyResult['replaced'] = [];

  const field = (name: keyof typeof COPY_LIMITS & keyof DossierCopy, limit: number): string => {
    const v = (m[name] as string).trim();
    if (!v) {
      replaced.push({ field: name, why: 'empty' });
      return base[name] as string;
    }
    const bad = unquotedNumbers(v, e);
    if (bad.length) {
      replaced.push({ field: name, why: `unquoted numbers: ${bad.join(', ')}` });
      return base[name] as string;
    }
    const fit = fitSentences(v, limit);
    if (fit === null) {
      replaced.push({ field: name, why: `over ${limit} chars` });
      return base[name] as string;
    }
    return fit;
  };

  const byDate = new Map(m.plan.map((p) => [p.date, p.line.trim()]));
  const plan = base.plan.map((fb) => {
    const line = byDate.get(fb.date);
    if (!line) {
      replaced.push({ field: `plan ${fb.date}`, why: 'missing' });
      return fb;
    }
    const bad = unquotedNumbers(line, e);
    if (bad.length) {
      replaced.push({ field: `plan ${fb.date}`, why: `unquoted numbers: ${bad.join(', ')}` });
      return fb;
    }
    return { date: fb.date, line: clamp(line, COPY_LIMITS.planLine) };
  });

  return {
    copy: {
      hook: field('hook', COPY_LIMITS.hook),
      pitch: field('pitch', COPY_LIMITS.pitch),
      snow: field('snow', COPY_LIMITS.snow),
      flightsNote: field('flightsNote', COPY_LIMITS.flightsNote),
      lodgingNote: field('lodgingNote', COPY_LIMITS.lodgingNote),
      plan,
      catch: field('catch', COPY_LIMITS.catch),
      signoff: field('signoff', COPY_LIMITS.signoff),
    },
    replaced,
  };
}

function parseCopy(text: string): { ok: true; value: DossierCopy } | { ok: false; error: string } {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in reply' };
  let obj: unknown;
  try {
    obj = JSON.parse(unfenced.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const res = DossierCopySchema.safeParse(obj);
  if (!res.success) {
    return {
      ok: false,
      error: `schema: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, value: res.data };
}

/** Cut at the last sentence end inside the limit; null if even the first sentence doesn't fit. */
function fitSentences(s: string, limit: number): string | null {
  if (s.length <= limit) return s;
  const head = s.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (cut < limit * 0.5) return null;
  return head.slice(0, cut + 1);
}

/* -------------------------------------------------------------- render */

/** The whole dossier from copy: the root pitch and the thread's sections. */
export function renderDossier(e: Expedition, copy: DossierCopy): RenderedDossier {
  return {
    root: fitMessage(rootParts(e, copy), ['signoff', 'pitch', 'snow']),
    details: [
      fitMessage(flightsParts(e, copy), ['note']),
      fitMessage(lodgingParts(e, copy), ['note']),
      fitMessage(planParts(e, copy), ['plan']),
    ],
  };
}

/** The dossier without a model: every dry run without a key, and every total failure. */
export function fallbackRender(e: Expedition): RenderedDossier {
  return renderDossier(e, fallbackCopy(e));
}

type Part = { key: string; text: string };

function rootParts(e: Expedition, c: DossierCopy): Part[] {
  const catchLine = c.catch.replace(/\s*Decide by [\d-]+\.?$/, '');
  return [
    { key: 'header', text: `**${headerLine(e)}**` },
    ...(e.quote ? [{ key: 'quote', text: quoteBlock(e.quote) }] : []),
    { key: 'hook', text: `*${c.hook}*` },
    { key: 'pitch', text: `\n${c.pitch}` },
    { key: 'snow', text: `\n❄️ **The snow** — ${c.snow}` },
    { key: 'damage', text: `💸 **All-in** — ${damageLine(e)}` },
    { key: 'catch', text: `⏳ **The catch** — ${catchLine} **Decide by ${e.volatility.decideBy}.**` },
    { key: 'signoff', text: `\n${c.signoff}` },
    {
      key: 'footer',
      text: `-# \`/watch ${e.id}\` starts daily fare tracking · flights, where you sleep and the day-by-day are in the thread 🧵`,
    },
  ];
}

function flightsParts(e: Expedition, c: DossierCopy): Part[] {
  const s = pick(e);
  const spread =
    s.arrivalSpreadHours === null
      ? ''
      : ` · everyone lands at ${e.destination.airport} within ${s.arrivalSpreadHours}h`;
  const parts: Part[] = [
    { key: 'title', text: `✈️ **Getting there**${spread}` },
    { key: 'table', text: flightTable(e) },
  ];
  const positioned = s.perMember.filter((m) => !m.unpriced && m.positioningUsd > 0);
  if (positioned.length) {
    parts.push({
      key: 'foot',
      text: `-# * fare + ~$${positioned[0]!.positioningUsd} to get to the hub (an estimate, not a quote)`,
    });
  }
  parts.push({ key: 'note', text: c.flightsNote });
  if (e.routing.deltaLines.length) {
    parts.push({ key: 'deltas', text: e.routing.deltaLines.map((l) => `• ${l}`).join('\n') });
  }
  parts.push({
    key: 'volatility',
    text: `📉 ${e.volatility.note.replace(/\s*Decide by [\d-]+\.?$/, '')}`,
  });
  return parts;
}

function lodgingParts(e: Expedition, c: DossierCopy): Part[] {
  const l = e.lodging;
  const parts: Part[] = [{ key: 'title', text: `🏠 **Where you sleep** · ${l.nights} nights` }];
  if (l.estimated || l.options.length === 0) {
    parts.push({
      key: 'table',
      text: `No listing priced yet — budgeting ${usd(l.perPersonPerNightUsd)}/pp/night (${usd(l.perPersonUsd)}/pp for the stay), an estimate from the board's band.`,
    });
  } else {
    parts.push({ key: 'table', text: lodgingTable(l.options) });
    parts.push({ key: 'links', text: l.options.map(lodgingLink).join('\n') });
  }
  parts.push({ key: 'note', text: c.lodgingNote });
  return parts;
}

function planParts(e: Expedition, c: DossierCopy): Part[] {
  const lines = c.plan.map((p) => `• **${dayLabel(p.date)}** — ${p.line}`).join('\n');
  return [
    {
      key: 'title',
      text: `🗓️ **The plan** · ${e.daysTotal} days door to door, ${e.daysOnSnow} on snow`,
    },
    { key: 'plan', text: lines },
    { key: 'ground', text: `\n🚌 **Ground** — ${groundLine(e)}` },
    { key: 'passes', text: `🎟️ **Passes** — ${passesLine(e)}` },
    { key: 'time', text: `⏱️ **Time off** — ${e.workingDays} working days. ${e.minDaysNote}` },
    {
      key: 'asof',
      text: `-# as of ${e.asOf.slice(0, 16).replace('T', ' ')} UTC · sources: ${sourceNames(e).join(', ')}`,
    },
  ];
}

/**
 * Join the parts; while over the limit, shorten the named parts in order —
 * dropping a part entirely only if it is the signoff, clamping the rest.
 */
function fitMessage(parts: Part[], shrink: string[]): string {
  const join = () => parts.map((p) => p.text).join('\n');
  let text = join();
  for (const key of shrink) {
    if (text.length <= DOSSIER_MAX_CHARS) break;
    const p = parts.find((x) => x.key === key);
    if (!p) continue;
    const over = text.length - DOSSIER_MAX_CHARS;
    if (key === 'signoff') p.text = '';
    else p.text = clamp(p.text, Math.max(40, p.text.length - over - 1));
    text = join();
  }
  return clamp(text, DOSSIER_MAX_CHARS);
}

/** A real quote as a Discord block quote, with its attribution on the second line. */
export function quoteBlock(q: NonNullable<Expedition['quote']>): string {
  const where = [q.source, q.translation === 'ours' ? 'our translation' : ''].filter(Boolean).join('; ');
  return `> *“${q.text}”*\n> — ${q.by}${where ? `, ${where}` : ''}`;
}

/* -------------------------------------------------------------- tables */

/** Monospace, ≤42 columns so it reads on a phone without wrapping. */
export function flightTable(e: Expedition): string {
  const rows = pick(e).perMember.map((m) => {
    // Right-align the number and hang the hub marker after it, so digits line up.
    const fare =
      m.unpriced || m.allInUsd === null
        ? '—'.padStart(5) + ' '
        : usd(m.allInUsd).padStart(5) + (m.positioningUsd > 0 ? '*' : ' ');
    const airline = m.quote?.airlines.length ? m.quote.airlines.join('/') : '—';
    const stops = m.quote ? String(m.quote.stops) : '—';
    return [m.member, m.origin, fare, airline, stops, landsLabel(m.arriveAt)];
  });
  return codeBlock(
    ['WHO', 'FROM', ' FARE', 'AIRLINE', 'ST', 'LANDS'],
    rows,
    [6, 4, 6, 8, 2, 9],
    ['l', 'l', 'l', 'l', 'r', 'l'],
  );
}

export function lodgingTable(options: ExpeditionLodgingOption[]): string {
  const rows = options.map((o) => [
    String(o.n),
    o.name,
    typeLabel(o),
    usd(o.perPersonPerNightUsd),
    usd(o.perPersonUsd),
    o.rating === null ? '—' : o.rating.toFixed(1),
  ]);
  return codeBlock(
    ['#', 'PLACE', 'TYPE', 'PP/NT', 'PP/TRIP', '★'],
    rows,
    [1, 15, 7, 5, 7, 3],
    ['l', 'l', 'l', 'r', 'r', 'r'],
  );
}

const ROLE_LABEL: Record<ExpeditionLodgingOption['role'], string> = {
  pick: 'the pick',
  cheapest: 'cheapest',
  nicest: 'the splurge',
  alternative: 'also good',
};

function lodgingLink(o: ExpeditionLodgingOption): string {
  const extra = o.highlights.length ? ` · ${o.highlights.slice(0, 3).join(', ')}` : '';
  // Angle brackets stop Discord unfurling three big previews under the post.
  return `**${o.n}** ${ROLE_LABEL[o.role]} → [${escapeLinkText(o.name)}](<${o.url}>)${extra}`;
}

function typeLabel(o: ExpeditionLodgingOption): string {
  if (o.type === 'hotel') return o.units > 1 ? `${o.units} rooms` : 'hotel';
  if (o.type === 'vacation_rental') return o.bedrooms ? `${o.bedrooms}BR` : 'rental';
  return 'other';
}

function codeBlock(
  head: string[],
  rows: string[][],
  widths: number[],
  align: ('l' | 'r')[],
): string {
  const cell = (s: string, i: number) => {
    const w = widths[i]!;
    const t = s.length > w ? s.slice(0, w - 1) + '…' : s;
    return align[i] === 'r' ? t.padStart(w) : t.padEnd(w);
  };
  const line = (cols: string[]) =>
    cols
      .map(cell)
      .join(' ')
      .trimEnd();
  return ['```', line(head), ...rows.map(line), '```'].join('\n');
}

function landsLabel(arriveAt: string | null): string {
  if (!arriveAt) return '—';
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(arriveAt);
  if (!m) return arriveAt.slice(0, 9);
  return `${DOW[new Date(`${m[1]}T00:00:00Z`).getUTCDay()]} ${m[2]}`;
}

/* --------------------------------------------------------- fallback copy */

/**
 * Every field written without a model. Flatter than Sonnet, but it must still
 * read as a finished post and make the case: it leans on the board's
 * hand-written pitch and the snow history.
 */
export function fallbackCopy(e: Expedition): DossierCopy {
  const p = e.destination.pitch;
  const hook = p.hook || `${e.destination.name}, ${fmtWindow(e.window)} — the whole trip, already built.`;

  const pitchBits: string[] = [];
  if (p.terrain[0]) pitchBits.push(`${p.terrain[0]}.`);
  if (p.off_snow[0]) pitchBits.push(`${p.off_snow[0]}.`);
  pitchBits.push(
    `${e.daysOnSnow} days on snow for ${usd(e.cost.perPersonUsd)} a head, door to door.`,
  );

  const flightsNote = e.routing.reason;
  const l = e.lodging;
  const lodgingNote = l.estimated
    ? 'No listing came back for these dates, so the stay is an estimate from the board band — the first thing to price for real.'
    : lodgingFallbackNote(l.options);

  const vol = e.volatility.note.replace(/\s*Decide by [\d-]+\.?$/, '');
  const catchText = [vol, p.heads_up[0] ? `${p.heads_up[0]}.` : ''].filter(Boolean).join(' ');

  return {
    hook: clamp(hook, COPY_LIMITS.hook),
    pitch: clamp(pitchBits.join(' '), COPY_LIMITS.pitch),
    snow: clamp(snowStory(e), COPY_LIMITS.snow),
    flightsNote: clamp(flightsNote, COPY_LIMITS.flightsNote),
    lodgingNote: clamp(lodgingNote, COPY_LIMITS.lodgingNote),
    plan: fallbackPlan(e),
    catch: clamp(catchText, COPY_LIMITS.catch),
    signoff: "Who's in? Say it here, and whoever's first, start the fare watch.",
  };
}

function lodgingFallbackNote(options: Expedition['lodging']['options']): string {
  const [first, ...rest] = options;
  if (!first) return '';
  const traits = [
    first.sleeps !== null ? `sleeps ${first.sleeps}` : first.units > 1 ? `${first.units} rooms` : null,
    ...first.highlights.slice(0, 2),
    first.rating !== null ? `rated ${first.rating}` : null,
  ].filter(Boolean);
  const say = { pick: 'the pick', cheapest: 'the cheapest', nicest: 'the splurge', alternative: 'also good' };
  const others = rest.map((o) => `${o.n} is ${say[o.role]}`);
  return (
    `Option 1 is the pick${traits.length ? `: ${traits.join(', ')}` : ''}.` +
    (others.length ? ` ${others.join('; ')}.` : '')
  );
}

/** The snow story in words, from whichever of forecast / history / resort exist. */
export function snowStory(e: Expedition): string {
  const c = e.climate;
  const h = c.history;
  const r = c.resort;
  const bits: string[] = [];

  if (c.mode === 'forecast') {
    bits.push(e.weather.report.explanation);
  } else {
    bits.push(`Too far out for a forecast; the first real one sees this trip around ${fmtDay(c.forecastVisibleFrom)}.`);
  }
  if (h) {
    const every = h.seasonsHalfSnowy === h.seasons;
    bits.push(
      `History: new snow on ~${h.typicalSnowDays} of these ${h.windowDays} days in a typical season; ` +
        (every
          ? `at least half the days snowed in every one of the last ${h.seasons} seasons.`
          : `at least half the days snowed in ${h.seasonsHalfSnowy} of the last ${h.seasons} seasons.`),
    );
    if (h.vsSeasonPct !== null && Math.abs(h.vsSeasonPct) >= 10) {
      bits.push(
        h.vsSeasonPct > 0
          ? `This stretch runs ${h.vsSeasonPct}% snowier than an average stretch of the season.`
          : `This stretch runs ${Math.abs(h.vsSeasonPct)}% lighter than the season average.`,
      );
    }
    if (h.seasonToDate) bits.push(`This season is at ${h.seasonToDate.pctOfNormal}% of normal so far.`);
  }
  if (r) {
    if (r.windowMonthCm !== null) {
      bits.push(`The resort reports ~${fmtCm(r.windowMonthCm)} in a typical ${r.windowMonth}.`);
    } else if (r.annualCm !== null) {
      bits.push(`The resort reports ~${fmtCm(r.annualCm)} a season.`);
    }
  }
  if (!h && !r && c.mode === 'history') bits.push('No snow history could be fetched for this window.');
  return bits.join(' ');
}

/** Day-by-day with a little life: travel, the rest day's off-snow pick, terrain on ride days. */
function fallbackPlan(e: Expedition): DossierCopy['plan'] {
  const p = e.destination.pitch;
  const ground = e.destination.ground;
  const overnight = e.weather.dayPlan.some(
    (d) => d.plannedAt === 'travel' && d.date !== e.window.start && d.date !== e.window.end,
  );
  let ride = 0;
  return e.weather.dayPlan.map((d) => {
    let line: string;
    if (d.plannedAt === 'travel') {
      line =
        d.date === e.window.start
          ? overnight
            ? 'fly out'
            : `fly in · ${ground} · first dinner in town`
          : d.date === e.window.end
            ? 'last breakfast, fly home'
            : `land · ${ground} · food and bed`;
    } else if (d.plannedAt === 'rest') {
      const pickOff = p.off_snow[0]?.split(' — ')[0];
      line = `rest day${pickOff ? ` — ${lower(pickOff)}` : ''}`;
    } else {
      // Forecast numbers only once the forecast actually covers the trip.
      const known = e.climate.mode === 'forecast' && !/beyond the forecast horizon/.test(d.reason);
      const flavour = p.terrain.length ? p.terrain[ride % p.terrain.length]! : '';
      ride += 1;
      line = known ? `ride — ${d.reason}` : flavour ? `ride — ${lower(flavour)}` : 'ride';
    }
    return { date: d.date, line: clamp(line, COPY_LIMITS.planLine) };
  });
}

/* ------------------------------------------------------------ one-liners */

export function headerLine(e: Expedition): string {
  return (
    `${FLAGS[e.destination.region]} ${e.destination.name.toUpperCase()} — ${fmtWindow(e.window)} — ` +
    `${usd(e.cost.perPersonUsd)}/person — ${e.daysTotal} days (${e.daysOnSnow} on snow)`
  );
}

function damageLine(e: Expedition): string {
  const s = pick(e);
  const fares = s.perMember
    .filter((m) => !m.unpriced && m.allInUsd !== null)
    .map((m) => m.allInUsd!);
  const flights = fares.length
    ? Math.min(...fares) === Math.max(...fares)
      ? `flights ${usd(fares[0]!)}`
      : `flights ${usd(Math.min(...fares))}–${usd(Math.max(...fares))}`
    : 'flights unpriced';
  const stay = e.lodging.estimated
    ? `stay ~${usd(e.lodging.perPersonUsd)} (estimate)`
    : `stay ${usd(e.lodging.perPersonUsd)}${e.lodging.options[0] ? ` at ${e.lodging.options[0].name}` : ''}`;
  const ground = e.ground.perPersonUsd === null ? 'ground unpriced' : `ground ${usd(e.ground.perPersonUsd)}`;
  const over = e.cost.overCeiling ? ` Over the ${usd(e.cost.ceilingUsd)} ceiling — someone asked for this one.` : '';
  return `**${usd(e.cost.perPersonUsd)}/person** · ${flights}, ${stay}, ${ground}.${over}`;
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

function sourceNames(e: Expedition): string[] {
  // URLs from the lookups are in the object for the record; the footer names feeds.
  return e.sources.filter((s) => !/^https?:/.test(s));
}

/* ------------------------------------------------------------- the audit */

/**
 * The rule the prompt states, checked rather than trusted: every `$N`, snow
 * amount (`Ncm`, `Nm`, inches), percentage and "N of M" count in the text
 * must be a number that exists somewhere in the Expedition. The whole object
 * is walked — numeric leaves, and every number inside a string leaf such as
 * the delta lines or the volatility note — so a figure the builder wrote into
 * a note counts as quoted. Returns the offenders.
 */
export function unquotedNumbers(text: string, e: Expedition): string[] {
  const allowed = new Set<string>();
  const add = (n: number) => {
    if (!Number.isFinite(n)) return;
    for (const v of [n, Math.abs(n)]) {
      allowed.add(String(v));
      allowed.add(String(Math.round(v)));
    }
  };
  walk(e, (leaf) => {
    if (typeof leaf === 'number') add(leaf);
    else if (typeof leaf === 'string') {
      // Dates and clock times are not figures anyone quotes; harvesting their
      // digits would make every small number look "quoted".
      const text = leaf.replace(DATE_OR_TIME, ' ');
      for (const m of text.matchAll(ANY_NUMBER)) add(Number(m[0].replace(/,/g, '')));
    }
  });
  const ok = (raw: string) => allowed.has(raw.replace(/,/g, ''));

  const bad: string[] = [];
  for (const m of text.matchAll(MONEY)) if (!ok(m[1]!)) bad.push(`$${m[1]}`);
  for (const m of text.matchAll(CM)) if (!ok(m[1]!)) bad.push(`${m[1]}cm`);
  for (const m of text.matchAll(METRES)) if (!ok(m[1]!)) bad.push(`${m[1]}m`);
  for (const m of text.matchAll(INCHES)) bad.push(m[0]);
  for (const m of text.matchAll(PCT)) if (!ok(m[1]!)) bad.push(`${m[1]}%`);
  for (const m of text.matchAll(N_OF_M)) {
    if (!ok(m[1]!) || !ok(m[2]!)) bad.push(m[0]);
  }
  return bad;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const MONEY = new RegExp(String.raw`\$${NUM}`, 'g');
const CM = new RegExp(String.raw`${NUM}\s*cm\b`, 'gi');
const METRES = new RegExp(String.raw`${NUM}\s*(?:m|metres|meters)\b`, 'gi');
const INCHES = new RegExp(String.raw`${NUM}\s*(?:inches|inch|in\.)(?=\W|$)|${NUM}\s*″`, 'gi');
const PCT = new RegExp(String.raw`${NUM}\s*%`, 'g');
const N_OF_M = /\b(\d+)\s+of\s+(?:the\s+|these\s+|those\s+)?(?:last\s+|past\s+)?(\d+)\b/gi;
const ANY_NUMBER = /\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?/g;
const DATE_OR_TIME = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?|\b\d{1,2}:\d{2}\b/g;

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

function fmtDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
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

function fmtCm(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')}cm`;
}

function lower(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function escapeLinkText(s: string): string {
  return s.replace(/[[\]]/g, '');
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
