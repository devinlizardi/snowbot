import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import type { DB } from '../db.js';
import { openDb } from '../db.js';
import type { ChannelTarget } from '../discord/client.js';
import { Poster } from '../discord/client.js';
import { LlmClient } from '../llm/client.js';
import { log, type Logger } from '../logger.js';

export type JobContext = {
  cfg: Config;
  db: DB;
  poster: Poster;
  llm: LlmClient;
  dryRun: boolean;
  target: ChannelTarget;
  /** Injectable clock, so cadence and watch jobs are testable without waiting. */
  now: Date;
  log: Logger;
};

export type Job = {
  readonly name: string;
  run(ctx: JobContext): Promise<void>;
};

export type CliArgs = {
  job: string;
  dryRun: boolean;
  target: ChannelTarget;
  now?: Date;
};

/**
 * `pnpm dev -- job=noop --dry-run --channel test`
 *
 * The channel defaults to `test` and has to be asked for by name to be `real`,
 * because the failure mode of getting this wrong is posting a half-finished
 * forecast into a channel owned by someone else.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args = argv.slice(2);
  const get = (prefix: string) => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

  const job = get('job=') ?? args.find((a) => !a.startsWith('-')) ?? '';
  if (!job) throw new Error('no job given — try: pnpm dev -- job=noop --dry-run');

  const flagIdx = args.indexOf('--channel');
  const channel = get('--channel=') ?? (flagIdx >= 0 ? args[flagIdx + 1] : undefined) ?? env.SNOWBOT_CHANNEL ?? 'test';
  if (channel !== 'test' && channel !== 'real') {
    throw new Error(`--channel must be "test" or "real", got "${channel}"`);
  }

  const nowRaw = get('--now=');
  const now = nowRaw ? new Date(nowRaw) : undefined;
  if (now && Number.isNaN(now.getTime())) throw new Error(`--now=${nowRaw} is not a date`);

  return {
    job,
    dryRun: args.includes('--dry-run'),
    target: channel,
    ...(now ? { now } : {}),
  };
}

export async function runJob(job: Job, args: CliArgs): Promise<void> {
  const cfg = loadConfig();
  const db = openDb();
  const now = args.now ?? new Date();
  const jlog = log.child({ job: job.name, dryRun: args.dryRun, channel: args.target });

  if (args.target === 'real' && !args.dryRun) {
    jlog.warn('posting for real to the live channel');
  }

  const poster = new Poster(cfg, db, { dryRun: args.dryRun, target: args.target, job: job.name });
  const llm = new LlmClient(cfg, db, job.name);

  const runId = db
    .prepare(`INSERT INTO job_runs (job, started_at, dry_run) VALUES (?, ?, ?)`)
    .run(job.name, now.toISOString(), args.dryRun ? 1 : 0).lastInsertRowid;

  let connected = false;
  try {
    connected = await poster.connect();
    await job.run({ cfg, db, poster, llm, dryRun: args.dryRun, target: args.target, now, log: jlog });
    db.prepare(`UPDATE job_runs SET ended_at = datetime('now'), ok = 1 WHERE id = ?`).run(runId);
    jlog.info('job ok', { connected });
  } catch (err) {
    db.prepare(`UPDATE job_runs SET ended_at = datetime('now'), ok = 0, error = ? WHERE id = ?`).run(
      String(err),
      runId,
    );
    jlog.error('job failed', { error: err instanceof Error ? err.stack : String(err) });
    throw err;
  } finally {
    await poster.destroy();
    db.close();
  }
}
