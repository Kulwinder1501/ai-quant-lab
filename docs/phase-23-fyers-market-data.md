# Phase 23: Fyers historical backfill for scalp training data

Status: **plan only**. No code in this phase has been written yet. This document is the
design and the decision record; implementation follows in a separate change.

## Scope

Fyers is used for **one thing**: offline bulk download of intraday history into `candles`,
so the scalp models have a training set. It is a manual, operator-run backfill.

Everything else stays on Yahoo — the 15-minute intraday scheduler job, the EOD pipeline,
the UI quotes in `app.ts`, and all daily bars. Yahoo is adequate there and needs no
credentials, which is the property that makes the unattended scheduler work.

Explicitly **out of scope**: any scheduler change, any live-quote provider, any broker
order routing, and the futures/volume work described under "The volume caveat".

This narrow scope is what makes the phase cheap. The 15-day Fyers token expiry stops
being an operational risk when nothing unattended depends on it, and the train/serve
skew problem disappears if — and only if — the provider split follows timeframe
boundaries rather than dates. See "Provenance is partitioned by timeframe".

## Theory and purpose

Phase 3 made historical collection provider-agnostic and shipped three adapters: CSV,
Kite Connect v3, and Yahoo. Yahoo became the default because it is the only one needing
no credentials. That convenience is now the binding constraint on the scalping work.

Yahoo cannot supply the data the `1m`/`3m`/`5m` strategies are written against, and the
gap is not a matter of degree.

**Intraday lookback is days, not years.** Yahoo serves roughly 7 days of `1m` and 60 days
of `5m`/`15m`. `apps/ml/ai_quant_lab_ml/contracts.py` declares
`SCALP_TIMEFRAMES = ("1m", "3m", "5m")`, but no schedule can accumulate a training set
from a source with a 7-day window unless the daily capture never misses.

**Two of the eight supported timeframes are silently fabricated.** The Yahoo adapter
downsamples the intervals Yahoo does not carry:

```10:21:apps/api/src/infrastructure/market-data/yahoo-historical-data-provider.ts
function getYahooInterval(timeframe: string): "1m" | "2m" | "5m" | ... {
  switch (timeframe) {
    case "1m": return "1m";
    case "3m": return "1m"; // Yahoo doesn't support 3m natively
    case "5m": return "5m";
    case "10m": return "5m";
```

A `3m` request returns 1-minute bars stamped with a 3-minute `close_time`; `10m` returns
5-minute bars. Both pass every `CHECK` on `candles` and every assertion in
`validateCandle`, because nothing in the system can distinguish a 1-minute bar from a
3-minute bar by inspection. `ml-feature-scalp-v2` trains on `3m`, so this is live.

Note the distinction from honest resampling: aggregating real 1-minute bars into a
3-minute bar is exact and defensible. Relabelling a 1-minute bar as a 3-minute bar is
not. Yahoo does the second.

**Index intraday volume is zero.** `^NSEI` returns no intraday volume and the adapter
stores `"0"`. Any volume or VWAP feature on index intraday bars is computed on a
constant, and the Phase 22 momentum-scalp rule requires VWAP. This one is not a provider
problem — see below.

## Provider selection

Compared for this use case only: a one-off bulk download of `1m`/`3m`/`5m` history.
Live streaming, order throughput, and WebSocket depth are irrelevant here and were not
weighed.

| | Cost | 1m history from | Per request | Native 3m |
|---|---|---|---|---|
| **Fyers v3** | Free | 2017-07-03 | 100 days | Yes |
| Upstox v3 | Free | Jan 2022 | 1 month | Yes, any 1–300 min |
| Dhan v2 | ₹499/mo | ~5 years | 90 days | No — 1, 5, 15, 25, 60 only |
| Groww | ₹499/mo | ~3 months | 30 days | Yes |

**Chosen: Fyers.** Free, deepest 1-minute history, and the largest per-request window,
which directly sets how long the backfill runs and how hard it hits rate limits.

Rejected, with reasons worth keeping:

- **Groww** retains roughly 3 months of intraday history on its historical API — barely
  better than Yahoo, which is the entire problem being solved. Its newer backtesting
  endpoint advertises data from 2020, but the two documentation pages contradict each
  other and it is paid, so verifying costs money.
- **Dhan** puts historical data behind the ₹499/month Data API subscription while the
  trading APIs are free. Shallower history than Fyers, for money. Its missing 3m is not
  itself disqualifying, since real 1m bars can be resampled honestly.
- **Upstox** is the credible free alternative and the designated fallback. It loses on
  1m depth (2022) and on a 1-month request window that needs roughly four times the
  calls for less than half the history. Its arbitrary 1–300 minute intervals and
  open interest on every interval are genuinely the nicest API of the four.

Two honest qualifications on choosing Fyers:

- The 2017 depth is worth less than it looks. Minute-level structure from 2017–2019
  predates weekly expiry and lot-size changes that shape current intraday behaviour, so
  training will likely use 2–3 years regardless. Against Upstox the real edge is the
  request window, not the start date.
- The actual cost of Fyers is opening a Fyers account, since API access requires one.

**Check first:** a Kite adapter already exists in the tree. If a Kite historical-data
subscription is already active, `--provider kite` does this job today with zero new code
and this phase can be skipped. It is ₹2000/month, so this is unlikely, but it costs
nothing to confirm.

## What Fyers v3 provides

Endpoint: `GET https://api-t1.fyers.in/data/history`. Also exposed by the official
`fyers-apiv3` SDK; this plan uses plain `fetch`, matching the Kite adapter.

| Property | Value |
|---|---|
| Resolutions | `5S`–`45S`, `1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 120, 180, 240`, `D` |
| Minute history from | 2017-07-03 |
| Per-request span, intraday | 100 days |
| Per-request span, daily | 366 days |
| Seconds resolutions | last 30 trading days only |
| Response candle | `[epoch_seconds, open, high, low, close, volume]` |
| Open interest | opt-in via `oi_flag=1` |
| Daily download cap | none stated |

Every scalp timeframe maps to a native resolution, so the downsampling hack disappears
rather than moving. Verify these limits against current Fyers documentation before
implementing — the Kite adapter's comment about re-checking per-interval caps applies
here for the same reason.

## Provenance is partitioned by timeframe

This is the central design decision of the phase.

If Fyers backfills history up to a cutover date and Yahoo keeps writing after it, every
series becomes Fyers-then-Yahoo. Models would train on Fyers bars and infer on Yahoo
bars — train/serve skew introduced deliberately, at the data layer, where it is nearly
invisible.

Partitioning by **timeframe** instead of by **date** avoids this completely:

| Timeframe | Owner | Why |
|---|---|---|
| `1m`, `3m`, `5m`, `10m` | Fyers | Yahoo cannot serve these honestly |
| `15m`, `30m`, `60m`, `1d` | Yahoo | native, adequate, already scheduled, no auth |

No series ever mixes providers, at any date. The scheduler's 15m job is untouched
because 15m is not a Fyers timeframe. Nothing needs a cutover date.

The cost of this choice: `15m` keeps Yahoo's 60-day limit and zero index volume. That
is accepted — the swing models on `ml-feature-v5` already live with it, and revisiting
it means taking on the scheduler credential problem this scope deliberately avoids.

## Token handling

Fyers issues a short-lived access token plus a refresh token valid for **15 days**, after
which an interactive OAuth login is required. There is no non-interactive path past that.

Under this scope that ceiling is nearly harmless. A backfill campaign is measured in
hours or days, not weeks, and it is run by a person who can log in again. The refresh
flow is still worth having because a multi-year `1m` backfill across several instruments
can outlive a single access token, and restarting a half-finished backfill because a
token aged out mid-run is pure waste.

The refresh call:

```text
POST https://api-t1.fyers.in/api/v3/validate-refresh-token
{
  "grant_type":    "refresh_token",
  "appIdHash":     sha256("<FYERS_APP_ID>:<FYERS_APP_SECRET>"),
  "refresh_token": "<stored refresh token>",
  "pin":           "<4-digit PIN>"
}
```

Tokens must persist **between CLI invocations**, since each backfill command is a new
process and re-prompting for an interactive login per command is unusable. Postgres is
the right store: the CLI may run on the host or in a container, and both already share
`DATABASE_URL`. Writing back into `.env` at runtime — a common pattern in Fyers community
examples — puts a live secret into a file the repo also ships an example of.

### Migration `028-provider-credentials`

```sql
CREATE TABLE provider_credentials (
  provider TEXT PRIMARY KEY CHECK (length(trim(provider)) > 0),
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token TEXT,
  refresh_token_expires_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

One row per provider, keyed by the ID already used in `candles.source`. Nullable token
columns so the row can exist un-authenticated rather than being absent.

This table holds live broker secrets in plaintext. Acceptable for a local single-operator
lab; not acceptable on a hosted or shared database. See Production considerations.

### `FyersTokenService`

`apps/api/src/infrastructure/market-data/fyers-token-service.ts`. Single responsibility:
hand out a valid access token.

- `getAccessToken()` returns the cached token while `access_token_expires_at` is more
  than ~5 minutes ahead; otherwise it refreshes, persists, and returns.
- Serialise refreshes with `SELECT ... FOR UPDATE` on the row so two concurrent backfills
  do not both burn a refresh.
- On failure, write `last_error` and throw a message naming the remedy — "Fyers refresh
  token expired; re-run `npm run data:auth:fyers`" — not a bare HTTP 400.
- Detect response code `-371` specifically and report it as a malformed `appIdHash`. It
  is the most common Fyers integration error and is indistinguishable from an expired
  token by status code alone.
- Never log a token value, including into `last_error`, which will otherwise capture an
  upstream response body containing one.

### `npm run data:auth:fyers`

Interactive bootstrap, run at the start of a backfill campaign and at most fortnightly.
Prints the authorization URL, accepts the pasted `auth_code` on stdin, exchanges it for
the token pair, writes the row. The only step requiring a human.

Before starting a long backfill, the collector should check `refresh_token_expires_at`
and refuse to start a job it cannot finish, rather than dying partway.

## The adapter

`apps/api/src/infrastructure/market-data/fyers-historical-data-provider.ts`, modelled on
the Kite adapter, which already solves the same shape of problem.

```typescript
export class FyersHistoricalDataProvider implements HistoricalMarketDataProvider {
  readonly id = "fyers-api-v3";
  constructor(options: { tokenService: FyersTokenService; appId: string; fetch?: typeof fetch });
  async fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]>;
}
```

Where it must differ from Kite — each is a place a naive port breaks:

- **Auth header** is `Authorization: <appId>:<accessToken>`, colon-joined, not Kite's
  `token ` prefix.
- **Resolution map** is numeric strings: `1m→"1"`, `3m→"3"`, `5m→"5"`, `10m→"10"`.
  Only the Fyers-owned timeframes need mapping, though implementing the full set costs
  nothing and avoids a partial lookup table.
- **Chunking** is 100 days for intraday and 366 for `1d`, replacing Kite's per-interval
  table with a two-case one. Keep the `maxDaysPerRequest` override.
- **Timestamps are epoch seconds**, not Kite's offset-suffixed strings. Multiply by 1000;
  do not reuse `normalizeKiteTimestamp`.
- **Errors** can arrive as `{"s": "error", "code": -N, "message": "..."}` with HTTP 200.
  Check `s !== "ok"`, not only `response.ok`.
- **`range_to` must be in the past.** Fyers returns a partial candle for the current
  interval. `ImportHistoricalMarketData` marks it incomplete so it is not a correctness
  bug, but clamping avoids writing a provisional row on every run.

A `fyers-symbol-resolver.ts`, mirroring `yahoo-symbol-resolver.ts`, maps canonical
symbols to the `NSE:SBIN-EQ` / `NSE:NIFTY50-INDEX` convention.

Tests mirror `kite-historical-data-provider.test.ts` with an injected `fetch`: chunk
arithmetic at the 100-day edge, epoch conversion, the `s: "error"` path, and a
token-refresh path asserting one refresh serves many chunks.

## The cutover trap

`PostgresCandleRepository.upsert` refuses to modify a completed candle, and its equality
check includes provenance:

```53:61:apps/api/src/infrastructure/database/repositories/postgres-candle-repository.ts
function hasSameValues(candle: PersistedCandle, input: UpsertCandleInput): boolean {
  return candle.closeTime.getTime() === input.closeTime.getTime()
    && normalizeDecimal(candle.open) === normalizeDecimal(input.open)
    // ...
    && candle.source === input.source;
}
```

So backfilling from Fyers over a range Yahoo already covers has two outcomes, neither
intended:

- **Without `--skip-existing`**, the first overlapping bar throws "Completed candles are
  immutable" and the import aborts. Loud, therefore harmless.
- **With `--skip-existing`**, every Yahoo bar is kept and every Fyers bar dropped. The
  command reports success with a large `candlesSkipped` and an ingestion row labelled
  `fyers-api-v3`, while the series is still Yahoo data. Quiet, therefore dangerous.

The second is the trap: a run that looks like a successful migration.

Resolution is a purge migration, with the same reasoning as `013-purge-fabricated-rsi`
and `026-purge-fabricated-predictions`, scoped to the Fyers-owned timeframes only:

```sql
-- 029-purge-yahoo-scalp-candles
DELETE FROM candles
WHERE source = 'yahoo' AND timeframe IN ('1m', '3m', '5m', '10m');
```

`15m`, `30m`, `60m`, and `1d` are untouched, because Yahoo continues to own them.

Before running it, confirm nothing derived is orphaned — `indicator_snapshots`,
`pattern_detections`, trade ideas, and model predictions keyed to these candles. Where
`ON DELETE RESTRICT` applies the migration will fail rather than cascade, which is
correct but must be known in advance rather than discovered.

Two consequences to accept deliberately:

- Scalp models trained on the old data used fabricated `3m` bars and zero-volume
  features. Retire them rather than comparing them against Fyers-trained models. A
  feature-schema bump to `ml-feature-scalp-v3` is the mechanism the project already has
  for forcing this, and the scalp competition pool should start fresh.
- No reference series survives the purge. Validate against a second source **before**
  running it — see step 6.

## The seeds will undo the purge

`seed-core-instruments` runs `seedMarketData` and `seedScalpData`, and per
`docs/phase-15-docker-orchestration-seeding.md` that command runs on **every container
boot**:

```61:72:apps/api/src/modules/market-data/application/seed-market-data.ts
        const timeframes = [
          { tf: "1d", count: 100, intervalMs: 24 * 3600 * 1000 },
          { tf: "1h", count: 100, intervalMs: 3600 * 1000 },
          { tf: "15m", count: 100, intervalMs: 15 * 60 * 1000 },
          { tf: "5m", count: 100, intervalMs: 5 * 60 * 1000 },
          { tf: "1m", count: 100, intervalMs: 60 * 1000 },
        ];
```

`upsertSeedCandle` writes these with `source = YAHOO_PROVIDER_ID` and
`is_complete = TRUE`. So after the purge and backfill, the next `docker compose up`
inserts 100 Yahoo `1m` and 100 Yahoo `5m` bars per index straight back into the training
series. Its `WHERE candles.is_complete = FALSE` guard prevents overwriting a Fyers bar,
but any timestamp Fyers did not cover — including the current session — is inserted
fresh as Yahoo. `seedScalpData` does the same for `1m`.

The purge undoes itself on the next restart unless the seeds stop writing Fyers-owned
timeframes. Fix this **in the same change as the purge**, not after.

Options, in order of preference:

1. Drop `1m` and `5m` from `seedMarketData`'s timeframe list and retire `seedScalpData`'s
   candle writes. First-boot scalp dashboards then show empty until a backfill runs,
   which is honest — an empty chart is better than 100 bars of the wrong provider.
2. Keep the seeds but have them skip any timeframe that already holds Fyers rows. More
   code, and still writes Yahoo scalp bars on a genuinely fresh database.

Option 1 is consistent with how Phase 22 and migrations 013/017/026 already handled
seeded data that polluted a real table: delete it rather than teach it to behave.

Also note `seedMarketData` writes `1h`, which is not in `supportedHistoricalTimeframes`
(the canonical name is `60m`). The DB accepts it since the constraint is a length check,
but no collector can ever refresh those rows. Unrelated to this phase, worth settling.

## The volume caveat a provider swap does not fix

Fyers will not return intraday volume for `NSE:NIFTY50-INDEX` either. An index is a
computed number, not a traded instrument, so it has no traded quantity at any vendor,
Kite included. Expecting the provider swap to fix zero index volume is the most likely
way this phase disappoints.

Real volume for NIFTY scalping requires changing the **instrument**, not the source:
the NIFTY futures contract (`NSE:NIFTY26AUGFUT`), which has genuine volume and open
interest and is what an intraday NIFTY trade actually executes against, or a liquid
index ETF (NIFTYBEES) as a cash-market proxy.

Futures bring rollover: each contract is a separate series with its own expiry, so
continuous history means stitching and choosing a roll rule and whether to price-adjust.
Fyers' `cont_flag=1` offers continuous futures data, but a vendor-stitched series has an
opinion baked in that needs verifying before training on it.

Out of scope here — it touches the instrument registry, the F&O specs from migrations
019–021, and the paper-trading fee model. Noted so the expectation is not misplaced.

Individual equities do have real volume at every resolution, so the equity universe from
migration 027 benefits from this phase immediately.

## Configuration

```text
# Fyers API v3, read-only historical backfill. Minute data from 2017-07-03.
FYERS_APP_ID=
FYERS_APP_SECRET=
FYERS_PIN=
FYERS_REDIRECT_URI=
```

No token variables — those live in `provider_credentials`. `FYERS_APP_SECRET` and
`FYERS_PIN` are used only to compute `appIdHash` and call the refresh endpoint.

These stay outside the Zod schema in `config/environment.ts`, matching the Kite
variables: the API server does not need Fyers to boot, and requiring them there would
break every deployment not using it.

Unrelated but worth fixing while in this file: `.env.example` ships a real-looking
`POSTGRES_PASSWORD`. An example file should carry an obvious placeholder.

## Implementation order

Each step leaves the tree working.

1. Migration `028-provider-credentials` plus its entry in `migrations/index.ts`.
2. `FyersTokenService` with unit tests against an injected `fetch`.
3. `npm run data:auth:fyers` bootstrap CLI. Verify a token round-trip end to end.
4. `fyers-symbol-resolver.ts` and `FyersHistoricalDataProvider` with tests.
5. Wire `"fyers"` into `providerFromArguments` in `collect-historical-data.ts`.
6. **Validate before destroying the reference.** Pull the same `5m` range from Fyers and
   from Yahoo for a liquid equity where both have real volume, and diff. Optionally pull
   the same range from Upstox — it is free, and after step 7 no independent series exists
   to catch a timestamp-alignment error.
7. Migration `029-purge-yahoo-scalp-candles` **and** the seed fix, in one change.
8. Backfill, one instrument and timeframe at a time:

```powershell
npm run data:collect:historical -- --provider fyers --instrument NIFTY50 --timeframe 5m --from 2023-08-01 --to 2026-08-01
npm run data:collect:historical -- --provider fyers --instrument NIFTY50 --timeframe 1m --from 2024-08-01 --to 2026-08-01
```

9. Retrain scalp models under `ml-feature-scalp-v3`; reset the scalp competition pool.

Steps 1–6 are additive and reversible. Step 7 is the point of no return.

## Code decisions

- The token service is separate from the adapter: credential lifetime and candle fetching
  change for unrelated reasons.
- Tokens live in Postgres, not `.env`. Separate CLI processes need them, and a container
  will not re-read a rewritten file.
- Plain `fetch` over the `fyers-apiv3` SDK. Two endpoints are needed, the Kite adapter
  sets the pattern, and the SDK pulls order-placement code this project deliberately
  keeps out of its dependency tree.
- The purge is a migration, not a script, so the cutover is recorded in the same ordered
  history as the schema and cannot be half-applied across environments.
- Provenance is partitioned by timeframe, not by date, so no series mixes providers.
- Yahoo is retained everywhere it currently works.

## Common mistakes

- Running the backfill with `--skip-existing` over Yahoo rows and reading the success
  output as a completed migration.
- Purging without fixing the seeds, so the next container boot reintroduces Yahoo bars.
- Letting Fyers and Yahoo share a timeframe, which produces train/serve skew invisible
  above the data layer.
- Expecting index intraday volume to appear. It will not; that needs futures.
- Reusing Kite's `normalizeKiteTimestamp` on Fyers epoch seconds.
- Treating HTTP 200 as success without checking `s`.
- Comparing pre- and post-cutover model accuracy as though the inputs were the same.
- Backfilling years of `1m` across many instruments in one run. Chunk it; expect rate
  limiting.

## Production considerations

`provider_credentials` holds a live broker secret in plaintext. The token is used
read-only here, but the same Fyers app can place orders, so the blast radius exceeds the
use. Before this database is hosted or shared: encrypt the columns at rest or hold only a
reference to a secrets manager, and grant on the table separately from the rest of the
schema.

Add per-provider rate limiting before the backfill scales past a handful of instruments.

Storage is worth sizing before the first large run: roughly 375 one-minute bars per
trading day, about 250 sessions a year, so ~94k rows per instrument-year at `1m`. A
three-year backfill across a twenty-name universe is several million rows in `candles`.
Check the indexes on `(instrument_id, timeframe, open_time)` still serve the ML
repository's range scans at that size.

## Open questions

1. Does Fyers return real intraday volume for NSE cash equities matching Kite or the
   exchange bhavcopy? Step 6 answers this and should be treated as a gate.
2. Are Fyers equity candles adjusted for splits and bonuses? Phase 3 forbids mixing
   adjusted and unadjusted series in one backtest, and the Yahoo adapter deliberately
   uses raw `close`. If Fyers differs, the migration-027 equity universe is affected.
3. How far back is actually useful? 2017 is available, but pre-2020 minute structure may
   not generalise. Pick a start date deliberately rather than taking the maximum.
4. Should `10m` be Fyers-owned or dropped? It is currently fabricated by Yahoo and it is
   not in `SCALP_TIMEFRAMES`, so it may have no consumer at all. Check before backfilling
   it.
5. Should `5S`–`45S` be added to `supportedHistoricalTimeframes`? Available for 30
   trading days, and would need new timeframe literals across the TypeScript and Python
   layers. Deferred.
