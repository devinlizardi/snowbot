# snowbot — the pull model

_Oct 12, 2026. Supersedes the weekly-cadence parts of `PLAN.md` §1B and §2.
Written from Devin's feedback after the first live pitches. Hand this to a
Claude Code session; it's ordered to ship in packets._

_Nov 12 note: the `BACKLOG.md` prerequisites (items 1, 2, 3–5, 6, 7–11) all
shipped in PR #1 on Oct 4._

---

## Why this exists

The weekly Expedition Builder missed. The pitches that prompted this:

- **Whistler Blackcomb, Dec 2–8, ~$728/pp.** No responses.
- **Revelstoke, Dec 2–8, ~$1,600/pp.** Four days on snow, plus a 2.5h winter
  drive. The group went to Revelstoke last season, so it was never an option.
- **Both posts used the same quote** — John Muir, "The mountains are calling…".
  That's a bug (see P4).
- Two near-identical pitches back to back: same country, same dates.

The deeper problem isn't any one pitch. A committed, priced plan with a
decide-by date asks for more decisiveness than the group has. In November
people are locking in the holidays, not buying a trip because a bot said so.

What the group actually wants from the bot is the thing it's uniquely able to
do: **watch the weather data nobody in the group is watching, and tell them
what's happening.** Money comes later, and only when someone asks.

## The new shape

**Nothing discovery-related posts on its own anymore.** The bot becomes two
tools you go to, plus the Aspen updates.

| What | How it runs | Status |
|---|---|---|
| `/snapshot` — the weather report | on demand | upgraded (P5) |
| `/build` — what's worth watching, then opt-in pricing | on demand | reworked (P6) |
| Aspen anchor (`aspenUpdate`) | scheduled, unchanged | stays — the one automatic thing the group cares about |
| `flightWatch` (trip day) | scheduled, unchanged | stays |
| Weekly `expeditionBuild` | — | **unscheduled, backlogged** (P1) |
| `expeditionWatch` + `/watch` `/unwatch` | — | **unscheduled, backlogged** (P1) |

Backlogged means the code, tables and tests stay; the jobs leave the
scheduler and the commands leave the registered set. `pnpm dev --
job=expeditionBuild` still works for anyone who wants it.

This also does more for the muting risk (PLAN §10) than the root-post budget
ever could: the only unprompted posts left are the Aspen anchor and trip-day
flight status.

---

## The board, rebuilt around the Ikon Base Pass

**Rule from Devin:** if the Ikon Base Pass gets you on the mountain, the bot
should know about it. Lean domestic and reachable for everyone; keep a few
international spots as aspirational outliers, not the default.

### Verified Oct 12, 2026 against ikonpass.com/en/compare-passes

This is what the current board actually gets on the **Base Pass**. It changed
the picture a lot — more than half the old board isn't on it.

| Current board entry | Base Pass | Decision |
|---|---|---|
| Niseko | 5 days | keep (aspirational) |
| Rusutsu | not listed | drop |
| Hakuba | not listed | drop |
| Nozawa | not listed | drop |
| Whistler | not Ikon (Epic) | drop |
| Revelstoke | 5 days | **drop — group went last season** |
| Banff/Lake Louise | 5 days (SkiBig3: Sunshine, Lake Louise, Norquay, shared) | keep (aspirational) |
| Fernie | not listed | drop |
| Jackson Hole | **full Ikon only** (7 days), not Base | drop |
| Big Sky | 5 days, tram not included | keep |
| Alta/Snowbird | **Snowbird only**, 5 days; Alta is full Ikon only | keep as **Snowbird** |
| Palisades Tahoe | unlimited | keep |
| Chamonix | 5 days | keep (aspirational) |
| Zermatt | 5 days, Nov 1–Apr 30 | keep (aspirational) |
| St. Anton | not listed | drop |

**Base Pass blackouts (Northern Hemisphere): Dec 26–30, 2026 · Jan 16–17,
2027 · Feb 13–14, 2027.** The first is holiday week and the last is
Presidents' Day weekend — exactly when this group is likely to go.

Unlimited on Base, among spots relevant here: Big Bear, Snow Valley, Mammoth,
June, Palisades, Stratton, Sugarbush, Copper, Winter Park, Arapahoe Basin,
Eldora, Solitude, Snowshoe, Tremblant. Five days on Base: Killington-Pico
(shared), Steamboat, Big Sky, Snowbird, Loon, Sugarloaf, Sunday River, Taos,
Crystal, and Snowmass (Snowmass-only on Base for 26/27).

### Proposed board v3 — 15 entries, same count as today

Keeping it at 15 keeps `/snapshot` inside Discord's 2,000-character limit
without re-tuning the layout. Display groups are new (see P2).

| Group | Entry | Base access | Who it's easy for |
|---|---|---|---|
| **WEST** | Big Bear | unlimited | Elliot, Jeremy drive |
| | Mammoth (covers June) | unlimited | CA drives; East flies |
| | Palisades Tahoe | unlimited | Hagen drives; East flies |
| **EAST** | Killington-Pico | 5 days shared | Devin, Andre drive |
| | Stratton | unlimited | Devin, Andre drive |
| | Sugarbush | unlimited | Devin, Andre drive |
| **ROCKIES** | Winter Park | unlimited | everyone flies DEN |
| | Steamboat | 5 days | everyone flies |
| | Solitude | unlimited | everyone flies SLC |
| | Snowbird | 5 days, Snowbird only | everyone flies SLC |
| | Big Sky | 5 days, no tram | everyone flies |
| **ABROAD** | Niseko | 5 days | aspirational |
| | Banff/SkiBig3 | 5 days | aspirational |
| | Chamonix | 5 days | aspirational |
| | Zermatt | 5 days, Nov 1–Apr 30 | aspirational |

Aspen (Snowmass) stays first in every view, as now.

Two things the session must **not** take from this table:

- **Coordinates and elevations.** None are given here on purpose. Every new
  entry needs a verified lift-base point and base/summit elevation, the same
  standard as Packet 2. Use `scripts/verify-board.ts`; Devin runs it from his
  shell since the sandboxes can't reach the APIs.
- **Pass facts in config.** The "Base access" column is why an entry is on the
  board, not data the bot quotes. `pass_verify: true` stays on every entry, and
  anything about days or blackouts shown to the group still comes from the
  live lookup (P3). That rule (PLAN §9) doesn't change.

The "who it's easy for" column is a design note, not config. Drive vs fly per
member should come from each entry's `ground` data and the routing solver,
not be hardcoded.

---

## Packets

Every packet: `pnpm typecheck && pnpm test && pnpm lint` green, fixtures only
in CI, append-only migrations.

### P1. Stop the push ← ship first, on its own

The bot is live on the real server, so this one is worth deploying the same
day.

- Remove `expeditionBuild` and `expeditionWatch` from the scheduler. Leave both
  in `JOBS`.
- Remove `/watch` and `/unwatch` from the registered command set. Keep their
  handlers and tests in the tree, unregistered.
- Retire every `watched` expedition (`status = 'retired'`), via a one-off SQL
  step in the runbook, not a migration.
- Leave `aspenUpdate` and `flightWatch` scheduled exactly as they are.
- **Accept:** a test asserting the scheduler holds exactly `aspenUpdate` and
  `flightWatch`; registered commands no longer include `watch`/`unwatch`;
  `pnpm register-commands -- --guild real` after deploy.

### Prerequisites from `BACKLOG.md`

Shipped in PR #1 (Oct 4): 10, 9, 11 (WeatherNext run time), 7, 8 (Open-Meteo
429s), 1, 2 (root id, channel target), 3, 4, 5 (watch pings), 6 (bytes).
Still to do on the droplet: re-run snapshot gate 1 to get the real per-query
BigQuery cost.

### P2. Board v3

**Where:** `config.yaml`, `src/config.ts`, `src/snapshot.ts`, anything that
switches on region.

- Replace the board with the 15 entries above. Seed `min_days`/`ideal_days`
  sensibly for drive-up trips (e.g. WEST and EAST 2/3, ROCKIES 3/5) and leave
  ABROAD as it is.
- **Split display group from model region.** Today one `region` field (JP / CA
  / US / EU) both groups the table and picks the cross-check models in
  `crosscheckFor`. The new groups (WEST / EAST / ROCKIES / ABROAD) are about the
  people, not the models — Niseko and Chamonix share a group but need different
  cross-check models. Add `group` for display; keep model selection keyed off
  geography.
- **Exclusions with reasons.** Add a config list, e.g.
  `excluded: [{ id: revelstoke, reason: "group went 25/26" }]`, validated so an
  excluded id can't also be on the board. Ranking and `/build` never surface an
  excluded spot. This records *why* it's gone for future-you.
- Add `group.pass: ikon_base` at the top level of config (see open question 1).
- Drop the per-entry `pitch` blocks for removed spots; keep the rest.
- **Accept:** config validates; the snapshot worst-case test still passes with
  the new names (≤2,000 chars, every code-block line ≤36 columns); an excluded
  id on the board fails validation; cross-check selection is unchanged for
  Niseko and Chamonix.

### P3. Pass lookup v2 — access, day limits, blackouts

**Where:** `src/sources/lookup.ts` (the `pass` schema), a new pure helper.

Today the lookup answers "is it on the pass". It needs to answer the questions
that actually decide a trip:

- Zod schema: `{ onPass, daysLimit: number | 'unlimited', blackouts: [{start,
  end}], notes }` — notes carry things like "Snowbird only", "no tram",
  "Nov 1–Apr 30".
- Point the lookup prompt at ikonpass.com's compare page as the primary
  source; cache 7 days (this changes seasonally, not daily).
- Pure helper `passCheck(entry, window, passInfo)` returning: blackout overlap
  (which dates), whether trip days exceed the day limit, and a one-line
  plain-English summary.
- **Accept:** fixture of the compare page parses; table-driven tests — a Dec
  28–Jan 2 window flags Dec 28–30; a 6-day window at a 5-day spot flags the
  limit; an unlimited spot outside blackouts is clean.

### P4. Fix the duplicate quote

**Where:** wherever the pitch quote is picked (`pitch.quote`, else
`expedition.quote_pool`, "picked stably by expedition id" per `STATUS.md`).

**Likely cause:** Whistler and Revelstoke have no `pitch.quote`, so both fell
back to a two-entry pool (Muir, Warren Miller). A stable pick over two items
collides half the time, and nothing checks what was used recently. Confirm
against the `posts` table before fixing.

- The picker skips any quote used in the last N posts (track in `kv`, e.g.
  `quote:recent`).
- If nothing fresh is left, **omit the quote**. No quote beats a repeat.
- New board entries get no quote until Devin adds a sourced one. **The
  session must not write quotes**; the STATUS rule stands: real, attributed,
  verified, model never writes them.
- **Accept:** two builds in a row never share a quote; an exhausted pool
  produces no quote line.

### P5. `/snapshot` v2 — the weather report

Keep everything that works: the table, ranges across models, agreement marks,
the honesty audit. Add the synthesis the group can't get from an app.

1. **The read.** Two to four sentences above the table: where it's snowing,
   where models disagree, and what's building in days 8–15. Written by Haiku
   from the composed `Snapshot` object only, run through
   `assertSnapshotHonest`. If the audit rejects it, fall back to today's
   templated callouts. (This reverses SNAPSHOT decision 4, deliberately, behind
   the same number audit.)
2. **Look-ahead.** One line for days 8–15 — storms the models are starting to
   agree on, always labelled as low confidence. The data is already fetched
   (`forecast_days: 15`).
3. **`spot:` option** (autocomplete from the board). A single-spot drill-down:
   daily rows for the next 7 days, per-model snow, the observed last 7 days from
   `archive.ts`, freezing level vs summit, WeatherNext's band described in
   words, and the Base Pass line from P3's cache if present.
4. **`region:` option** — WEST / EAST / ROCKIES / ABROAD — filters the table.

Budget: the read plus the table must stay ≤2,000 chars. If it's over, drop
callouts first, then trim the read to one sentence. Keep `private:true`.

- **Accept:** worst-case length test including the read; a fixture whose LLM
  read invents a number is rejected and falls back; the derived-77cm fixture
  still never prints; `spot:` renders for every board entry from fixtures.

### P6. `/build` v3 — what's worth watching, then opt-in pricing

`/build` with no arguments stops meaning "price me a trip". It means "show me
what's happening".

**Default view (no args, no money):**

- Up to **three picks**, ranked by a weather-first score: forecast 7d
  (confidence-weighted), the days 8–15 signal, observed 7d, and how the coming
  weeks usually go there historically. **No cost term, no SerpApi calls.**
  Starting weights in config, validated to sum to 1; treat them as tunable.
- **Diversity:** at most one pick per display group, and never two picks
  sitting under the same storm. That's the Whistler + Revelstoke case.
- Each pick: the weather story in a line or two, a suggested window (when the
  snow lands plus a few days), who drives and who flies, and the `passCheck`
  line, including blackout overlap and day limits.
- **Honest empty state.** If nothing clears the bar, say so: "Nothing's going
  off yet — the earliest real signal is X." In October and November this will
  be the common answer, and it's the right one.
- A **💲 Price it** button under each pick. Encode spot and window in the
  button's `custom_id` so it survives restarts without state. Defer the
  interaction, same as slash commands.

**Priced view (opt-in only):** the button, or `/build destination:<id>
[month]`, runs today's builder for that spot and window — flights from all five
airports, Elliot and Jeremy at both airports, lodging shortlist, per-person
USD. Changes to the dossier:

- **Remove "decide by" and the urgency framing.** Show fare context only as a
  plain fact, if `fare_history` actually has data.
- Keep the ceiling out of it; it's informational now.
- Posts a root + thread as today.

- `private` option on both paths.
- **Accept:** scout view from fixtures makes zero SerpApi calls; two spots
  under one storm never both appear; a window touching Dec 26–30 shows the
  blackout; the empty state renders; pressing Price it on a fixture produces a
  dossier with no "decide by".

### P7. Docs and registration

- `README.md` runbook: new `/snapshot` options, `/build` behaviour, the button,
  and the retired-watch SQL.
- Update `PLAN.md` §1B and §2 to point here; mark the weekly cadence as
  backlogged.
- Fix the stale real channel id in `PHASE-0.md` and `.env.example` (BACKLOG
  ops item).
- `pnpm register-commands` (test), then `-- --guild real`.

**Order:** P1 → P2 → {P3 ∥ P4} → P5 → P6 → P7.

---

## Backlogged, not deleted

- Weekly auto-build. Could return later as "post only when something is
  genuinely exceptional", gated on the P6 score crossing a high bar.
- `/watch` and daily fare tracking.
- `near_misses` — nothing writes to it without a ceiling in the loop. Leave
  the table.

## Open questions for Devin

1. **Does all five hold the Ikon Base Pass?** The board and `passCheck` assume
   `group.pass: ikon_base`. If someone has full Ikon, Jackson Hole and Alta come
   back into play; if someone has no pass, the priced view needs lift tickets.
2. **Quotes for new spots.** Big Bear, Mammoth, the Vermont three and the
   Rockies entries start with none. Add sourced ones if you want them.
3. **Is 15 the right size?** Snow Valley, Copper, A-Basin, Loon, Sugarloaf and
   Sunday River are all Base Pass too. Adding any means re-checking the
   snapshot's 2,000-character budget.
4. **Japan.** Hakuba and Nozawa are off, but Shiga Kogen, Myoko Suginohara,
   Madarao and Arai are Base Pass spots in that same part of Japan, if a second
   Japanese option is wanted later.
