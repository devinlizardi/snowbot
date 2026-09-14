# snowbot — brief for packet agents

You are implementing one work packet of `snowbot`, a Discord bot for a five-person
snowboarding group. Read `PLAN.md` (in the repo root — copied from the project) for the
full design; the section numbers below refer to it. Your packet is described in your prompt.

## Ground rules (non-negotiable)

- **Node 22 + TypeScript strict, ESM.** Relative imports MUST end in `.js`
  (`import { x } from '../db.js'`). `noUncheckedIndexedAccess` is on — index access is
  `T | undefined`. `verbatimModuleSyntax` is on — use `import type` for types
  (eslint enforces `consistent-type-imports`).
- **No live network in tests.** Sources implement `Source<P,R>` (`src/sources/types.ts`)
  and are called through `cached(db, source, params, { offline: true })` in tests, or
  their pure `parse*()` functions are tested against fixtures. Fixtures are either
  inline objects in the test or JSON under `test/fixtures/` (create the dir if needed).
  Neither the sandbox nor CI can reach any API — the whole suite must pass offline.
- **Secrets only via `requireSecret('NAME')` / `optionalSecret('NAME')`** from
  `src/config.ts`, read at point of use (never at import time). Never hardcode a key.
  Never write a real key anywhere. Add new env var names to `.env.example` with an
  empty value and a comment.
- **Discord is touched only through `Poster` in `src/discord/client.ts`.** Root posts
  are budgeted; edits and thread posts are not. Respect PLAN.md §2.
- **LLM calls only through `LlmClient` in `src/llm/client.ts`.** Prompts get structured
  source objects and are told to quote numbers, never invent them. If you need tool
  use (web search), extend `LlmClient` minimally and additively.
- **Money is displayed in USD, always.**
- **SQLite schema is v1 in `src/db.ts` and already has every table PLAN.md §5 lists.**
  Do NOT edit migration `001-initial`. If you truly need a schema change, append a new
  migration `002-<packet>` — and say so in your final report. Prefer using `kv` or
  existing tables.
- **Do not edit `src/index.ts`** (job registration is done by the integrator). Export
  your `Job` object from your `src/jobs/<name>.ts` and say its export name in your report.
- **Keep changes to shared files minimal and additive**: `src/config.ts`, `config.yaml`,
  `src/db.ts`, `src/discord/client.ts`, `src/llm/client.ts`, `src/jobs/_runner.ts`.
  Other agents are editing sibling packets concurrently; every line you change in a
  shared file is a merge conflict for someone. If you must add config, add a new
  top-level or nested key with a zod default so existing config.yaml still validates.
- **Tests:** vitest, in `test/<name>.test.ts`. Use `openDb(':memory:')` and
  `loadConfig({ env: {...} })` as `test/discord-budget.test.ts` does. Table-driven where
  the packet calls for it.
- **Code style:** match the existing files — short doc comments explaining *why*, not
  what; prettier defaults (single quotes, 2 spaces, trailing commas, ~100 cols).
  Comments should read like a thoughtful engineer wrote them, not like generated boilerplate.
- **Setup:** run `pnpm install --frozen-lockfile` first (node_modules is not in the
  worktree). Then before finishing: `pnpm typecheck && pnpm test && pnpm lint` — all
  three must be green. Do not weaken tsconfig or eslint.
- **Never install into Devin's clone from a Linux sandbox.** `esbuild` and
  `better-sqlite3` ship platform-specific binaries, and pnpm installs only the current
  platform's, so an install run against a mounted `~/Documents/GitHub/snowbot` leaves
  a `node_modules` that his macOS shell cannot use (`You installed esbuild for another
  platform…`). Work in a copy, or accept that he has to `rm -rf node_modules && pnpm
  install` afterwards.
- **Finish by committing on your branch**: `git add -A && git commit -m "packet N: <title>"`.
  Never commit anything under `secrets/`, `data/`, or `.env`.

## Existing building blocks you should reuse (read them before writing)

- `src/config.ts` — `Config` (with `members[]` incl. `pricedAirports`, `channels`,
  `bigquery`, `board[]` of `Destination`, `aspen` with base/summit `Point`s and
  `cadence`), `loadConfig`, `requireSecret`, `optionalSecret`.
- `src/db.ts` — `openDb`, `kvGet/kvSet/kvDelete`, schema.
- `src/sources/_cache.ts` — `cached()`; `src/sources/types.ts` — `Source<P,R>`, `Fetched<R>`.
- `src/sources/weather/*` — `types.ts` (Coord, DailyWeather, ModelForecast, summarize),
  `ecmwf.ts` (`ecmwfIfs`, `ecmwfAifs`, `modelSource`), `crosscheck.ts`
  (`crosscheckFor(region)`), `archive.ts`, `seasonal.ts`, `weathernext.ts`
  (`WeatherNextForecast` with percentile steps), `snowfall.ts` (`deriveSnowfall` →
  `derived: true`).
- `src/discord/client.ts` — `Poster` (`postRoot`, `editMessage`, `fetchMessage`, `pin`,
  `ensureThread`, `postThread`, `channelId`).
- `src/llm/client.ts` — `LlmClient.complete(prompt, { model: 'fast'|'smart', system, tools })`.
- `src/jobs/_runner.ts` — `Job`, `JobContext` (`cfg, db, poster, llm, dryRun, target,
  now, log`). `now` is injectable — use it, never `new Date()` in job logic.
- `src/logger.ts` — `log`.

## Final report

End with a short report: files added/changed, export names, any shared-file edits, any
new env vars or config keys, test count, and anything the integrator must know
(e.g. "flightWatch expects flights rows with fields …"). Keep it under 300 words.
