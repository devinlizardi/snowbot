import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompleteOptions } from '../llm/client.js';
import { WEB_SEARCH_TOOL } from '../llm/client.js';
import { log } from '../logger.js';
import type { Source } from './types.js';

/** The slice of `LlmClient` a lookup needs. Narrow so tests can hand in a stub. */
export interface Completer {
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
  /** Optional: turns the 'smart' alias into a real model id for the result's provenance. */
  resolveModel?(model: CompleteOptions['model']): string;
}

export type LookupParams = {
  question: string;
  /** Anything that pins the question down (resort, dates, airport); goes in the prompt and the key. */
  context?: Record<string, unknown>;
};

export type LookupResult<T> = {
  data: T;
  /** URLs the model says it drew on. Displayed, never trusted as verification. */
  sources: string[];
  askedAt: string;
  model: string;
};

export type LookupSpec<T> = {
  /** Cache namespace; prefix with `lookup:` so the table reads cleanly. */
  name: string;
  schema: z.ZodType<T>;
  /** Fuzzy facts drift slowly — a day is the default. */
  ttlMinutes?: number;
  now?: () => Date;
};

/** Sonnet is the only model that gets the search tool; Haiku's job is formatting. */
const LOOKUP_MODEL = 'smart';

/**
 * A `Source` that answers a free-form question by web search and returns JSON
 * the caller's zod schema has accepted. One retry with the validator's
 * complaint appended, then a throw — `cached()` turns that into stale-if-any.
 */
export function lookupSource<T>(
  llm: Completer,
  spec: LookupSpec<T>,
): Source<LookupParams, LookupResult<T>> {
  const ttl = spec.ttlMinutes ?? 1440;
  const now = spec.now ?? (() => new Date());
  return {
    name: spec.name,
    key: (p) => lookupKey(p),
    ttlMinutes: () => ttl,
    fetch: async (p) => {
      const prompt = buildPrompt(p);
      const askedAt = now().toISOString();
      const model = llm.resolveModel?.(LOOKUP_MODEL) ?? LOOKUP_MODEL;
      const opts: CompleteOptions = {
        model: LOOKUP_MODEL,
        system: systemPrompt(spec.schema),
        temperature: 0,
        tools: [WEB_SEARCH_TOOL],
      };

      const first = await llm.complete(prompt, opts);
      const a = parseAnswer(first, spec.schema);
      if (a.ok) return { ...a.value, askedAt, model };

      log.warn('lookup answer rejected, retrying once', { source: spec.name, error: a.error });
      const second = await llm.complete(`${prompt}\n\n${retryNote(a.error, first)}`, opts);
      const b = parseAnswer(second, spec.schema);
      if (b.ok) return { ...b.value, askedAt, model };

      throw new Error(
        `${spec.name}: model never produced JSON matching the schema for "${p.question}" ` +
          `(first: ${a.error}; retry: ${b.error})`,
      );
    },
  };
}

/** Short sha1 of question + context; long enough not to collide, short enough to read. */
export function lookupKey(p: LookupParams): string {
  const stable = JSON.stringify({ q: p.question.trim(), c: sortKeys(p.context ?? {}) });
  return createHash('sha1').update(stable).digest('hex').slice(0, 12);
}

/* ---------------------------------------------------------------- prompts */

export function systemPrompt(schema: z.ZodType): string {
  return [
    'You are a fact-checker for a ski trip planner. Use the web_search tool to find the',
    'current, verifiable answer to the question. Prefer the official resort, operator, or',
    'pass website over aggregators.',
    '',
    'Respond with ONLY a single JSON object and nothing else — no prose, no markdown fences.',
    'The object must have exactly these fields:',
    '',
    describeSchema(schema),
    '- sources: string[] — the URLs you actually used',
    '',
    'Use null for any value you could not verify. Never guess a number, a date, or a price.',
    'Numbers are plain numbers (no units, no commas); dates are YYYY-MM-DD; money is USD.',
  ].join('\n');
}

export function buildPrompt(p: LookupParams): string {
  const lines = [`Question: ${p.question}`];
  const ctx = Object.entries(p.context ?? {});
  if (ctx.length > 0) {
    lines.push('', 'Context:');
    for (const [k, v] of ctx)
      lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return lines.join('\n');
}

function retryNote(error: string, previous: string): string {
  return [
    'Your previous reply was rejected by the schema validator:',
    `  ${error}`,
    'Previous reply (truncated):',
    `  ${previous.slice(0, 600)}`,
    'Reply again with ONLY the corrected JSON object.',
  ].join('\n');
}

/** Render a zod schema as an indented field list the model can follow. */
export function describeSchema(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  return renderProps(json, 0).join('\n');
}

type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  required?: string[];
};

function renderProps(node: JsonSchema, depth: number): string[] {
  const out: string[] = [];
  const pad = '  '.repeat(depth);
  for (const [name, prop] of Object.entries(node.properties ?? {})) {
    const desc = prop.description ? ` — ${prop.description}` : '';
    out.push(`${pad}- ${name}: ${typeName(prop)}${desc}`);
    const inner = objectOf(prop);
    if (inner) out.push(...renderProps(inner, depth + 1));
  }
  return out;
}

/** The object schema to recurse into, whether `prop` is that object or an array of it. */
function objectOf(prop: JsonSchema): JsonSchema | undefined {
  if (prop.properties) return prop;
  if (prop.items?.properties) return prop.items;
  return undefined;
}

function typeName(prop: JsonSchema): string {
  if (prop.enum) return prop.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (prop.anyOf) return prop.anyOf.map(typeName).join(' | ');
  const t = Array.isArray(prop.type) ? prop.type : [prop.type ?? 'any'];
  return t
    .map((x) => {
      if (x === 'array') return `${prop.items ? typeName(prop.items) : 'any'}[]`;
      if (x === 'object') return 'object';
      return x;
    })
    .join(' | ');
}

/* ---------------------------------------------------------------- parsing */

type Parsed<T> = { ok: true; value: { data: T; sources: string[] } } | { ok: false; error: string };

/** Tolerant of fences and chatter around the object; strict about the object itself. */
export function parseAnswer<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  const raw = extractJson(text);
  if (raw === undefined) return { ok: false, error: 'no JSON object found in reply' };

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: 'top level must be a JSON object' };
  }

  const { sources, ...rest } = obj as Record<string, unknown>;
  const res = schema.safeParse(rest);
  if (!res.success) {
    const issues = res.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `schema: ${issues}` };
  }
  const urls = Array.isArray(sources)
    ? sources.filter((s): s is string => typeof s === 'string')
    : [];
  return { ok: true, value: { data: res.data, sources: urls } };
}

function extractJson(text: string): string | undefined {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return unfenced.slice(start, end + 1);
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/* ------------------------------------------------------- ready-made lookups */

/** Wrap a lookup so callers pass domain params instead of hand-writing the question. */
function typed<P, T>(
  llm: Completer,
  spec: LookupSpec<T>,
  toParams: (p: P) => LookupParams,
): Source<P, LookupResult<T>> {
  const inner = lookupSource(llm, spec);
  return {
    name: inner.name,
    key: (p) => inner.key(toParams(p)),
    ttlMinutes: (p) => inner.ttlMinutes(toParams(p)),
    fetch: (p) => inner.fetch(toParams(p)),
  };
}

export const BaseDepthSchema = z.object({
  baseDepthCm: z.number().nullable().describe('snow depth at the base area, cm'),
  summitDepthCm: z.number().nullable().describe('snow depth at the summit / upper mountain, cm'),
  seasonSnowfallCm: z.number().nullable().describe('season-to-date snowfall, cm'),
  reportedOn: z.string().nullable().describe('date of the snow report, YYYY-MM-DD'),
});
export type BaseDepth = z.infer<typeof BaseDepthSchema>;

export const baseDepthSpec: LookupSpec<BaseDepth> = {
  name: 'lookup:base-depth',
  schema: BaseDepthSchema,
};

export function baseDepthLookup(
  llm: Completer,
): Source<{ resort: string }, LookupResult<BaseDepth>> {
  return typed(llm, baseDepthSpec, ({ resort }) => ({
    question: `What is the current snow base depth at ${resort} according to its official snow report?`,
    context: { resort },
  }));
}

export const GroundTransportSchema = z.object({
  options: z.array(
    z.object({
      mode: z.enum(['shuttle', 'bus', 'train', 'rental_car', 'taxi', 'private_transfer', 'other']),
      operator: z.string().nullable().describe('company or service name'),
      durationMin: z.number().nullable().describe('typical one-way duration, minutes'),
      priceUsdPp: z.number().nullable().describe('one-way price per person, USD'),
      notes: z.string().describe('booking requirements, frequency, seasonality'),
    }),
  ),
});
export type GroundTransport = z.infer<typeof GroundTransportSchema>;

export const groundTransportSpec: LookupSpec<GroundTransport> = {
  name: 'lookup:ground-transport',
  schema: GroundTransportSchema,
};

export function groundTransportLookup(
  llm: Completer,
): Source<{ airport: string; resort: string }, LookupResult<GroundTransport>> {
  return typed(llm, groundTransportSpec, ({ airport, resort }) => ({
    question: `How does a group of five get from ${airport} airport to ${resort} in winter, and what does each option cost?`,
    context: { airport, resort },
  }));
}

export const PassStatusSchema = z.object({
  covered: z.boolean().nullable().describe('is the resort on this pass for the given dates'),
  daysIncluded: z
    .number()
    .nullable()
    .describe('days the pass allows at this resort, null if unlimited or unknown'),
  blackoutDates: z.array(z.string()).describe('blackout dates as YYYY-MM-DD, empty if none'),
  notes: z.string().describe('restrictions, reservation requirements, pass tier caveats'),
});
export type PassStatus = z.infer<typeof PassStatusSchema>;

export const passStatusSpec: LookupSpec<PassStatus> = {
  name: 'lookup:pass-status',
  schema: PassStatusSchema,
};

export type PassStatusParams = {
  resort: string;
  pass: 'IKON';
  dates: { start: string; end: string };
};

export function passStatusLookup(
  llm: Completer,
): Source<PassStatusParams, LookupResult<PassStatus>> {
  return typed(llm, passStatusSpec, ({ resort, pass, dates }) => ({
    question:
      `Is ${resort} covered by the ${pass} Pass for ${dates.start} to ${dates.end}, ` +
      'how many days are included, and are any of those dates blacked out?',
    context: { resort, pass, start: dates.start, end: dates.end },
  }));
}
