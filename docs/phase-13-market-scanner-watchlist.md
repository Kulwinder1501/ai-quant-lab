# Phase 13: read-only market scanner and watchlist

## Purpose

Phase 13 adds a local Market Scanner and Watchlist. It exposes active locally
registered instruments and their latest persisted completed-candle research
context.

It does not collect a quote, refresh a provider, calculate an indicator, detect
a pattern, generate a model prediction, create a strategy proposal, alter a
paper trade, connect to a broker, or place an order.

The watchlist is the existing active instrument registry projection. It is not
an editable favorites list, so this code-first phase has no add/remove API.

## Theory and why it exists

A scanner is an evidence-discovery view, not a recommendation engine. A
current-looking number without its candle state, timeframe, calculation context,
or model provenance encourages look-ahead and overconfidence. This phase
instead lets a researcher inspect saved evidence together:

- active local instruments;
- their newest completed candle for one requested timeframe;
- saved indicators, patterns, and price-action events belonging to that exact
  candle; and
- an optional previously saved Phase 11 model observation for that exact candle.

The browser does not recompute analysis or inference. A displayed pattern,
direction, or model probability remains research context, never a trade signal.

## Safety boundary

Phase 13 contains only these GET routes:

- `GET /api/v1/watchlist`
- `GET /api/v1/market-scanner`

There are no POST, PUT, PATCH, or DELETE routes. The dashboard sends only GET
requests. It does not expose instrument metadata, candle source metadata,
ingestion/provider information, artifact paths, trade ideas, paper trades,
broker credentials, broker controls, or order controls.

Every returned row has `researchOnly: true`. A scanner candle is always
completed and must have both closed and been received no later than the
database request time. The UI calls its close a recorded close, never a current
quote. Future-dated derived evidence is excluded as well.

## Architecture

```text
active instrument registry ------------------------> GET /watchlist
                                                       |
completed candle + exact-candle stored evidence       | safe registry projection
    indicators / patterns / price action              v
    optional saved model observation           Watchlist dashboard panel
                    |
                    | parameterized SELECT-only projection
                    v
           GET /market-scanner ---------------------> Scanner dashboard panel
                                                       |
                                                       +--> completed evidence only
                                                       +--> no collection or actions
```

## Implementation and folder structure

```text
apps/api/src/
  modules/market-scanner/
    domain/market-scanner.ts
    application/list-watchlist.ts
    application/list-market-scanner.ts
  infrastructure/database/repositories/
    postgres-market-scanner-query-repository.ts
  interfaces/http/app.ts

apps/web/src/app/
  page.tsx                              # scanner home view
  market-scanner-dashboard.tsx
  research-navigation.tsx
  predictions/page.tsx                  # retained Phase 12 view
  ai-predictions-dashboard.tsx
```

The read repository uses only parameterized SELECT statements and validates
database values before returning JSON. The web client parses JSON defensively
and makes loading, empty, and unavailable states explicit rather than
manufacturing market data.

## Database design and evidence lineage

Phase 13 adds no table and no migration. It reads existing local tables:

| Data | Use |
| --- | --- |
| `instruments` | Active registry, safe identity, market conventions |
| `candles` | Latest completed candle for the selected timeframe |
| `indicator_snapshots` and `indicator_definitions` | Values for that exact candle |
| `pattern_detections` and `pattern_definitions` | Patterns for that exact candle |
| `price_action_events` | Price-action events for that exact candle |
| `model_predictions` and `model_versions` | Optional saved model observation for that exact candle |
| `strategies` and `strategy_versions` | Current safe strategy catalog metadata only |

The scanner selects one newest completed candle per active instrument and
timeframe first, only when its close time and persisted receipt are no later
than the request time. Every indicator, pattern, price-action, and model lookup
then uses that selected candle ID and excludes a future-dated calculation,
detection, prediction creation, or evidence cutoff. It never mixes evidence
across candles.

The active strategy catalog is current metadata, not historical evidence
connected to a scanner candle. Only its key, name, and version are returned;
configuration, proposal, and trade data stay private.

## API contract

### Active local watchlist

```text
GET /api/v1/watchlist
```

Optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `exchange` | NSE, NFO, or BSE |
| `instrumentType` | INDEX, EQUITY, or ETF |
| `limit` | Whole number from 1 through 100; default 50 |
| `cursorExchange` + `cursorSymbol` + `cursorId` | Complete next-page position |

Rows are ordered by exchange, symbol, then ID. Each safe registry row has
researchOnly, ID, exchange, symbol, display name, instrument type, INR
currency, timezone, tick size, lot size, and ACTIVE registry status.

The response is an object with data and page. Map
page.nextCursor.exchange, page.nextCursor.symbol, and page.nextCursor.id to
the three cursor request parameters for the next page. Unknown/blank filters,
an incomplete cursor, invalid UUID, or invalid limit return HTTP 400.

### Completed-candle scanner

```text
GET /api/v1/market-scanner
```

Optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `timeframe` | Completed-candle timeframe; default 1d |
| `instrument` | Exact local instrument symbol |
| `exchange` | NSE, NFO, or BSE |
| `prediction` | Optional saved same-candle BULLISH, BEARISH, or NEUTRAL label |
| `limit` | Whole number from 1 through 100; default 50 |
| `cursorCloseTime` + `cursorInstrumentId` | Complete next-page position |

Only active instruments with a saved completed candle for the timeframe appear.
Rows sort by completed close time descending, then instrument ID descending.
PostgreSQL timestamps may contain microseconds while JavaScript round-trips ISO
milliseconds, so the SQL cursor predicate and ordering use the same
millisecond-normalized close-time key. This prevents a keyset cursor from
skipping closely timed rows.

The response has data, page, and context. Each data row has:

- researchOnly;
- safe local instrument identity;
- latestCompletedCandle with saved OHLCV;
- same-candle arrays of indicators, patterns, and priceActionEvents; and
- an optional saved same-candle modelPrediction.

Context includes the selected timeframe and a current activeStrategies catalog
with key, name, and version only. It does not mean a strategy was evaluated,
accepted, or executed for any scanner row.

Invalid filters, labels, cursor values, UUIDs, or timeframe syntax return HTTP
400. A valid request with no persisted evidence returns an empty list rather
than a fabricated live view.

## Dashboard behavior

The home dashboard issues independent GET requests to the watchlist and scanner
endpoints. The page can therefore show a ready watchlist while scanner evidence
is empty or unavailable. It never falls back to a provider, collector,
inference process, strategy process, paper-trading process, broker, or order
process.

The scanner shows saved candle open/high/low/close/volume, indicators, patterns,
price-action labels, and the optional stored model observation. It labels model
confidence as historical research information, not a forecast guarantee. The
Phase 12 explanation inspector remains available at `/predictions`.

## Code flow

1. HTTP query parsing accepts each input once and rejects ambiguity.
2. Watchlist validation bounds filters and derives a deterministic keyset
   cursor after fetching one additional row.
3. Scanner validation bounds timeframe, filters, and cursor, then reads its
   compact current strategy catalog in parallel with the scanner rows.
4. The PostgreSQL projection selects time-eligible completed candles and only
   time-eligible exact-candle evidence with no write SQL.
5. The Next.js view validates its JSON contract and renders an honest state.

## Best practices

- Read candle close time and timeframe before interpreting evidence.
- Keep selected-candle evidence separate from current strategy catalog state.
- Use returned keyset cursors, not offsets or guessed timestamps.
- Treat an empty scanner as a saved-data availability result.
- Use the Phase 12 detail page to inspect a model explanation rather than
  promoting a compact scanner label into a decision.

## Common mistakes

- Calling a recorded completed close the current quote.
- Combining evidence from different candles.
- Treating active registry entries as editable favorites or alerts.
- Treating any pattern, direction, or confidence as an order instruction.
- Treating current strategy catalog state as historical candle evidence.
- Exposing provider metadata, raw artifacts, trade data, or broker controls for
  dashboard convenience.

## Production considerations

For a large local universe, add indexes supporting the exact scanner
completed-candle and normalized cursor order, preserve strict page caps, and
materialize a read projection if joins become expensive. For authenticated
multi-user use, authorize routes separately, restrict CORS to the dashboard
origin, rate-limit calls, and audit record access.

If editable favorites or alerts are added later, implement them as a separate
local-preference feature with explicit mutation endpoints, validation, and
audit history. Do not overload active-instrument status or add hidden side
effects to Phase 13 reads.

## Deferred local runtime work

This code phase does not install dependencies, run migrations, seed
instruments, collect data, calculate indicators, detect patterns, generate a
prediction or strategy proposal, or create paper trades. Those local runtime
steps remain deferred until the user explicitly chooses them.

## Assignments

1. After deferred local setup is authorized, register active instruments and
   verify that the watchlist reveals registry fields but no provider metadata.
2. Save completed-candle evidence for one timeframe and verify every scanner
   item uses that same candle/timeframe.
3. Request one scanner row per page, follow page.nextCursor, and explain the
   close-time plus instrument-ID cursor.
4. Compare a scanner model observation with its Phase 12 explanation and
   explain why neither is an order or return guarantee.
5. Confirm in browser network tools that all Phase 13 calls are GET-only.
