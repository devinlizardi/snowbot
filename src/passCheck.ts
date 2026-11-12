import type { Destination } from './config.js';
import type { PassAccess, PassName } from './sources/lookup.js';
import { PASS_LABEL } from './sources/lookup.js';

/*
 * Applies a trip window to what the pass lookup said about a resort. Pure: no
 * I/O, no clock. Every fact in the summary comes from `access`, which only
 * ever comes from the live lookup — config never says what a pass covers.
 */

export type TripWindow = { start: string; end: string };

export type PassCheck = {
  /** null when the lookup hasn't answered: nothing below is known. */
  onPass: boolean | null;
  daysLimit: number | 'unlimited' | null;
  tripDays: number;
  /** Every date in the window that is blacked out, YYYY-MM-DD, in order. */
  blackoutDates: string[];
  /** True when the window has more days than the pass allows here. */
  overDayLimit: boolean;
  /** One line a person can read in the channel. */
  summary: string;
};

export function passCheck(
  entry: Pick<Destination, 'name'>,
  window: TripWindow,
  access: PassAccess | null,
  pass: PassName | 'none' = 'ikon_base',
): PassCheck {
  const tripDays = daysIn(window);
  if (pass === 'none') {
    return {
      onPass: null,
      daysLimit: null,
      tripDays,
      blackoutDates: [],
      overDayLimit: false,
      summary: 'No pass in the group — lift tickets on top.',
    };
  }
  const label = PASS_LABEL[pass];
  if (!access || access.onPass === null) {
    return {
      onPass: null,
      daysLimit: null,
      tripDays,
      blackoutDates: [],
      overDayLimit: false,
      summary: `${label}: not checked yet.`,
    };
  }
  if (!access.onPass) {
    return {
      onPass: false,
      daysLimit: null,
      tripDays,
      blackoutDates: [],
      overDayLimit: false,
      summary: `Not on the ${label} — lift tickets on top.`,
    };
  }

  const blackoutDates = datesIn(window).filter((d) =>
    access.blackouts.some((b) => d >= b.start && d <= b.end),
  );
  const overDayLimit = typeof access.daysLimit === 'number' && tripDays > access.daysLimit;

  const limit =
    access.daysLimit === 'unlimited'
      ? 'unlimited'
      : access.daysLimit === null
        ? 'day limit unknown'
        : `${access.daysLimit} days`;
  const notes = access.notes.trim() ? ` (${access.notes.trim().replace(/\.$/, '')})` : '';
  const problems: string[] = [];
  if (blackoutDates.length) problems.push(`blacked out ${ranges(blackoutDates)}`);
  if (overDayLimit)
    problems.push(`your ${tripDays}-day trip runs past the ${access.daysLimit}-day limit`);
  const tail = problems.length ? ` — ${problems.join('; ')}.` : ', no blackouts in these dates.';

  return {
    onPass: true,
    daysLimit: access.daysLimit,
    tripDays,
    blackoutDates,
    overDayLimit,
    summary: `${label}: ${limit}${notes}${tail}`,
  };
}

/* -------------------------------------------------------------- helpers */

const DAY = 86_400_000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ms(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

export function daysIn(w: TripWindow): number {
  return Math.round((ms(w.end) - ms(w.start)) / DAY) + 1;
}

function datesIn(w: TripWindow): string[] {
  const out: string[] = [];
  for (let t = ms(w.start); t <= ms(w.end); t += DAY)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function short(d: string): string {
  const x = new Date(ms(d));
  return `${MON[x.getUTCMonth()]} ${x.getUTCDate()}`;
}

/** ['2026-12-28','2026-12-29','2026-12-30','2027-01-16'] → "Dec 28–30, Jan 16". */
export function ranges(dates: readonly string[]): string {
  const runs: [string, string][] = [];
  for (const d of dates) {
    const last = runs.at(-1);
    if (last && ms(d) - ms(last[1]) === DAY) last[1] = d;
    else runs.push([d, d]);
  }
  return runs
    .map(([a, b]) => {
      if (a === b) return short(a);
      const sameMonth = a.slice(0, 7) === b.slice(0, 7);
      return sameMonth ? `${short(a)}–${Number(b.slice(8))}` : `${short(a)}–${short(b)}`;
    })
    .join(', ');
}
