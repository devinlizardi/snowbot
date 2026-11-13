# snowbot

Discord bot for a five-person snowboarding group. Two jobs: keep everyone
current on the **Aspen trip (Jan 24–30, 2027)**, and, when someone asks, say
where the snow is actually going off — with a price only if they want one.
Discovery is on demand since the pull-model change (`PULL-MODEL.md`): the Aspen
anchor and trip-day flight status are the only things that post on their own.

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

`.env` is read by `src/env.ts`, which every entry point imports first; a real
environment variable always wins over the file. In the container the same
variables arrive through compose's `env_file:` instead — that loader keeps
whatever follows the `=`, so comments in `.env` belong on their own line.

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
  name, because it belongs to a friend and a half-finished forecast landing there
  is the one failure mode that can't be undone. The deployed container sets
  `SNOWBOT_CHANNEL=real` in its environment.
- `--now` injects a clock, so seasonal cadence and fare-watch logic can be
  tested without waiting for January.

The jobs:

| job               | what it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `noop`            | boot, validate config, open the db, log in, say what it found                 |
| `aspenUpdate`     | monthly → weekly → daily Aspen briefing, written into the pinned anchor       |
| `flightWatch`     | flight status for all five, one combined message at T-24h and T-3h            |
| `expeditionBuild` | build and post one priced expedition (what 💲 Price it and `/build destination:` run) |
| `expeditionWatch` | daily re-pricing of watched expeditions (backlogged, off the clock)           |
| `snapshot`        | print what `/snapshot` would reply; never posts, never scheduled              |

## On demand: `/snapshot` and `/build`

**`/snapshot`** — every spot, next 7 days, where the models agree and split.
A short written read sits above the table (Haiku, from the composed numbers
only; any number it gets wrong drops it back to the templated callouts), and a
line below names storms the models are starting to agree on in days 8–15,
always as low confidence.

- `spot:` (autocomplete) — one spot day by day: model range, temps, gust,
  freezing level, per-model totals, what fell last week, WeatherNext's band in
  words, and the pass line if the pass lookup has already answered.
- `region:` — `WEST`, `EAST`, `ROCKIES` or `ABROAD`; Aspen stays first.
- `private:true` — only you see it.

**`/build`** — with no arguments, "what's worth watching": up to three spots
ranked on weather alone (no prices, no SerpApi), one per group and never two
under the same storm, each with a suggested window, who could drive and who
flies, and the Ikon Base pass check (blackouts, day limits). If nothing is
going off it says so. Each pick has a **💲 Price it** button that runs the full
builder for that spot and window and posts the dossier with its thread.

- `destination:` `[month:]` — price a spot directly, same as the button.
- `private:true` — only you see the reply (a priced dossier still posts).

The dossier no longer carries a decide-by date, a fare-watch prompt or the
ceiling: it is a price check, not a deadline.

## Serve mode

```bash
pnpm serve            # = pnpm dev -- serve
```

This is what the container runs. It keeps three things up: the in-process
cron scheduler (`src/scheduler.ts`), a gateway connection so slash commands
get answered (`src/discord/commands.ts`), and a `/healthz` endpoint on
`PORT` (8080) reporting uptime and the last `job_runs` row per job. Without a
`DISCORD_BOT_TOKEN` it still serves cron and healthz. SIGTERM shuts it down
cleanly.

Each tick runs a job exactly the way the CLI does, so anything that works with
`pnpm dev -- job=x` works on the clock. Times are **America/New_York**:

| job               | when          | cron         |
| ----------------- | ------------- | ------------ |
| `aspenUpdate`     | daily 07:00   | `0 7 * * *`  |
| `flightWatch`     | hourly at :10 | `10 * * * *` |
| `expeditionBuild` | never (backlogged) | — (`/build` on demand) |
| `expeditionWatch` | never (backlogged) | —            |
| `noop`            | never         | —            |
| `snapshot`        | never         | — (`/snapshot` on demand) |

The weekly build and the fare watch came off the clock in the pull-model change
(`PULL-MODEL.md` P1); their code and tables stay, and `/watch` `/unwatch` are
built but not registered. After deploying that change, retire any live watches
once on the droplet, from `/opt/snowbot` (the container has no sqlite CLI; see
`deploy/README.md`):

```sh
sqlite3 data/snowbot.sqlite \
  "UPDATE expeditions SET status = 'retired' WHERE status = 'watched';"
```

`SNOWBOT_DRY_RUN=1` turns every scheduled tick into a dry run; `SNOWBOT_CHANNEL`
picks the channel exactly as `--channel` does. Slash commands are registered
separately, per guild: `pnpm register-commands [-- --guild real]`.

## Deploying

Push to `main` → `ci.yml` (install, typecheck, test, lint, build) → on green,
`deploy.yml` SSHes to the droplet as `deploy` and runs `git pull --ff-only &&
docker compose build && docker compose up -d`. The SSH key in
`DROPLET_SSH_KEY` is a keypair generated for that workflow and nothing else.

The droplet is set up once with `deploy/bootstrap.sh` (docker, `deploy` user,
ufw with only SSH open, unattended upgrades, clone into `/opt/snowbot`). The
secrets — `.env`, `secrets/gcp.json`, the deploy public key — are placed by
hand. The full runbook, including how to rotate the GCP key, read `job_runs`,
run a job by hand and invite the bot to the real guild, is in
[`deploy/README.md`](deploy/README.md).

## Layout

```
src/
  index.ts           job registry, CLI entrypoint, `serve`
  scheduler.ts       the cron table and in-process scheduling
  serve.ts           scheduler + gateway + healthz, the container's long-running mode
  config.ts          zod-validated config.yaml (+ gitignored config.local.yaml overlay)
  db.ts              SQLite schema and append-only migrations
  logger.ts          JSON lines in production, readable in a terminal
  discord/client.ts  the only thing allowed to talk to Discord; enforces the post budget
  discord/anchor.ts  the self-editing pinned Aspen status message
  discord/commands.ts  /join /airports /flight /trip /snapshot /build /quiet (+ unregistered /watch)
  llm/client.ts      Anthropic calls with per-job usage and cost logging
  sources/_cache.ts  fetch-through cache; serves stale data rather than failing a job
  sources/weather/   ECMWF + WeatherNext + archive + seasonal → one SnowReport
                     (+ conditions.ts: temperature, wind, rain, freezing level)
  snapshot.ts        /snapshot: every spot, next 7 days, where the models agree
  snapshotSpot.ts    /snapshot spot: — one spot, day by day
  scout.ts           /build with no arguments — what's worth watching, no money
  passCheck.ts       a trip window against the pass lookup: blackouts, day limits
  sources/           flights, lodging, fx, flight status, LLM web lookups
  jobs/_runner.ts    CLI parsing, job context, run ledger
  jobs/              one file per job
scripts/             register-commands, record-fixtures, verify-board (laptop only)
deploy/              bootstrap.sh + the runbook
config.yaml          roster, Aspen, the Ikon Base board, exclusions — public by design
```

## Secrets

Nothing secret belongs in this repo. Identifiers (project ID, channel IDs,
service-account email) are fine and live in `.env.example`; tokens and keys go
in `.env` on the droplet and in GitHub Actions secrets.

The GCP service-account JSON is the one genuinely dangerous file: it lives at
`/opt/snowbot/secrets/gcp.json` on the droplet, mounted read-only into the
container. If it ever leaks, delete the key in the console and issue a new one.

## Status

Everything through Packet 15 is built: weather stack, consensus, anchor, slash
commands, flight status, Aspen briefings, pricing, routing, the expedition
builder and watcher, and the deploy path. What's left is Phase 4 —
verification against live services, which needs real keys and a human:

- [ ] Live dry-run of every job from a laptop with a full `.env`:
      `noop`, `aspenUpdate`, `flightWatch --now=<T-24h>`, `expeditionBuild`,
      `expeditionWatch`. Read every message before anything goes non-dry.
- [ ] SerpApi spend check after one `expeditionBuild` — confirm the search
      count matches `flights.monthly_search_cap` math and the cache is hit on
      a second run.
- [ ] Prompt audit: read the Haiku briefing and the Sonnet dossier against the
      source objects. Every number must trace back; nothing invented.
- [ ] Generate a fresh deploy keypair; never the personal `snowbot` key.
- [ ] Run `deploy/bootstrap.sh`, first deploy with `SNOWBOT_DRY_RUN=1`, let it
      tick for a week in the test channel.
- [ ] The guild owner invites the bot to the real guild (scopes and permissions in
      `deploy/README.md`), then `pnpm register-commands -- --guild real`.
- [ ] Flip `SNOWBOT_CHANNEL=real`, `SNOWBOT_DRY_RUN=0`.

Full plan and packet breakdown live in the project's `PLAN.md`.
