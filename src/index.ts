import { parseArgs, runJob, type Job } from './jobs/_runner.js';
import { aspenUpdateJob } from './jobs/aspenUpdate.js';
import { expeditionBuildJob } from './jobs/expeditionBuild.js';
import { expeditionWatchJob } from './jobs/expeditionWatch.js';
import { flightWatchJob } from './jobs/flightWatch.js';
import { noopJob } from './jobs/noop.js';
import { log } from './logger.js';
import { handleSignals, startServe } from './serve.js';

/** Every job the bot knows. `serve` schedules these by name (see scheduler.ts). */
export const JOBS: Record<string, Job> = {
  [noopJob.name]: noopJob,
  [aspenUpdateJob.name]: aspenUpdateJob,
  [flightWatchJob.name]: flightWatchJob,
  [expeditionBuildJob.name]: expeditionBuildJob,
  [expeditionWatchJob.name]: expeditionWatchJob,
};

async function main() {
  // `serve` is the long-running container mode: cron + gateway + healthz.
  if (process.argv[2] === 'serve') {
    handleSignals(await startServe(JOBS));
    return;
  }
  const args = parseArgs(process.argv);
  const job = JOBS[args.job];
  if (!job) {
    throw new Error(`unknown job "${args.job}" — known jobs: ${Object.keys(JOBS).join(', ')}`);
  }
  await runJob(job, args);
}

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
