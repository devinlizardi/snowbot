# snowbot — project plan (v4)

Discord bot for the 5-man snowboarding group. Two jobs:

1. **Trip ops for Aspen** — Jan 24–30, 2027. Snow, packing, everyone's flights.
2. **The Expedition Builder** — every week, pick somewhere the snow is genuinely going off and hand the group a *complete, bookable, five-person plan* they could say yes to in one message. Not a comparison against Aspen. A finished plan with flights from all five airports, a place that sleeps five, ground transport, a daily mountain plan, a per-person total, and a date by which the price dies.

Guiding rule: **one container, one process, one SQLite file, a handful of cron jobs.** No queues, no n8n, no microservices. Anything that would need a scraper gets replaced by an API or an LLM-with-web-search call.

All money displayed in **USD**, always, regardless of where the trip is.

---

## 0. The roster

| Member | Airports (in preference order) |
|---|---|
| Devin | **JFK**, LGA, EWR |
| Andre | **EWR**, JFK, LGA |
| Elliot | **BUR**, **LAX** — both priced every time |
| Jeremy | **SNA**, **LAX** |
| Hagen | **SFO**, OAK, SJC |

**2 East Coast + 3 California**, so every plan solves a convergence problem. Two strategies, both computed for every build:

- **Consolidate West** — Elliot, Jeremy and Hagen all route through LAX or SFO, so the group buys 2 origins instead of 4. Usually cheaper and much better for long-haul: LAX/SFO have the nonstops to HND, NRT, CTS, YVR, ZRH; BUR and SNA have none.
- **Independent, converge at destination** — everyone books their own, and the bot solves for a shared arrival *window* so nobody eats six hours at the shuttle stop.

Elliot gets BUR **and** LAX priced on every search, and the dossier states the delta out loud — "Elliot: BUR $684 / LAX $511, worth the drive" — so the drive-or-not call is made with the number attached rather than in the group chat at 1am.

In config this is the `price_all: true` flag on a roster entry; it resolves to `member.pricedAirports`, which is what the flight and routing packets consume.

---

## 1. What the bot does

Everything posts to **the one existing channel.** Not flooding it is a hard design constraint, not a nice-to-have — see §2.

### A. Aspen trip ops
- **Monthly** (Oct 1, Nov 1, Dec 1): season outlook for the trip window — seasonal signal, base building, early packing implications.
- **Weekly** (Mondays from mid-Dec): 15-day forecast at base and summit, trailing snowfall, base depth, temps, wind, plus a **model-agreement confidence line** (§3).
- **Daily** (Jan 19–24): day-by-day, powder-day odds, packing checklist keyed to real temps and wind, arrivals table, ground transport (ASE vs DEN vs EGE).
- **Flight watch**: all five flights checked at T-24h and T-3h, reported as **one combined message**, never one per person.

### B. The Expedition Builder
Weekly, the bot picks the single best destination on the board and **builds the whole trip**, then posts one dossier:

> **🇯🇵 NISEKO — Feb 12–20 — $2,340/person — 9 days (7 on snow)**
> *ECMWF and WeatherNext both have 140–180cm falling in the 10 days before you'd land. Models agree — high confidence.*
>
> **Getting there** — Elliot, Jeremy and Hagen consolidate at LAX (Elliot BUR $684 / LAX $511; Jeremy SNA $698 / LAX $524 — both drive). ZIPAIR LAX→NRT $511 r/t. Devin and Andre out of JFK/EWR same day, $698. Everyone lands within 4 hours in Tokyo, one night there, then the 08:40 to CTS together.
> **Where you sleep** — 7 nights, 5-person chalet in Hirafu, $126/pp/night.
> **Ground** — CTS→Hirafu bus $27 pp each way, pre-book.
> **Passes** — IKON covers 5 days at Niseko United, no Feb blackout. Days 6–7 Rusutsu, also IKON.
> **Time off** — 9 days door to door, 6 working days. Japan doesn't repay a shorter trip; below 8 you're paying long-haul money for four days of riding.
> **The plan** — [day-by-day, weather-weighted]
> **The catch** — that ZIPAIR fare has held under $650 for 9 days; it historically moves mid-October. **Decide by Oct 20.**
>
> `/watch niseko-0212` to start daily fare tracking.

The bot **commits to a plan** instead of offering a menu. One destination per week, 4-week cooldown before a repeat unless price or snow moved materially.

**Duration is displayed, never a filter.** Every dossier carries total days, days on snow, working days burned, and a one-line honest note on whether the trip length justifies the flight for that destination. The board carries `min_days` / `ideal_days` per destination and the bot builds to `ideal_days` but says what the floor is.

**No vote threshold, no auto-promotion.** Tracking starts manually with `/watch <id>`. 🏂 reactions are welcome as sentiment but drive nothing.

Once watched: daily fare re-check on that exact itinerary, a ping only on a ±10% move or a new floor, auto-retire when the window passes.

### C. Slash commands
`/join` · `/airports add|remove` · `/flight add|remove|list` · `/trip` (Aspen status on demand) · `/build [destination] [month]` (force a build) · `/watch <id>` / `/unwatch <id>` · `/quiet <days>` (mute non-urgent posts).

Out of scope for v1: booking anything, Airbnb scraping, DMs, a web dashboard.

---

## 2. Posting discipline — the single-channel design

**1. One self-editing anchor message.** The Aspen status lives in a *single pinned message that the bot edits in place* — "❄️ ASPEN · 47 days out · 34" base · next storm Thu (high confidence)". Weekly and daily updates rewrite that message rather than posting a new one.

**2. Threads for everything with a tail.** Each expedition dossier is one root message; all fare-tracking updates for it go in **its thread**. Flight-watch details go in a thread off the Aspen anchor.

**3. New root messages only for news.** A new expedition, a storm swing large enough to change packing, a flight cancellation or a >30min delay, a watched fare hitting a floor. Everything else is an edit or a thread reply. Config carries `max_root_posts_per_day: 2` as a backstop.

**4. Combined flight watch.** Five flights, one message: a table of everyone's status.

**As built (Packet 1):** all four live in `discord/client.ts`. `postRoot()` consults the trailing-24h count in `posts` and refuses once the budget is spent; `{ urgent: true }` exists for cancellations. `editMessage()`, `ensureThread()`, `postThread()` are unbudgeted.

---

## 3. The weather stack

**Euro model from Open-Meteo** — ECMWF IFS HRES (`ecmwf_ifs025`) + AIFS (`ecmwf_aifs025`), 15 days, snowfall + snow depth included.

**WeatherNext 3 via BigQuery** — 64-member ensemble, `_mean/_p10/_p25/_p50/_p75/_p90` per variable. **⚠️ WeatherNext does not predict snowfall.** It carries 2m temperature, dewpoint, wind, cloud, pressure and total precipitation only.

**The resolution: totals from the physics models, confidence from WeatherNext.** Snow numbers quoted to the group come only from models that actually predict snowfall — ECMWF IFS, AIFS, ICON, GFS, NAM. WeatherNext's contribution is its spread on precipitation and temperature, which drives the confidence label. A post reads *"ECMWF 42cm / ICON 35cm / GFS 38cm — and WeatherNext's ensemble is tight across the window, high confidence"*.

`sources/weather/snowfall.ts` derives snowfall from WeatherNext precipitation and stamps every value `derived: true`. That derivation feeds internal scoring and the rain-risk check. **It is deliberately not quoted as a model in a post.**

| Role | Source |
|---|---|
| Euro / physics | Open-Meteo → ECMWF IFS HRES 9 km (+ AIFS) |
| AI / ensemble | WeatherNext 3 via BigQuery — precip + temp spread, **not snowfall** |
| Cross-check | Open-Meteo → ICON-EU, GFS, NAM (`crosscheckFor(region)`) |
| Observed | Open-Meteo Archive trailing 7-day; base depth via Sonnet web search |
| Eyes on it | Windy Webcams API — live resort cam still in weekly posts (optional) |
| Seasonal | Open-Meteo Seasonal (CFS) for the monthly outlook |

**Confidence scoring.** Every forecast carries a label from (a) spread between the snowfall models over the window and (b) WeatherNext's own p10–p90 band. `confidence: high|medium|low` plus a one-line human explanation.

---

## 4. Other data sources

| Need | Source |
|---|---|
| Flight prices | **SerpApi Google Flights API** (`engine=google_flights`) |
| Flight status on trip day | **FlightAware AeroAPI** (`https://aeroapi.flightaware.com/aeroapi/`, header `x-apikey`) |
| Lodging | **SerpApi Google Hotels** (`engine=google_hotels`), filtered to sleeps-5+ |
| Ground transport | per-destination config table, refreshed by Sonnet web search |
| Currency | **Frankfurter** (`https://api.frankfurter.dev/v1/latest?base=USD`) — normalize everything to USD |
| Fuzzy facts — blackout dates, chalet availability, road closures | **Sonnet + Anthropic web search tool** (`web_search_20250305`) |

**Search budget.** ~16 SerpApi searches/week for the builder; `flights.monthly_search_cap` is the hard stop; watched expeditions add ~7/day each.

---

## 5. Architecture

```
snowbot/
  src/
    index.ts              # job registry + entrypoint + cron
    config.ts · db.ts · logger.ts
    discord/
      client.ts           # post/edit/thread helpers, root-post budget      [done]
      anchor.ts           # the self-editing Aspen status message            [P5]
      commands.ts         # /join /airports /flight /trip /build /watch /quiet [P7]
    sources/
      types.ts · _cache.ts                                                  [done]
      weather/ ecmwf.ts weathernext.ts crosscheck.ts archive.ts seasonal.ts snowfall.ts [done]
      weather/consensus.ts  # merge -> SnowReport + confidence               [P4]
      lookup.ts           # Sonnet + web search -> zod-validated JSON        [P6]
      flights.ts · lodging.ts · fx.ts                                       [P10]
      flightStatus.ts                                                       [P8]
    routing.ts            # multi-origin convergence solver                 [P11]
    builder.ts            # assemble a complete Expedition object           [P12]
    jobs/
      _runner.ts · noop.ts                                                  [done]
      aspenUpdate.ts      # monthly/weekly/daily cadence -> edits the anchor [P9]
      flightWatch.ts      # T-24h / T-3h, one combined message              [P8]
      expeditionBuild.ts  # weekly: rank, build, post dossier               [P13]
      expeditionWatch.ts  # daily fare tracking for /watch'd expeditions    [P14]
    llm/ client.ts [done] + prompts/
```

Every job: `fetch → cache in sqlite → compute (pure) → LLM formats → post/edit → log`.

**Runner contract.** `pnpm dev -- job=<name> [--dry-run] [--channel test|real] [--now=<iso>]`. `--channel` defaults to `test`. `--dry-run` works without a Discord token. `--now` injects the clock.

**Source contract.** Every feed implements `Source<P,R>` and is called through `cached(db, source, params)`. Stale-on-failure; `{ offline: true }` guarantees no network.

**SQLite** (schema v1): members, flights, expeditions, near_misses, fare_history, source_cache, posts, llm_usage, kv, job_runs — see `src/db.ts`.

**Destination ranking**, pure function over the board:
`0.45 · forecast_snow_10d_confidence_weighted + 0.20 · observed_snow_7d + 0.20 · (1 − est_cost_pp/ceiling) + 0.15 · logistics_ease`
Hard filters: `total_pp ≤ ceiling`, all five can arrive inside a 6h window, lodging sleeping 5 exists. 4-week repeat cooldown. Snow term is confidence-weighted.

**Ceiling: $2,600 international / $1,400 domestic — provisional.** Everything over the ceiling is written to `near_misses`; `/build` ignores the ceiling.

**Destination board** — 15 entries in `config.yaml`. Every entry has `pass_verify: true`: IKON coverage and blackout dates must come from a live lookup (Packet 6) before appearing in a dossier.

---

## 8. Work packets

1. ✅ Scaffold. 2. ✅ Open-Meteo weather. 3. ✅ weathernext.ts.
4. **`consensus.ts`** — merge to one `SnowReport`. Snow totals only from snowfall models; WeatherNext gives ensemble spread + temp/rain-risk. Per-day per-model values, inter-model agreement metric, p10–p90 band, `confidence`, one-line human explanation. A derived value never appears as a modelled one. A 9 km grid cannot resolve base from summit — apply a lapse-rate correction, or report base only and say so. **Accept:** table-driven agree/disagree cases; explanation reads like a person wrote it; no fixture can make a derived number print as a prediction.
5. **`discord/anchor.ts`** — create-or-edit the pinned Aspen status message, id in `kv`, idempotent across restarts, degrades to a new post if deleted. **Accept:** repeated runs produce exactly one message.
6. **`sources/lookup.ts`** — Sonnet + web search returning JSON validated against a caller-supplied zod schema, 24h cache via `Source`. **Accept:** works for resort base depth, airport→resort ground transport, IKON/blackout status.
7. **`discord/commands.ts`** — all commands + registration script targeting the test guild. **Accept:** handlers tested against in-memory SQLite.
8. **`flightStatus.ts` + `jobs/flightWatch.ts`** — AeroAPI resolve + status; hourly job firing only inside the T-24h / T-3h windows or on change; one combined message for all five. **Accept:** `--now` time-travel tests; five flights produce one message.
9. **`jobs/aspenUpdate.ts` + prompts** — cadence resolver reading `aspen.cadence`, Haiku formatting, packing checklist keyed to forecast, arrivals table; writes through the anchor, posts to root only on material change. **Accept:** snapshot tests across the season via `--now`.
10. **`flights.ts` + `lodging.ts` + `fx.ts`** — SerpApi Flights (round-trip, ±2 days, one search per entry in `member.pricedAirports`), Hotels filtered to sleeps-5, Frankfurter → USD, all behind `Source<P,R>` with the TTL from config. **Accept:** fixtures + `estimateCost(member, destination, window)` returning a USD breakdown.
11. **`routing.ts`** — convergence solver: consolidate-west vs independent, group total, per-person, arrival-window spread, drive/positioning deltas per member. **Accept:** recommends LAX consolidation when BUR/SNA are >$150 worse, reports the per-member delta either way.
12. **`builder.ts`** — assemble a full `Expedition`: routing, lodging, ground, passes/blackouts from Packet 6, weather-weighted day-by-day, days_total / days_on_snow / working days / min-days note, USD per-person total, volatility note, decide-by date. Pure data, no prose. **Accept:** complete valid Expeditions for Niseko and Revelstoke from fixtures.
13. **`jobs/expeditionBuild.ts`** — weekly ranking with cooldown and ceiling, `near_misses` logging, build, Sonnet writes the dossier from the Expedition object only, post as one root message + create its thread. **Accept:** dry-run dossier for the real board.
14. **`jobs/expeditionWatch.ts`** — daily re-check for `/watch`ed expeditions, posting into that expedition's thread; root ping only on ±10% or a new floor; auto-retire past the window. **Accept:** `--now` tests over a simulated fare series; zero root posts on a flat series.
15. **Deploy + verification** — GitHub Actions (typecheck/test/lint on PR; push to main → SSH → compose up) with a fresh deploy keypair, droplet bootstrap script, cron registration in-process, healthz, README runbook.
