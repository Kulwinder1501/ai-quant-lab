# Phase 20: Trade History ledger and Model Performance registry

## Purpose

The original specification lists nine dashboard modules. Eight existed. Two were
missing by name — **Trade History** and **Model Performance** — and the data behind
them was only reachable in fragments: closed fills were visible one account at a
time inside the Orders view, and training metrics were buried in a JSONB column no
screen ever read.

This phase adds both views and the two read-only endpoints behind them.

## Theory and why it exists

These two screens answer the questions that only make sense across records rather
than within one.

**Trade History** is the audit ledger. A single trade tells you nothing about a
strategy; the sequence does. Profit factor, expectancy, reward multiples, and
drawdown are all properties of a *set* of trades, and drawdown in particular is a
property of their *order* — it exists only along the sequence in which positions
actually closed. The existing Orders view is scoped to one account's closed fills,
which cannot express any of that.

**Model Performance** is the registry. Every training run already recorded its
holdout metrics, hyperparameters, validation protocol, and promotion decision into
`model_versions.validation_metrics`. Without a screen for it, the only way to answer
"did the boosted candidate actually beat the linear baseline, and by how much?" was
to read JSON out of PostgreSQL by hand.

The registry view also surfaces one derived number that no single training run can
show you: the training-to-validation macro-F1 gap. A model that fits its own history
far better than the unseen period is memorising, and comparing that gap across
versions is how you notice.

## Safety boundary

Both endpoints are `GET`-only and both use cases are query-only by construction:

- `ListPaperTradeHistory` reads stored paper activity. It cannot open, close,
  evaluate, or cancel a trade, and its repository has no insert, update, or delete
  path.
- `ListModelVersions` reads the model registry. It cannot train, promote, reject, or
  archive a model.
- The model repository never selects `artifact_uri`. A dashboard has no reason to
  learn a local file path; the checksum is enough to identify which artifact a metric
  belongs to.
- Every trade row carries `simulatedOnly: true` and every model row carries
  `researchOnly: true`. The web parsers drop any record that does not declare it, so
  a row that cannot prove what it is never renders.

## Architecture

```text
GET /api/v1/paper-trades
   └─ ListPaperTradeHistory                    (modules/paper-trading/application)
        ├─ PostgresPaperTradeHistoryQueryRepository   SELECT-only, all accounts
        └─ summarizePaperTradeHistory           (modules/paper-trading/domain) pure

GET /api/v1/model-versions
   └─ ListModelVersions                        (modules/model-performance/application)
        ├─ PostgresModelPerformanceQueryRepository    SELECT-only, no artifact_uri
        ├─ buildModelVersionPerformance         (modules/model-performance/domain) pure
        └─ summarizeModelFamilies               groups versions by model key

apps/web/src/features/trade-history      domain + parsers + dashboard
apps/web/src/features/model-performance  domain + parsers + dashboard
apps/web/src/app/trade-history           route
apps/web/src/app/model-performance       route
```

Both aggregation steps are pure functions in the domain layer, which is why they are
unit-tested without a database in `paper-trade-history.test.ts` and
`model-performance.test.ts`.

## API contract

### Trade History

`GET /api/v1/paper-trades`

| Query | Values |
| --- | --- |
| `accountId` | Paper account UUID |
| `instrument` | Registered symbol, for example `NIFTY50` |
| `status` | `OPEN`, `CLOSED`, `CANCELLED` |
| `side` | `LONG`, `SHORT` |
| `exitReason` | `TARGET`, `STOP_LOSS`, `MANUAL`, `CANCELLED` |
| `outcome` | `WIN`, `LOSS`, `BREAK_EVEN` |
| `openedFrom`, `openedTo` | UTC ISO-8601 timestamps |
| `limit` | 1 to 500, default 100 |

```json
{
  "data": [
    {
      "simulatedOnly": true,
      "id": "…",
      "accountName": "Research account",
      "instrumentSymbol": "NIFTY50",
      "side": "LONG",
      "status": "CLOSED",
      "entryPrice": 24150.5,
      "exitPrice": 24510.25,
      "exitReason": "TARGET",
      "realizedPnl": 3597.5,
      "returnPercent": 1.49,
      "rewardMultiple": 1.98,
      "holdingMinutes": 2865
    }
  ],
  "summary": {
    "closedTradeCount": 12,
    "winRatePercent": 58.333333,
    "profitFactor": 2.14,
    "expectancy": 611.2,
    "averageRewardMultiple": 0.92,
    "maximumDrawdown": 4210.5
  },
  "page": { "limit": 100, "truncated": false },
  "context": { "simulatedOnly": true, "accounts": [{ "id": "…", "name": "…" }] }
}
```

`page.truncated` is derived by asking the database for one row more than the caller
requested. The UI says the ledger was cut short instead of presenting a partial
history as complete.

### Model Performance

`GET /api/v1/model-versions`, filterable by `modelKey`, `algorithm`, `stage`, and
`limit` (1 to 200, default 50). Each record carries the version's stage, algorithm
family, holdout and training metrics, `generalizationGap`, hyperparameters, the
purged validation protocol, the promotion assessment, and recorded prediction
activity. The response also includes a `families` array grouping versions by model
key so the dashboard can show which algorithm holds each production slot.

## What the numbers mean, and what they do not

- **Realised statistics use closed trades only.** An open position has no realised
  profit; counting an unrealised mark would overstate the ledger.
- **Drawdown walks the closed trades in exit order**, because a realised equity curve
  is only defined at the moment each trade closes. The domain function sorts by exit
  time before walking, so the caller's ordering cannot change the answer.
- **Reward multiple is measured against the risk accepted at entry**
  (`|entry − stop| × quantity`), which is the only risk figure known without
  look-ahead.
- **A ratio with no data behind it stays `null`** and renders as an em dash. A zero
  win rate and an absent win rate are different facts, and profit factor is undefined
  — not infinite — when nothing has been lost yet.
- **Prediction activity is usage, not accuracy.** It counts the research predictions
  stored for a version. A realised hit rate needs each prediction's forward outcome,
  which the AI Predictions view reports per prediction; inventing an aggregate here
  would misrepresent the registry.
- **Holdout metrics are historical.** They describe how a version scored on one
  unseen period at training time. They are not a forecast or a guarantee.

## Dashboard behavior

Both views follow the existing `ResearchShell` shell, `GlassPanel` surfaces, and
`RequestStatePanel` loading, empty, and unavailable states.

- Trade History: filter bar, nine aggregate tiles, an exit-reason breakdown, and the
  chronological ledger with realised P&L, return, reward multiple, holding period,
  and exit trigger per row.
- Model Performance: filter bar, a model-family panel showing each family's
  production slot, a version leaderboard sorted newest-first, and a detail card for
  the selected version covering the promotion gate, validation protocol,
  hyperparameters, and recorded prediction activity.

Both dashboards write state only after a request resolves, so the previous result
stays on screen while a new filter loads instead of flashing a skeleton.

## Best practices

- Keep aggregation in pure domain functions. A metric that needs a database to be
  tested will not be tested.
- Ask for one row beyond the limit rather than issuing a `COUNT`, and tell the user
  when the view is truncated.
- Reject a record that cannot prove its own kind. The `simulatedOnly` and
  `researchOnly` markers are cheap and they keep a foreign payload off the screen.

## Common mistakes

- Mixing open positions into realised statistics.
- Computing drawdown in the order rows happened to arrive from the database.
- Rendering `0` where a statistic is simply unavailable.
- Exposing `artifact_uri` because it was convenient to select `*`.
- Presenting a stored prediction count as if it were the model's accuracy.

## Production considerations

- Both endpoints read indexed columns (`paper_trades.opened_at`,
  `model_versions.trained_at`) and cap their row counts, so a growing ledger cannot
  turn one dashboard load into a table scan of unbounded size.
- Prediction activity is two grouped aggregates over `model_predictions`, keyed by the
  existing `model_predictions_model_idx` index.
- If the ledger grows past a few thousand rows, add keyset pagination in the style of
  `/api/v1/model-predictions` rather than raising the limit.

## Assignments

1. Open several paper trades, let the evaluator close them, then reconcile the Trade
   History profit factor and expectancy by hand from the ledger rows.
2. Filter to `outcome=LOSS` and confirm the drawdown figure matches the worst
   peak-to-trough stretch of the realised curve.
3. Train two algorithms under one shared model key and use Model Performance to
   identify which one holds the production slot and by what margin.
4. Find the version with the largest training-to-validation gap and explain, from its
   hyperparameters, why it memorised.
