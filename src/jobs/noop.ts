import type { Job } from './_runner.js';

/** Packet 1's acceptance test: boots, reads config, opens the database,
 *  connects to Discord if a token is present, and says what it found. */
export const noopJob: Job = {
  name: 'noop',
  async run({ cfg, db, poster, llm, target, dryRun, now, log }) {
    const schema = db.pragma('user_version', { simple: true }) as number;
    const members = cfg.members.map((m) => `${m.name} (${m.pricedAirports.join('/')})`).join(', ');

    log.info('config ok', {
      roster: cfg.members.length,
      board: cfg.board.length,
      aspen: `${cfg.aspen.window_start} → ${cfg.aspen.window_end}`,
      schemaVersion: schema,
      weathernext: cfg.weather.weathernext_provider,
      dataset: cfg.bigquery.datasetId ?? '(GCP_DATASET_ID unset)',
      channel: `${target}:${poster.channelId ?? '(unset)'}`,
      rootPostsUsedToday: poster.rootPostsToday(),
      llmSpentThisMonthUsd: Number(llm.spentThisMonthUsd().toFixed(4)),
    });

    console.log(
      [
        '',
        `  snowbot ok — ${now.toISOString()}`,
        `  roster: ${members}`,
        `  board:  ${cfg.board.length} destinations`,
        `  aspen:  ${cfg.aspen.name}, ${cfg.aspen.window_start} → ${cfg.aspen.window_end}`,
        `  db:     schema v${schema}`,
        `  post:   ${target} channel, ${dryRun ? 'dry run' : 'LIVE'}`,
        '',
      ].join('\n'),
    );
  },
};
