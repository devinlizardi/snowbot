# snowbot

Discord bot for a five-person snowboarding group. Two jobs: keep everyone
current on the **Aspen trip (Jan 24–30, 2027)**, and once a week build a
complete, bookable **expedition** somewhere the snow is actually going off.

Design rules, in short: one container, one process, one SQLite file, a handful
of cron jobs. Everything in USD. The bot is allowed roughly one root message a
week — see [PLAN.md §2](#posting-discipline) for why that constraint drives the
architecture.

## Quick start

```bash
corepack enable
pnpm install
cp .env.example .env     # fill in the secrets; .env is gitignored
pnpm dev -- job=noop --dry-run
```

That last command is the health check: it loads `config.yaml`, migrates the
database, connects to Discord if `DISCORD_BOT_TOKEN` is set, and prints what it
found. It never posts.

```
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest, fixtures only — no live network
pnpm lint
pnpm build         # -> dist/
```

## Running a job

```bash
pnpm dev -- job=<name> [--dry-run] [--channel test|real] [--now=2027-01-25T08:00:00Z]
```

- `--dry-run` prints what would be sent instead of sending it, and works
  without a Discord token.
- `--channel` **defaults to `test`**. The live channel has to be asked for by
  name, because it belongs to Elliot and a half-finished forecast landing there
  is the one failure mode that can't be undone. The deployed container sets
  `SNOWBOT_CHANNEL=real` in its environment.
- `--now` injects a clock, so seasonal cadence and fare-watch logic can be
  tested without waiting for January.

## Layout

```
src/
  config.ts          zod-validated config.yaml (+ gitignored config.local.yaml overlay)
  db.ts              SQLite schema and append-only migrations
  logger.ts          JSON lines in production, readable in a terminal
  discord/client.ts  the only thing allowed to talk to Discord; enforces the post budget
  llm/client.ts      Anthropic calls with per-job usage and cost logging
  sources/_cache.ts  fetch-through cache; serves stale data rather than failing a job
  jobs/_runner.ts    CLI parsing, job context, run ledger
config.yaml          roster, Aspen, destination board — public by design
```

## Secrets

Nothing secret belongs in this repo. Identifiers (project ID, channel IDs,
service-account email) are fine and live in `.env.example`; tokens and keys go
in `.env` on the droplet and in GitHub Actions secrets.

The GCP service-account JSON is the one genuinely dangerous file: it lives at
`/opt/snowbot/secrets/gcp.json` on the droplet, mounted read-only into the
container. If it ever leaks, delete the key in the console and issue a new one.

## Status

Phase 1 of 4. Packet 1 (scaffold) is in; weather sources, consensus scoring and
the anchor message are next. Full plan and packet breakdown live in the
project's `PLAN.md`.
