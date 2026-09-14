import { createServer, type Server } from 'node:http';
import { Client, GatewayIntentBits } from 'discord.js';
import { loadConfig, optionalSecret } from './config.js';
import { kvGet, kvSet, openDb, type DB } from './db.js';
import { attachInteractionHandler, type CommandAction } from './discord/commands.js';
import type { Job } from './jobs/_runner.js';
import { runJob } from './jobs/_runner.js';
import { log } from './logger.js';
import { startScheduler, type Scheduler } from './scheduler.js';

/*
 * `pnpm dev -- serve` — the long-running mode the container actually uses.
 * Three things stay up: the cron scheduler, a gateway connection so slash
 * commands are answered, and a loopback-only healthz endpoint for Docker.
 * Each job run still opens its own config/db/poster via `runJob`, so this
 * process holds only what it needs between ticks: one SQLite handle for
 * healthz and the command handlers.
 */

type LastRun = {
  job: string;
  started_at: string;
  ended_at: string | null;
  ok: number | null;
  dry_run: number;
  error: string | null;
};

/** Most recent job_runs row per job — what "is it alive?" actually means here. */
export function lastRuns(db: DB): LastRun[] {
  return db
    .prepare(
      `SELECT job, started_at, ended_at, ok, dry_run, error
         FROM job_runs
        WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job)
        ORDER BY job`,
    )
    .all() as LastRun[];
}

/**
 * `/trip` echoes the anchor text the aspenUpdate job leaves in kv. The
 * anchor's own `anchor:<channel>` key holds a message id, not prose, so a
 * bare snowflake is skipped — same rule `commands.ts` applies.
 */
export function tripText(db: DB): string | undefined {
  const briefing = kvGet(db, 'aspen:last_briefing');
  if (briefing?.trim()) return briefing;
  const rows = db
    .prepare(`SELECT value FROM kv WHERE key LIKE 'anchor:%' ORDER BY updated_at DESC, key`)
    .all() as { value: string }[];
  return rows.map((r) => r.value).find((v) => v.trim().length > 0 && !/^\d{15,22}$/.test(v.trim()));
}

export type ServeOptions = {
  env?: NodeJS.ProcessEnv;
  port?: number;
};

export type ServeHandle = {
  scheduler: Scheduler;
  close(): Promise<void>;
};

export async function startServe(
  jobs: Record<string, Job>,
  opts: ServeOptions = {},
): Promise<ServeHandle> {
  const env = opts.env ?? process.env;
  const startedAt = Date.now();
  const cfg = loadConfig({ env });
  const db = openDb();
  const target = env.SNOWBOT_CHANNEL === 'real' ? 'real' : 'test';

  const scheduler = startScheduler(jobs, { env, log: log.child({ mode: 'serve' }) });

  /* ---------------------------------------------------------- discord */

  let client: Client | undefined;
  const token = optionalSecret('DISCORD_BOT_TOKEN', env);
  if (token) {
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    attachInteractionHandler(client, {
      db,
      cfg,
      onAction: async (action: CommandAction) => {
        if (action.kind === 'trip') {
          return tripText(db) ?? 'No Aspen status yet — the first briefing has not run.';
        }
        const job = jobs.expeditionBuild;
        if (!job) return 'The expedition builder is not wired in this build yet.';
        // The job reads the request from kv, since JobContext carries no
        // per-invocation parameters and adding some would touch _runner.ts.
        kvSet(db, 'expedition:build_request', JSON.stringify(action));
        try {
          await runJob(job, { job: job.name, dryRun: false, target });
          return `Built${action.destination ? ` ${action.destination}` : ''} — see the ${target} channel.`;
        } catch (err) {
          return `Build failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
    client.once('clientReady', () => log.info('gateway ready', { user: client?.user?.tag }));
    await client.login(token);
  } else {
    log.warn('DISCORD_BOT_TOKEN unset — serving cron and healthz only; slash commands are off');
  }

  /* ---------------------------------------------------------- healthz */

  const port = opts.port ?? Number(env.PORT ?? 8080);
  const server: Server = createServer((req, res) => {
    if (req.url !== '/healthz' && req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    let body: string;
    let status = 200;
    try {
      body = JSON.stringify({
        ok: true,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        scheduled: scheduler.scheduled,
        discord: client?.isReady() ?? false,
        lastRuns: lastRuns(db),
      });
    } catch (err) {
      status = 500;
      body = JSON.stringify({ ok: false, error: String(err) });
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  log.info('healthz listening', { port });

  /* --------------------------------------------------------- shutdown */

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      log.info('shutting down');
      await scheduler.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client?.destroy();
      db.close();
    })());

  return { scheduler, close };
}

/** Wire SIGTERM/SIGINT so `docker compose stop` ends cleanly instead of on the kill timer. */
export function handleSignals(handle: ServeHandle): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      handle
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          log.error('shutdown failed', { error: String(err) });
          process.exit(1);
        });
    });
  }
}
