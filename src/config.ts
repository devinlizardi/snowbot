import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/* ------------------------------------------------------------------ schema */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const MemberSchema = z.object({
  name: z.string().min(1),
  discord_id_env: z.string().optional(),
  airports: z.array(z.string().regex(/^[A-Z]{3}$/, 'expected a 3-letter IATA code')).min(1),
  price_all: z.boolean().default(false),
});

/** A forecast point: where to ask, and how high it is there. */
const PointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  elevation_m: z.number().int(),
});

const DestinationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: z.enum(['JP', 'CA', 'US', 'EU']),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  base_elevation_m: z.number().int(),
  summit_elevation_m: z.number().int(),
  airport: z.string().regex(/^[A-Z]{3}$/),
  ground: z.string(),
  lodging_band_usd_pp_night: z.tuple([z.number(), z.number()]),
  min_days: z.number().int().positive(),
  ideal_days: z.number().int().positive(),
  pass_verify: z.boolean().default(true),
});

const ConfigSchema = z
  .object({
    timezone: z.string().default('America/New_York'),
    currency_display: z.literal('USD').default('USD'),

    discord: z.object({
      guild_id_env: z.string().default('DISCORD_GUILD_ID'),
      channel_id_env: z.string().default('DISCORD_CHANNEL_ID'),
      test_guild_id_env: z.string().default('DISCORD_TEST_GUILD_ID'),
      test_channel_id_env: z.string().default('DISCORD_TEST_CHANNEL_ID'),
      max_root_posts_per_day: z.number().int().positive().default(2),
      anchor: z.object({ pin: z.boolean().default(true) }).default({ pin: true }),
    }),

    roster: z.array(MemberSchema).min(1),

    aspen: z.object({
      name: z.string(),
      window_start: isoDate,
      window_end: isoDate,
      base: PointSchema,
      summit: PointSchema,
      airports: z.array(z.string()),
      cadence: z.object({
        monthly_from: isoDate,
        weekly_from: isoDate,
        daily_from: isoDate,
      }),
    }),

    weather: z.object({
      weathernext_provider: z.enum(['bigquery', 'maps']).default('bigquery'),
      bigquery: z.object({
        project_id_env: z.string().default('GCP_PROJECT_ID'),
        dataset_id_env: z.string().default('GCP_DATASET_ID'),
        table_0p1deg: z.string(),
        table_0p05deg: z.string(),
        preferred_table: z.enum(['table_0p1deg', 'table_0p05deg']).default('table_0p1deg'),
        max_bytes_billed: z.number().int().positive(),
      }),
      open_meteo: z.object({
        models: z.array(z.string()).min(1),
        forecast_days: z.number().int().min(1).max(16).default(15),
      }),
      cache_ttl_minutes: z.object({
        forecast: z.number().int().positive(),
        archive: z.number().int().positive(),
        seasonal: z.number().int().positive(),
      }),
    }),

    flights: z.object({
      provider: z.literal('serpapi'),
      date_flex_days: z.number().int().min(0).max(7),
      cache_ttl_hours: z.number().int().positive(),
      monthly_search_cap: z.number().int().positive(),
    }),

    lodging: z.object({
      provider: z.literal('serpapi'),
      min_sleeps: z.number().int().positive(),
      cache_ttl_hours: z.number().int().positive(),
    }),

    llm: z.object({
      fast_model: z.string(),
      smart_model: z.string(),
      monthly_usd_cap: z.number().positive(),
    }),

    expedition: z.object({
      ceiling_usd: z.object({
        international: z.number().positive(),
        domestic: z.number().positive(),
      }),
      repeat_cooldown_weeks: z.number().int().positive(),
      arrival_window_hours: z.number().positive(),
      // Windows are only ever proposed inside the riding season. MM-DD, and the
      // end may wrap past New Year (12-01 → 04-15 is the default).
      season: z
        .object({
          start: z.string().regex(/^\d{2}-\d{2}$/, 'expected MM-DD').default('12-01'),
          end: z.string().regex(/^\d{2}-\d{2}$/, 'expected MM-DD').default('04-15'),
        })
        .default({ start: '12-01', end: '04-15' }),
      ranking_weights: z.object({
        forecast_snow_10d_confidence_weighted: z.number(),
        observed_snow_7d: z.number(),
        cost: z.number(),
        logistics_ease: z.number(),
      }),
    }),

    board: z.array(DestinationSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const w = cfg.expedition.ranking_weights;
    const sum = w.forecast_snow_10d_confidence_weighted + w.observed_snow_7d + w.cost + w.logistics_ease;
    if (Math.abs(sum - 1) > 1e-6) {
      ctx.addIssue({ code: 'custom', path: ['expedition', 'ranking_weights'], message: `weights must sum to 1, got ${sum}` });
    }
    const ids = cfg.board.map((d) => d.id);
    const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupe) ctx.addIssue({ code: 'custom', path: ['board'], message: `duplicate destination id: ${dupe}` });
    for (const d of cfg.board) {
      if (d.min_days > d.ideal_days) {
        ctx.addIssue({ code: 'custom', path: ['board', d.id], message: `min_days > ideal_days for ${d.id}` });
      }
    }
    if (cfg.aspen.window_end < cfg.aspen.window_start) {
      ctx.addIssue({ code: 'custom', path: ['aspen'], message: 'window_end precedes window_start' });
    }
    if (cfg.aspen.summit.elevation_m <= cfg.aspen.base.elevation_m) {
      ctx.addIssue({ code: 'custom', path: ['aspen'], message: 'summit is not above base' });
    }
  });

export type RawConfig = z.infer<typeof ConfigSchema>;
export type Destination = z.infer<typeof DestinationSchema>;
export type Point = z.infer<typeof PointSchema>;

/** A roster member with env indirection already resolved. */
export type Member = {
  name: string;
  discordId?: string;
  airports: string[];
  /** Airports actually priced on every search. */
  pricedAirports: string[];
};

export type Config = RawConfig & {
  members: Member[];
  channels: {
    real: { guildId?: string; channelId?: string };
    test: { guildId?: string; channelId?: string };
  };
  bigquery: { projectId?: string; datasetId?: string; table: string };
};

/* ------------------------------------------------------------------- merge */

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge; arrays are replaced wholesale, not concatenated. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlain(base) || !isPlain(override)) return (override === undefined ? base : (override as T));
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/* ------------------------------------------------------------ env values */

/**
 * A value read from a `.env` file can arrive with the alignment comment still
 * attached: docker compose's `env_file:` hands `260572317921443840   # dev
 * guild` through verbatim, and Discord answers an id like that with an opaque
 * `50035 Invalid Form Body`. Node's own `.env` parser strips it, compose's does
 * not, so strip it once here and no caller has to know which loaded the file.
 *
 * Only whitespace-then-`#` counts, so a value that merely contains a `#` is
 * left alone. An empty result is treated as unset.
 */
export function stripInlineComment(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.replace(/\s+#[^\n]*$/, '').trim();
  return v || undefined;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Fail on a malformed Discord id here, with the name of the variable that
 *  holds it, rather than as a 400 from the API several calls later. */
export function assertSnowflake(value: string, label: string): string {
  if (!SNOWFLAKE.test(value)) {
    throw new Error(
      `${label} is not a Discord id: ${JSON.stringify(value)} — expected 17–20 digits ` +
        `and nothing else (a trailing "# comment" in .env is the usual cause)`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------- load */

export type LoadOptions = {
  path?: string;
  localPath?: string;
  env?: NodeJS.ProcessEnv;
};

export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const path = resolve(opts.path ?? 'config.yaml');
  const localPath = resolve(opts.localPath ?? 'config.local.yaml');

  let raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (existsSync(localPath)) {
    raw = deepMerge(raw as Plain, parseYaml(readFileSync(localPath, 'utf8')));
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`config is invalid (${path}):\n${issues}`);
  }
  const cfg = parsed.data;

  const members: Member[] = cfg.roster.map((m) => ({
    name: m.name,
    discordId: m.discord_id_env ? stripInlineComment(env[m.discord_id_env]) : undefined,
    airports: m.airports,
    pricedAirports: m.price_all ? m.airports : m.airports.slice(0, 1),
  }));

  const tableKey = cfg.weather.bigquery.preferred_table;
  return {
    ...cfg,
    members,
    channels: {
      real: {
        guildId: stripInlineComment(env[cfg.discord.guild_id_env]),
        channelId: stripInlineComment(env[cfg.discord.channel_id_env]),
      },
      test: {
        guildId: stripInlineComment(env[cfg.discord.test_guild_id_env]),
        channelId: stripInlineComment(env[cfg.discord.test_channel_id_env]),
      },
    },
    bigquery: {
      projectId: stripInlineComment(env[cfg.weather.bigquery.project_id_env]),
      datasetId: stripInlineComment(env[cfg.weather.bigquery.dataset_id_env]),
      table: cfg.weather.bigquery[tableKey],
    },
  };
}

/* ----------------------------------------------------------------- secrets */

/** Secrets are read at point of use, never at boot, so a dry run of one job
 *  doesn't demand keys belonging to a different job. */
export function requireSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = stripInlineComment(env[name]);
  if (!v) throw new Error(`missing required secret ${name} — set it in .env (never in config.yaml)`);
  return v;
}

export function optionalSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return stripInlineComment(env[name]);
}
