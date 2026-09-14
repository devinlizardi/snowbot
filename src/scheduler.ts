import cron from 'node-cron';
import type { Job } from './jobs/_runner.js';
import { runJob } from './jobs/_runner.js';
import type { Logger } from './logger.js';

/*
 * In-process cron. One container, one process: the schedule lives here in
 * code rather than in crontab so it ships with the image, shows up in git
 * history, and can be asserted by a test. Every tick is a normal `runJob`
 * invocation — the same code path `pnpm dev -- job=<name>` takes — so a job
 * that works by hand works on the clock, and each run lands in `job_runs`.
 */

/** All times are wall-clock in the group's timezone, not the container's UTC. */
export const TIMEZONE = 'America/New_York';

/**
 * Job name → 5-field cron expression, or `null` for "never on the clock".
 * Keep the README's cron table in sync when this changes.
 */
export const SCHEDULE: Readonly<Record<string, string | null>> = {
  aspenUpdate: '0 7 * * *', // daily 07:00 — before anyone checks Discord over coffee
  flightWatch: '10 * * * *', // hourly at :10; the job itself decides if a window is open
  expeditionBuild: '0 8 * * 1', // Mondays 08:00 — one root post a week, per PLAN §2
  expeditionWatch: '0 9 * * *', // daily 09:00, after the build has had its say
  noop: null, // manual health check only
};

export type ScheduledHandle = {
  stop(): void | Promise<void>;
};

/** Minimal shape of `cron.schedule`, so tests can inject a fake. */
export type ScheduleFn = (
  expression: string,
  fn: () => Promise<void>,
  opts: { timezone: string; name: string; noOverlap: boolean },
) => ScheduledHandle;

export type SchedulerOptions = {
  env: NodeJS.ProcessEnv;
  log: Logger;
  schedule?: ScheduleFn;
  run?: typeof runJob;
};

export type Scheduler = {
  /** Names actually put on the clock, in SCHEDULE order. */
  scheduled: string[];
  stop(): Promise<void>;
};

/**
 * Put every job that is both in `SCHEDULE` and in `jobs` on the clock. Jobs
 * the integrator hasn't registered yet are logged and skipped, so packets can
 * land one at a time without this file changing.
 */
export function startScheduler(jobs: Record<string, Job>, opts: SchedulerOptions): Scheduler {
  const schedule: ScheduleFn = opts.schedule ?? cron.schedule;
  const run = opts.run ?? runJob;
  const { env, log } = opts;

  const dryRun = env.SNOWBOT_DRY_RUN === '1';
  const target = env.SNOWBOT_CHANNEL === 'real' ? 'real' : 'test';

  const handles: ScheduledHandle[] = [];
  const scheduled: string[] = [];

  for (const [name, expression] of Object.entries(SCHEDULE)) {
    if (expression === null) continue;
    const job = jobs[name];
    if (!job) {
      log.warn('job in SCHEDULE but not registered — skipping', { job: name, cron: expression });
      continue;
    }
    if (!cron.validate(expression)) {
      // A typo here should be loud, not a job that silently never fires.
      throw new Error(`invalid cron expression for ${name}: "${expression}"`);
    }

    const tick = async () => {
      log.info('cron tick', { job: name });
      try {
        await run(job, { job: name, dryRun, target });
      } catch (err) {
        // runJob already wrote the failure to job_runs and logged the stack;
        // the only thing left to do is not let it take the process down.
        log.error('cron run failed', {
          job: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    handles.push(schedule(expression, tick, { timezone: TIMEZONE, name, noOverlap: true }));
    scheduled.push(name);
    log.info('scheduled', { job: name, cron: expression, tz: TIMEZONE, dryRun, channel: target });
  }

  return {
    scheduled,
    async stop() {
      await Promise.all(handles.map((h) => h.stop()));
    },
  };
}
