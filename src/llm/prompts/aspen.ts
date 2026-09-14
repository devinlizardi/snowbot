import type { Confidence, DateWindow } from '../../sources/weather/consensus.js';

/**
 * The Aspen briefing: everything the anchor body may say, as data.
 *
 * `composeBriefing` in the job builds this from the sources; Haiku turns it
 * into prose; `fallbackRender` turns it into plainer prose when Haiku is
 * unavailable. Both consumers work from this object and nothing else, which is
 * what makes "no number that isn't in the briefing" a rule that can be checked
 * rather than hoped for.
 */

export type AspenCadence = 'off' | 'monthly' | 'weekly' | 'daily' | 'trip';

export type BriefingDay = {
  date: string;
  /** ECMWF IFS snowfall at the base coordinate, cm; null when it had no value. */
  baseCm: number | null;
  /** Same at the summit coordinate; null when no summit forecast was held. */
  summitCm: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  gustKmh: number | null;
};

export type Arrival = {
  member: string;
  flight: string;
  date: string;
  origin: string;
  dest: string;
  /** Last known status word (scheduled / delayed / …), when flightWatch has seen it. */
  status: string | null;
};

export type AspenBriefing = {
  cadence: Exclude<AspenCadence, 'off'>;
  resort: string;
  /** ISO timestamp of the run. */
  asOf: string;
  /** Local date of the run, YYYY-MM-DD. */
  today: string;
  tripWindow: DateWindow;
  daysOut: number;
  /** The window the forecast numbers below describe; null when no model reached it. */
  forecastWindow: DateWindow | null;
  /** `formatSnowLine` output — the only line that quotes model totals side by side. */
  snowLine: string | null;
  confidence: Confidence;
  explanation: string;
  /** Quoted totals at the base over `forecastWindow`, cm. */
  models: { model: string; totalCm: number }[];
  summitModels: { model: string; totalCm: number }[];
  days: BriefingDay[];
  temps: { minC: number; maxC: number } | null;
  maxGustKmh: number | null;
  rainRiskAtBase: boolean;
  /** Trailing seven days of observed snowfall at the base, cm. */
  observed7dCm: number | null;
  baseDepthCm: number | null;
  /** One sentence about the seasonal (CFS) signal. Monthly cadence only. */
  seasonalNote: string | null;
  /** Rendered separately from the prose — see `renderAspenPrompt`. */
  packing: string[];
  arrivals: Arrival[];
  groundNote: string;
  /** Which sources did and did not contribute, for the "as of" line. */
  sources: { contributing: string[]; missing: string[]; stale: string[] };
};

/** Discord gives us 2000; the header, packing list and footer need the rest. */
export const ASPEN_BODY_MAX_CHARS = 1500;

export const ASPEN_SYSTEM_PROMPT = `You write the pinned Aspen status message for a five-person snowboarding group's Discord.

You are handed a JSON briefing. Write the body of the message from it, and only from it.

Rules, in order of importance:
1. Every number you write must appear verbatim in the briefing (same value, same unit). Do not round, convert, add up, average, or infer any number. If the briefing has no number for something, say so in words or leave it out.
2. Snow totals are quoted per model, exactly as the "snowLine" and "models" fields give them. Never present a single combined total. Never mention WeatherNext as a source of snowfall — it does not forecast snow.
3. Keep the confidence label and its explanation as given.
4. Do not write the packing list or the arrivals table; they are appended after your text by the bot.
5. Plain Discord markdown, no headings, no emoji beyond one at most. Short paragraphs. At most ${ASPEN_BODY_MAX_CHARS} characters.
6. Sound like a friend who reads forecasts for a living, not a weather service. No hedging boilerplate, no "stay tuned".`;

/** The user turn: the briefing as JSON, minus the parts rendered elsewhere. */
export function renderAspenPrompt(briefing: AspenBriefing): string {
  const { packing: _packing, arrivals: _arrivals, ...forModel } = briefing;
  void _packing;
  void _arrivals;
  const focus = {
    monthly:
      'This is the monthly outlook. Lead with the seasonal signal and what is falling now; the trip is weeks away, so no day-by-day.',
    weekly:
      'This is the weekly update. Lead with the forecast window, the model totals and confidence, then trailing snowfall and base depth.',
    daily:
      'This is a daily countdown post. Lead with the day-by-day for the trip window and which days look like powder days.',
    trip: 'The group is on the mountain. Lead with today and tomorrow, then the rest of the window.',
  }[briefing.cadence];
  return `${focus}\n\nBriefing JSON:\n${JSON.stringify(forModel, null, 2)}`;
}

/**
 * The body without a model. Every dry run prints this when there is no
 * ANTHROPIC_API_KEY, and every live run falls back to it if Haiku fails, so it
 * has to read as a finished post rather than a debug dump.
 */
export function fallbackRender(b: AspenBriefing): string {
  const out: string[] = [];

  if (b.snowLine) {
    out.push(b.snowLine);
    out.push(b.explanation);
  } else {
    out.push(
      b.cadence === 'monthly'
        ? `${b.resort}: ${b.daysOut} days to go. No day-level forecast reaches the trip yet.`
        : `${b.resort}: no snowfall model reached the forecast window — ${b.explanation}`,
    );
  }

  const conditions: string[] = [];
  if (b.temps) conditions.push(`temps ${fmtC(b.temps.minC)} to ${fmtC(b.temps.maxC)}`);
  if (b.maxGustKmh !== null) conditions.push(`gusts to ${b.maxGustKmh} km/h`);
  if (b.rainRiskAtBase) conditions.push('rain risk at the base');
  if (conditions.length) out.push(capitalize(conditions.join(', ')) + '.');

  const table = renderDayTable(b.days);
  if (table && b.cadence !== 'monthly') out.push(table);

  const ground: string[] = [];
  if (b.observed7dCm !== null) ground.push(`${b.observed7dCm}cm fell in the last 7 days`);
  if (b.baseDepthCm !== null) ground.push(`base depth ${b.baseDepthCm}cm`);
  if (ground.length) out.push(capitalize(ground.join('; ')) + '.');

  if (b.seasonalNote) out.push(b.seasonalNote);

  const asOf: string[] = [];
  if (b.sources.stale.length) asOf.push(`stale: ${b.sources.stale.join(', ')}`);
  if (b.sources.missing.length) asOf.push(`missing: ${b.sources.missing.join(', ')}`);
  if (asOf.length) out.push(`_Sources — ${asOf.join('; ')}_`);

  return clamp(out.join('\n\n'), ASPEN_BODY_MAX_CHARS);
}

/** Compact per-day block. Base and summit ECMWF only — one model per column, no blending. */
export function renderDayTable(days: readonly BriefingDay[]): string | null {
  const rows = days.filter((d) => d.baseCm !== null || d.summitCm !== null);
  if (rows.length === 0) return null;
  const hasSummit = rows.some((d) => d.summitCm !== null);
  const header = ['day', 'base', ...(hasSummit ? ['summit'] : []), 'low', 'high', 'gust'];
  const cells = rows.map((d) => [
    dayLabel(d.date),
    cm(d.baseCm),
    ...(hasSummit ? [cm(d.summitCm)] : []),
    fmtC(d.tempMinC),
    fmtC(d.tempMaxC),
    d.gustKmh === null ? '–' : `${Math.round(d.gustKmh)}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return ['```', line(header), ...cells.map(line), '```', '_ECMWF IFS; cm, °C, km/h_'].join('\n');
}

/**
 * The invariant the prompt asks for, checked rather than trusted: every
 * "<n>cm" in the body must be a total or a per-day value the briefing holds.
 * Returns the offenders so the caller can log why it fell back.
 */
export function unquotedSnowNumbers(body: string, b: AspenBriefing): string[] {
  const allowed = new Set<string>();
  const add = (n: number | null) => {
    if (n === null) return;
    allowed.add(String(n));
    allowed.add(String(Math.round(n)));
  };
  for (const m of [...b.models, ...b.summitModels]) add(m.totalCm);
  for (const d of b.days) {
    add(d.baseCm);
    add(d.summitCm);
  }
  add(b.observed7dCm);
  add(b.baseDepthCm);
  const bad: string[] = [];
  for (const [, n] of body.matchAll(/(\d+(?:\.\d+)?)\s*cm/gi)) {
    if (n !== undefined && !allowed.has(n)) bad.push(`${n}cm`);
  }
  return bad;
}

/* ---------------------------------------------------------------- helpers */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 28" — parsed by hand so no timezone can shift the day. */
export function dayLabel(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  const d = new Date(t);
  return `${DOW[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function cm(n: number | null): string {
  return n === null ? '–' : `${Math.round(n)}`;
}

function fmtC(n: number | null): string {
  return n === null ? '–' : `${Math.round(n)}°C`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
