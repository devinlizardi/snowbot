import { modelName } from '../../sources/weather/consensus.js';
import type { Snapshot } from '../../snapshot.js';
import { LOOKAHEAD_FROM_DAY, LOOKAHEAD_TO_DAY } from '../../snapshot.js';

/*
 * "The read": two to four sentences above the /snapshot table, written by
 * Haiku from the composed Snapshot and nothing else. `checkRead` is what makes
 * that a rule rather than a hope: every number in the read must already be in
 * the facts, and the whole message still goes through `assertSnapshotHonest`.
 * Anything that fails falls back to the templated callouts.
 */

export const READ_MAX_CHARS = 420;

export type ReadFacts = {
  days: number;
  groups: { group: string; pattern: string }[];
  spots: {
    name: string;
    group: string;
    /** "8–10cm", "rain", "dry", … — exactly what the table prints. */
    snow: string;
    /** Per-model 7-day totals, cm. */
    models: Record<string, number>;
    agreement: string | null;
    rainDays: string[];
    snowUpHigh: { day: string; freezingLevelM: number } | null;
    peakGustKmh: number | null;
  }[];
  lookAhead: { window: string; confidence: 'low'; storms: { name: string; snow: string }[] };
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (d: string) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
const range = (lo: number, hi: number) => (lo === hi ? `${hi}cm` : `${lo}–${hi}cm`);

export function readFacts(s: Snapshot): ReadFacts {
  return {
    days: 7,
    groups: s.groups.map((g) => ({ group: g.group, pattern: g.pattern })),
    spots: s.spots
      .filter((r) => r.snow !== null)
      .map((r) => ({
        name: r.spot.label,
        group: r.spot.group,
        snow: r.cell.kind === 'range' ? range(r.cell.lowCm, r.cell.highCm) : r.cell.kind,
        models: Object.fromEntries(
          (r.snow?.models ?? []).map((m) => [modelName(m.model), Math.round(m.totalCm)]),
        ),
        agreement: r.agreement,
        rainDays: (r.conditions?.rainDays ?? []).map(weekday),
        snowUpHigh: r.conditions?.snowUpHigh
          ? {
              day: weekday(r.conditions.snowUpHigh.date),
              freezingLevelM: Math.round(r.conditions.snowUpHigh.freezingLevelM / 100) * 100,
            }
          : null,
        peakGustKmh: r.conditions?.peakGust?.kmh ?? null,
      })),
    lookAhead: {
      window: `days ${LOOKAHEAD_FROM_DAY}–${LOOKAHEAD_TO_DAY}`,
      confidence: 'low',
      storms: s.lookAhead.map((x) => ({ name: x.spot.label, snow: range(x.lowCm, x.highCm) })),
    },
  };
}

export const READ_SYSTEM_PROMPT = [
  'You write the two-to-four-sentence summary at the top of a ski weather report for a group of',
  'five friends who snowboard. Say where it is snowing this week, where the forecast models',
  'disagree, and what might be building in days 8–15. Plain, specific, a little dry; no hype,',
  'no emoji, no markdown, no lists.',
  '',
  'Rules:',
  '- Use ONLY the facts given. Every number you write must appear in the facts exactly.',
  '- Snow amounts only as given (e.g. "8–10cm"); never add, average or convert.',
  '- Anything about days 8–15 must say it is low confidence or early.',
  '- If nothing much is happening, say so in one sentence.',
  '- At most 4 sentences and 400 characters. Reply with the summary only.',
].join('\n');

export function renderReadPrompt(facts: ReadFacts): string {
  return `Facts (JSON):\n${JSON.stringify(facts)}\n\nWrite the summary.`;
}

const NUM = /\d+(?:[.,]\d+)?/g;

export type ReadCheck = { ok: true; read: string } | { ok: false; why: string };

/** The read is used only if every number in it is one the facts already hold. */
export function checkRead(raw: string, facts: ReadFacts): ReadCheck {
  const read = raw.trim().replace(/\s+/g, ' ');
  if (!read) return { ok: false, why: 'empty' };
  if (read.length > READ_MAX_CHARS) return { ok: false, why: `too long (${read.length} chars)` };
  if (/[`*#@<>[\]]|https?:/.test(read)) return { ok: false, why: 'markup, a mention or a link' };
  const sentences = read.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 4) return { ok: false, why: `${sentences.length} sentences` };
  const known = new Set((JSON.stringify(facts).match(NUM) ?? []).map(norm));
  const invented = (read.match(NUM) ?? []).map(norm).filter((n) => !known.has(n));
  if (invented.length)
    return { ok: false, why: `numbers not in the facts: ${invented.join(', ')}` };
  return { ok: true, read };
}

function norm(n: string): string {
  return n.replace(/,/g, '');
}
