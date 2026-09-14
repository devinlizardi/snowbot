import { parseArgs, runJob, type Job } from './jobs/_runner.js';
import { noopJob } from './jobs/noop.js';
import { log } from './logger.js';

/** Jobs are registered here; cron wiring lands in Packet 15. */
const JOBS: Record<string, Job> = {
  [noopJob.name]: noopJob,
};

async function main() {
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
