# Phase 12: read-only AI prediction dashboard

## Purpose

Phase 12 makes saved Phase 11 model observations inspectable in the local
dashboard. It answers: what did the recorded model say, which completed candle
and evidence cutoff supported it, and what explanation was stored with it?

It does not score a candle, train or promote a model, create a strategy idea,
change a paper trade, connect to a broker, or place an order. The browser and
API are intentionally read-only.

## Theory and why it exists

A directional label and confidence without its source time, evidence cutoff,
model version, validation context, and stored terms can look more certain than
it is. An explainable observation is useful only when a researcher can inspect
those pieces together and distinguish historical research evidence from a live
market claim.

The dashboard reads persisted evidence instead of recomputing features or
inference in the browser. Recomputing would make it unclear which inputs were
available when the observation was stored and would blur review with a new
signal. `confidence` remains a selected-class model probability; it is not
probability of profit, a price target, an instruction, or a guarantee.

## Safety boundary

The entire Phase 12 surface is two GET routes:

- `GET /api/v1/model-predictions`
- `GET /api/v1/model-predictions/:id`

There are no POST, PUT, PATCH, or DELETE routes. The dashboard sends only GET
requests. It exposes neither a model artifact URI nor raw artifact contents,
and it does not expose `trade_idea_id`, paper-trade data, broker credentials,
broker controls, or order-routing controls.

Each returned record has `researchOnly: true`. A model's `currentStage` is the
current mutable registry stage, so it can differ from the stage when an older
prediction was saved.

## Architecture

```text
model_predictions + source candle + model_versions
                    |
                    | SELECT-only, validated projection
                    v
PostgresModelPredictionQueryRepository
                    |
                    v
GET /api/v1/model-predictions ----------> compact list rows
GET /api/v1/model-predictions/:id ------> stored explanation
                    |
                    | JSON only; no inference and no writes
                    v
Next.js AI Predictions dashboard
                    |
                    +--> record list
                    +--> evidence and model metadata
                    +--> stored contributions and explanations
```

## Implementation

```text
apps/api/src/
  interfaces/http/app.ts
  modules/model-predictions/
    domain/model-prediction.ts
    application/list-model-predictions.ts
    application/get-model-prediction.ts
  infrastructure/database/repositories/
    postgres-model-prediction-query-repository.ts

apps/web/src/app/
  page.tsx
  ai-predictions-dashboard.tsx
```

The repository joins a prediction to its instrument, model version, and,
when retained, source candle. Before it returns a record it checks numeric
values are finite, confidence is within [0, 1], dates parse, model stages and
labels are known, and JSON fields have their expected object or array shape.
Only safe inspection fields are projected.

The dashboard treats JSON as untrusted input. It parses nested values,
separates source-candle, evidence-cutoff, and record-created timestamps, and
has an unavailable state instead of inventing data.

## Database design

Phase 12 adds no migration and writes no rows. It reads the Phase 11
`model_predictions` records and related tables:

| Source | Read purpose |
| --- | --- |
| `model_predictions` | label, confidence, creation time, evidence cutoff, stored terms and explanation |
| `instruments` | local symbol and display name |
| `candles` | completed source OHLCV evidence and timeframe, if retained |
| `model_versions` | safe lineage, validation metrics, feature schema and training window |

Phase 11 migration `003-model-prediction-identity` supplies
`evidence_cutoff_at`. `createdAt` is when the observation was stored;
`evidenceCutoffAt` is the latest evidence boundary claimed by it. They are not
interchangeable.

## API contract

### List records

```text
GET /api/v1/model-predictions
```

Optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `instrument` | Local instrument symbol, normalized to upper case |
| `modelKey` | Exact persisted model key |
| `timeframe` | Source-candle timeframe |
| `prediction` | `BULLISH`, `BEARISH`, or `NEUTRAL` |
| `limit` | Whole number from 1 through 100; default 50 |
| `cursorCreatedAt` + `cursorId` | A pair returned in `page.nextCursor` |

Results use keyset pagination. Their deterministic SQL order is
millisecond-normalized `createdAt DESC, id DESC`, and the cursor predicate uses
the same normalization. This prevents PostgreSQL microsecond timestamps from
being lost when the browser round-trips a JavaScript ISO-millisecond timestamp.
Records saved within the same millisecond are ordered by ID.

`cursorCreatedAt` must be canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ` and
`cursorId` must be a UUID. Missing one side of the pair, an invalid UUID or
label, a blank filter, or an out-of-range limit returns HTTP 400.

```json
{
  "data": [
    {
      "researchOnly": true,
      "id": "prediction UUID",
      "prediction": "BULLISH",
      "confidence": 0.64,
      "createdAt": "2026-07-26T09:00:00.000Z",
      "evidenceCutoffAt": "2026-07-26T08:59:59.000Z",
      "instrument": { "symbol": "NIFTY50", "displayName": "NIFTY 50" },
      "sourceCandle": { "timeframe": "1d", "close": 24800.0 },
      "model": { "key": "direction-logistic", "version": 3, "currentStage": "PRODUCTION" }
    }
  ],
  "page": {
    "limit": 50,
    "nextCursor": null
  }
}
```

The next request maps `page.nextCursor.createdAt` to `cursorCreatedAt` and
`page.nextCursor.id` to `cursorId`.

### Inspect a stored record

```text
GET /api/v1/model-predictions/:id
```

The detail includes the safe summary plus persisted `featureContributions`,
`explanation`, model feature schema, and training window. It never reruns
inference. A malformed UUID is HTTP 400; a valid but absent UUID is HTTP 404.

The model checksum is exposed for lineage comparison, but artifact location and
payload are not. A source candle may be `null` if historical evidence was not
retained; the dashboard displays that absence rather than substituting live
market data.

## Dashboard behavior and code flow

At load, the browser requests up to six saved records from
`NEXT_PUBLIC_API_URL`. The setting may be an API root or already end in
`/api/v1`. Selecting a row makes one further GET request for its stored detail.

It distinguishes Loading, Empty, Ready, and Unavailable states. In particular,
an unavailable API does not trigger market-data fallback, inference, strategy
generation, paper trading, or broker access.

The inspector shows the label, confidence, source close, cutoff, creation time,
model version, validation macro F1 when available, feature-contribution
direction, and recorded explanation entries. Positive and negative bars
describe local logistic-model arithmetic, not market causation.

The request path is:

1. `app.ts` parses each query value once and rejects ambiguous repeated values.
2. `ListModelPredictions` validates filters and limits, asks for one extra row,
   and derives a cursor without a COUNT query.
3. `PostgresModelPredictionQueryRepository` executes parameterized SELECT-only
   SQL with the matching normalized `created_at, id` keyset predicate.
4. `GetModelPrediction` validates the route UUID before PostgreSQL lookup.
5. The dashboard parses the response and renders stored evidence only.

## Best practices

- Keep the evidence cutoff visible whenever discussing a prediction.
- Inspect version, validation metrics, and opposing terms along with confidence.
- Use the returned keyset cursor; do not substitute offset pagination.
- Treat missing evidence as missing evidence, not a reason to derive a result
  in the UI.
- Keep this read model separate from strategy, backtest, and paper-trade views.

## Common mistakes

- Calling a persisted label a live signal or recommendation.
- Confusing `createdAt` with the evidence cutoff.
- Assuming `currentStage` was the model stage at historical prediction time.
- Treating confidence or a contribution bar as expected return.
- Exposing artifact paths, trade identifiers, credentials, or action controls.
- Adding a browser fallback that fetches current market data when a record is
  missing.

## Production considerations

For authenticated multi-user use, authorize these two read routes separately,
restrict CORS to the dashboard origin, rate-limit list/detail calls, and audit
research-record access. Keep database credentials and artifact locations
server-side. If historical stage reconstruction matters, persist an immutable
stage-at-prediction snapshot.

For a large collection, retain an index supporting the exact normalized cursor
order, keep the page cap, and consider a purpose-built read projection. Any
future action workflow must be a separate reviewed phase; Phase 12 has no
action route.

## Deferred local runtime work

Per the current code-first workflow, this phase does not run migrations, install
dependencies, train or promote a model, or generate a prediction. Those local
steps remain deferred until the code phases are complete and the user chooses
to run them.

## Assignments

1. After deferred setup is authorized, save one explainable local prediction
   and verify separate source-close, cutoff, and creation timestamps.
2. Request `limit=1`, follow `page.nextCursor`, and explain why the second
   request uses a keyset cursor instead of an offset.
3. Try a malformed cursor timestamp and detail ID; verify both return HTTP 400
   rather than a database error.
4. Compare a positive and a negative contribution and explain why neither
   proves a future return.
5. Confirm in the browser network panel that the dashboard makes only GET
   requests and offers no broker, paper-trade, or order action.
