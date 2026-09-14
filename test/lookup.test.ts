import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openDb, type DB } from '../src/db.js';
import type { CompleteOptions } from '../src/llm/client.js';
import { cached } from '../src/sources/_cache.js';
import {
  BaseDepthSchema,
  baseDepthLookup,
  describeSchema,
  GroundTransportSchema,
  groundTransportLookup,
  lookupKey,
  lookupSource,
  PassStatusSchema,
  passStatusLookup,
  type Completer,
} from '../src/sources/lookup.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** A completer that replays scripted replies and records what it was asked. */
function scripted(replies: string[]) {
  const calls: { prompt: string; opts: CompleteOptions }[] = [];
  const complete = vi.fn(async (prompt: string, opts: CompleteOptions) => {
    calls.push({ prompt, opts });
    const r = replies.shift();
    if (r === undefined) throw new Error('script exhausted');
    return r;
  });
  const llm: Completer = { complete, resolveModel: () => 'claude-sonnet-4-6' };
  return { llm, calls, complete };
}

const DepthSchema = z.object({
  baseCm: z.number().nullable(),
  reportedOn: z.string().nullable(),
});
const now = () => new Date('2026-09-14T12:00:00Z');

describe('lookupSource', () => {
  it('parses fenced JSON and returns data, sources and provenance', async () => {
    const { llm, calls } = scripted([
      'Here you go:\n```json\n{"baseCm": 120, "reportedOn": "2026-02-01", "sources": ["https://a.example"]}\n```',
    ]);
    const src = lookupSource(llm, { name: 'lookup:test', schema: DepthSchema, now });
    const out = await src.fetch({ question: 'base at Niseko?', context: { resort: 'Niseko' } });
    expect(out).toEqual({
      data: { baseCm: 120, reportedOn: '2026-02-01' },
      sources: ['https://a.example'],
      askedAt: '2026-09-14T12:00:00.000Z',
      model: 'claude-sonnet-4-6',
    });
    expect(calls[0]!.opts.model).toBe('smart');
    expect(calls[0]!.opts.tools?.[0]).toMatchObject({ type: 'web_search_20250305' });
    expect(calls[0]!.prompt).toContain('Question: base at Niseko?');
    expect(calls[0]!.prompt).toContain('- resort: Niseko');
  });

  it('retries once with the validator error appended, then succeeds', async () => {
    const { llm, calls } = scripted([
      '{"baseCm": "lots", "reportedOn": null}',
      '{"baseCm": 80, "reportedOn": null, "sources": []}',
    ]);
    const src = lookupSource(llm, { name: 'lookup:test', schema: DepthSchema });
    const out = await src.fetch({ question: 'q' });
    expect(out.data).toEqual({ baseCm: 80, reportedOn: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toMatch(/rejected by the schema validator/);
    expect(calls[1]!.prompt).toMatch(/baseCm/);
  });

  it('throws a descriptive error after two failures', async () => {
    const { llm, complete } = scripted(['no json here', '```json\n{"baseCm": 1,}\n```']);
    const src = lookupSource(llm, { name: 'lookup:test', schema: DepthSchema });
    await expect(src.fetch({ question: 'q' })).rejects.toThrow(
      /lookup:test: model never produced JSON.*no JSON object found.*invalid JSON/,
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('serves the second call from cache without asking the model again', async () => {
    const { llm, complete } = scripted(['{"baseCm": 5, "reportedOn": null, "sources": []}']);
    const src = lookupSource(llm, { name: 'lookup:test', schema: DepthSchema });
    const params = { question: 'q', context: { resort: 'Aspen' } };
    const a = await cached(db, src, params);
    const b = await cached(db, src, params);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.value.data).toEqual({ baseCm: 5, reportedOn: null });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 24h ttl', () => {
    const src = lookupSource(scripted([]).llm, { name: 'n', schema: DepthSchema });
    expect(src.ttlMinutes({ question: 'q' })).toBe(1440);
  });

  it('refuses to hit the model in offline mode with an empty cache', async () => {
    const { llm, complete } = scripted(['{"baseCm": 5, "reportedOn": null}']);
    const src = lookupSource(llm, { name: 'lookup:test', schema: DepthSchema });
    await expect(cached(db, src, { question: 'q' }, { offline: true })).rejects.toThrow(
      /offline mode/,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('keys on question and context, independent of context key order', () => {
    const k1 = lookupKey({ question: 'q', context: { a: 1, b: 2 } });
    const k2 = lookupKey({ question: 'q', context: { b: 2, a: 1 } });
    const k3 = lookupKey({ question: 'q', context: { a: 1, b: 3 } });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('puts every schema field name and description into the system prompt', async () => {
    const { llm, calls } = scripted(['{"options": [], "sources": []}']);
    const src = lookupSource(llm, { name: 'lookup:test', schema: GroundTransportSchema });
    await src.fetch({ question: 'q' });
    const system = calls[0]!.opts.system!;
    for (const f of [
      'options',
      'mode',
      'operator',
      'durationMin',
      'priceUsdPp',
      'notes',
      'sources',
    ]) {
      expect(system).toContain(`- ${f}:`);
    }
    expect(system).toContain('"shuttle"');
    expect(system).toMatch(/null/);
  });
});

describe('describeSchema', () => {
  it('renders nullable, arrays and nested objects readably', () => {
    const text = describeSchema(BaseDepthSchema);
    expect(text).toContain('- baseDepthCm: number | null — snow depth at the base area, cm');
    const nested = describeSchema(GroundTransportSchema);
    expect(nested).toMatch(/^- options: object\[\]\n {2}- mode: "shuttle"/);
  });
});

describe('ready-made lookups', () => {
  const examples: [string, z.ZodType, unknown][] = [
    [
      'base depth',
      BaseDepthSchema,
      { baseDepthCm: 210, summitDepthCm: 340, seasonSnowfallCm: 890, reportedOn: '2026-02-14' },
    ],
    [
      'base depth, nothing verified',
      BaseDepthSchema,
      { baseDepthCm: null, summitDepthCm: null, seasonSnowfallCm: null, reportedOn: null },
    ],
    [
      'ground transport',
      GroundTransportSchema,
      {
        options: [
          {
            mode: 'bus',
            operator: 'Hokkaido Resort Liner',
            durationMin: 180,
            priceUsdPp: 45,
            notes: 'book ahead',
          },
          {
            mode: 'rental_car',
            operator: null,
            durationMin: 150,
            priceUsdPp: null,
            notes: 'winter tyres',
          },
        ],
      },
    ],
    [
      'pass status',
      PassStatusSchema,
      {
        covered: true,
        daysIncluded: 7,
        blackoutDates: ['2026-12-26', '2026-12-27'],
        notes: 'Base Pass only',
      },
    ],
  ];

  it.each(examples)('%s example validates', (_name, schema, example) => {
    expect(schema.safeParse(example).success).toBe(true);
  });

  it('rejects a ground transport mode outside the enum', () => {
    const bad = {
      options: [{ mode: 'helicopter', operator: null, durationMin: 1, priceUsdPp: 1, notes: '' }],
    };
    expect(GroundTransportSchema.safeParse(bad).success).toBe(false);
  });

  it('turns domain params into a question with context in the key', async () => {
    const { llm, calls } = scripted([
      '{"covered": true, "daysIncluded": null, "blackoutDates": [], "notes": "", "sources": ["https://ikonpass.com"]}',
    ]);
    const src = passStatusLookup(llm);
    const params = {
      resort: 'Niseko United',
      pass: 'IKON' as const,
      dates: { start: '2027-01-10', end: '2027-01-17' },
    };
    const out = await cached(db, src, params);
    expect(out.value.data.covered).toBe(true);
    expect(calls[0]!.prompt).toContain('Niseko United');
    expect(calls[0]!.prompt).toContain('2027-01-10');
    expect(src.key(params)).toMatch(/^[0-9a-f]{12}$/);
    expect(src.key(params)).not.toBe(src.key({ ...params, resort: 'Revelstoke' }));
  });

  it('names each lookup with a distinct cache namespace', () => {
    const { llm } = scripted([]);
    const names = [
      baseDepthLookup(llm).name,
      groundTransportLookup(llm).name,
      passStatusLookup(llm).name,
    ];
    expect(new Set(names).size).toBe(3);
    expect(names.every((n) => n.startsWith('lookup:'))).toBe(true);
  });
});
