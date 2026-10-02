import { optionalSecret } from '../config.js';
import { runSnapshot } from '../snapshot.js';
import type { Job } from './_runner.js';

/**
 * `pnpm dev -- job=snapshot --dry-run` prints what `/snapshot` would reply.
 *
 * Never posts and never scheduled: a snapshot is a reply to someone who asked,
 * not news, so it has no business in the root-post budget. Like the Aspen
 * update, a dry run serves the cache only unless OPEN_METEO_LIVE is set — set
 * it on the droplet to exercise the live sources (and read WeatherNext's
 * `megabytesProcessed` in the log).
 */
export const snapshotJob: Job = {
  name: 'snapshot',
  async run(ctx) {
    const offline = ctx.dryRun && !optionalSecret('OPEN_METEO_LIVE');
    if (offline) ctx.log.warn('dry run without OPEN_METEO_LIVE — serving cache only');
    if (!ctx.dryRun) ctx.log.info('snapshot is reply-only — printing, not posting');
    const result = await runSnapshot(ctx, { offline });
    console.log(`\n${result.text}\n\n(${result.text.length} chars)\n`);
  },
};
