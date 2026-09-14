# snowbot runbook

One droplet, one container, one SQLite file. Everything below assumes you are
`deploy@<droplet>` in `/opt/snowbot` unless it says otherwise.

## The cron table

Registered in-process by `src/scheduler.ts` when the container runs `serve`
(the default command). All times are **America/New_York**, whatever the
droplet's clock says.

| job               | when              | cron          | what it does                                             |
| ----------------- | ----------------- | ------------- | -------------------------------------------------------- |
| `aspenUpdate`     | daily 07:00       | `0 7 * * *`   | refresh the pinned Aspen anchor (cadence decides how much) |
| `flightWatch`     | hourly at :10     | `10 * * * *`  | flight status; only posts inside the T-24h / T-3h windows |
| `expeditionBuild` | Mondays 08:00     | `0 8 * * 1`   | rank the board, build one expedition, post the dossier   |
| `expeditionWatch` | daily 09:00       | `0 9 * * *`   | re-price `/watch`ed expeditions into their threads       |
| `noop`            | never             | —             | manual health check                                      |

`SNOWBOT_DRY_RUN=1` in `.env` makes every scheduled tick a dry run — useful for
the first week on the droplet. `SNOWBOT_CHANNEL` defaults to `test`; the real
channel has to be asked for by name.

## First deploy

1. **Create the droplet.** Ubuntu 24.04, the smallest size is plenty (the image
   is ~250 MB and SQLite fits in RAM). Add your personal SSH key at creation.
2. **Bootstrap as root** — installs docker, creates `deploy`, locks down ufw,
   turns on unattended security upgrades, clones the repo:
   ```bash
   ssh root@<droplet>
   curl -fsSL https://raw.githubusercontent.com/<owner>/snowbot/main/deploy/bootstrap.sh \
     | SNOWBOT_REPO=https://github.com/<owner>/snowbot.git bash
   ```
   It is idempotent; re-run it if something fails halfway. It ends by printing
   the manual steps, repeated here.
3. **Deploy keypair — fresh, not your personal one.** The `deploy` user is
   created with an empty `authorized_keys`, so this has to happen before
   anything is copied as `deploy@`.
   ```bash
   ssh-keygen -t ed25519 -C snowbot-deploy -f snowbot-deploy -N ''
   ssh root@<droplet> 'cat >> /home/deploy/.ssh/authorized_keys' < snowbot-deploy.pub
   ```
   Then in GitHub → Settings → Secrets and variables → Actions:
   `DROPLET_IP` = the IP, `DROPLET_USER` = `deploy`, `DROPLET_SSH_KEY` =
   the contents of `snowbot-deploy` (private half). The personal `snowbot`
   key is gitignored and must never be pasted into a secret.
4. **Secrets, by hand.** From your laptop, as `deploy` with the new key (or
   as root, then `chown -R deploy:deploy /opt/snowbot/.env /opt/snowbot/secrets`):
   ```bash
   scp -i snowbot-deploy .env deploy@<droplet>:/opt/snowbot/.env
   scp -i snowbot-deploy gcp.json deploy@<droplet>:/opt/snowbot/secrets/gcp.json
   ssh -i snowbot-deploy deploy@<droplet> 'chmod 0600 /opt/snowbot/.env && chmod 0400 /opt/snowbot/secrets/gcp.json'
   ```
   Leave `SNOWBOT_CHANNEL=test` for now.
5. **First run.**
   ```bash
   ssh deploy@<droplet>
   cd /opt/snowbot
   docker compose build
   docker compose run --rm snowbot job=noop --dry-run   # config + db + Discord login
   docker compose up -d
   curl -s localhost:8080/healthz | jq
   ```
   From here on, a push to `main` that passes CI rolls the container
   automatically (`.github/workflows/deploy.yml`).

## Everyday

**Logs.** Structured JSON lines, one per event:

```bash
docker compose logs -f --since 1h snowbot
docker compose logs snowbot | grep '"job":"aspenUpdate"' | tail -20
```

**Health.** `curl -s localhost:8080/healthz` returns `ok`, `uptime` (seconds),
which jobs are scheduled, whether the gateway is connected, and the latest
`job_runs` row per job. Docker's `HEALTHCHECK` hits the same endpoint; a
container stuck unhealthy shows up in `docker compose ps`.

**Run a job by hand.** Same CLI as on a laptop, in a one-off container that
shares the volume with the running one (SQLite WAL makes this safe):

```bash
docker compose run --rm snowbot job=aspenUpdate --dry-run
docker compose run --rm snowbot job=expeditionBuild --dry-run --now=2027-01-10T13:00:00Z
docker compose run --rm snowbot job=flightWatch --channel real     # the real thing
```

**Check `job_runs`.** The container has no sqlite CLI, so read the file on the
host:

```bash
sudo apt-get install -y sqlite3   # once
sqlite3 data/snowbot.sqlite \
  "SELECT id, job, started_at, ended_at, ok, dry_run, substr(error,1,80) FROM job_runs ORDER BY id DESC LIMIT 20;"
```

Related tables worth a look when something is off: `posts` (root-post budget),
`llm_usage` (spend), `source_cache` (staleness), `kv` (anchor ids, watches).

**Slash commands.** Registered per guild (instant) from a laptop that has
`.env` — `scripts/` is not shipped in the image on purpose:

```bash
pnpm register-commands                 # test guild
pnpm register-commands -- --guild real
```

Re-running replaces the whole set for that guild. The running container only
needs to be restarted if the command *handlers* changed, which a deploy does.

**Restart / stop.** `docker compose restart snowbot`; `docker compose down`
stops it and keeps `data/`. SIGTERM is handled: in-flight cron ticks finish,
the gateway disconnects cleanly, the DB is closed.

## Rotating the GCP key

The service-account JSON is the only file here that can run up a bill in
someone else's project. Rotate it on any suspicion and at least yearly.

1. Google Cloud console → IAM → Service Accounts → the snowbot account → Keys
   → **Add key** (JSON). Download it.
2. `scp new.json deploy@<droplet>:/opt/snowbot/secrets/gcp.json` (overwrites;
   the mount is read-only inside the container but the host file is yours).
3. `docker compose restart snowbot` — the key is read at point of use, so this
   is enough.
4. `docker compose run --rm snowbot job=aspenUpdate --dry-run` and confirm a
   WeatherNext row came back rather than a cache hit.
5. Back in the console, **delete the old key**. Not disable — delete.
6. Shred the local download: `shred -u new.json`.

If the key ever leaks, do step 5 first and the rest after.

## Inviting the bot to the real guild

Elliot owns the guild (`DISCORD_GUILD_ID` in `.env.example`); only he can
invite. Build the URL in Developer Portal → OAuth2 → URL Generator, or use
this shape with the app id from `DISCORD_APP_ID`:

```
https://discord.com/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot%20applications.commands&permissions=309237738560
```

Scopes: `bot applications.commands`. Permissions (integer `309237738560`):

- View Channel (implicit, or nothing else works)
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Embed Links
- Add Reactions
- Read Message History
- Manage Messages (only for pinning the Aspen anchor)

No Administrator, no Mention Everyone, no Manage Threads. After Elliot accepts:
`pnpm register-commands -- --guild real`, then run one job with
`--channel real --dry-run` to confirm the channel resolves, then flip
`SNOWBOT_CHANNEL=real` in `.env` and `docker compose up -d`.

## When it's on fire

- **Gateway keeps reconnecting** — token was regenerated in the Developer
  Portal; update `.env`, `docker compose up -d`.
- **`job_runs.ok = 0` for every job** — usually `config.yaml` no longer
  validates after a merge; `docker compose run --rm snowbot job=noop --dry-run`
  prints the zod issues.
- **Root post refused** — the daily budget (`discord.max_root_posts_per_day`)
  is spent; see `posts`. It resets at midnight New York. Don't raise it.
- **LLM cap hit** — `llm_usage` sums past `llm.monthly_usd_cap`; jobs degrade
  to skipping prose. Check for a job looping before raising the cap.
- **Disk** — `data/` holds the SQLite file plus WAL; `docker system prune`
  clears old images left by deploys (the workflow prunes dangling ones).
