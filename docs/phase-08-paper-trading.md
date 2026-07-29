# Phase 8: deterministic paper-trading lifecycle

## Theory and purpose

Phase 7 creates a research *idea*: an as-of-completed-candle hypothesis with a reference entry, stop, target, evidence, and expiry. Phase 8 makes the next decision explicit: whether a local paper account accepts that idea and, if so, how a simulated trade is filled and later exited.

Paper trading is useful because it separates two questions that are often mistakenly blended together:

- Was the research signal available without looking into the future?
- Under a stated fill, gap, cost, and exit policy, how would that signal have performed?

The answer is only meaningful if the simulation is deterministic. A trade idea's close-time reference price is not silently treated as an executable fill. Opening a paper trade records a deliberately supplied local fill price, quantity, fees, slippage, and a simulation timestamp (explicitly supplied for replay or recorded as the current local time). Every lifecycle transition is retained as an event so a result can be reconstructed later.

## Hard safety boundary

This phase is **simulation only**. It creates local database records and performs local calculations. It does not contain or invoke:

- broker authentication or API credentials;
- order routing, exchange connectivity, broker SDK order methods, or an order-management system;
- live execution, funds movement, holdings changes, or real account access.

A command named `paper:trades:open` is an explicit local record of a hypothetical fill. It never submits an order. Treat all reported P/L and performance statistics as research outputs, not investment advice or a representation of achievable live execution.

## Architecture

```text
                       completed strategy evidence
                                    |
                                    v
trade_ideas (PROPOSED) --> OpenPaperTrade --> paper_trades (OPEN)
                               |                    |
                               |                    +--> OPENED event
                               v
                         explicit manual policy
                    fill price / size / time / costs

completed candles only --> EvaluateOpenPaperTrades --> exit decision
                                                     |  gap-at-open first
                                                     |  then stop-first conflict rule
                                                     v
                                            paper_trades (CLOSED)
                                                     |
                                                     +--> STOP_LOSS_HIT or TARGET_HIT event

paper_accounts + closed/open paper trades --> AccountPerformance --> local summary
```

The domain evaluator is pure: it receives an already-completed candle and an open paper trade, then returns either no action or a deterministic close decision. Application services select eligible data, enforce lifecycle rules, and persist a trade plus its immutable event atomically. PostgreSQL adapters own SQL; CLI adapters only parse explicit local inputs and print results.

## Folder structure

```text
apps/api/src/modules/paper-trading/
  domain/
    paper-trading.ts                  # account, trade, event, repository contracts
    paper-trade-exit-policy.ts        # pure completed-candle exit policy
    paper-account-metrics.ts          # realised performance calculations
  application/
    create-paper-account.ts           # local INR account creation
    open-paper-trade.ts               # accept an idea with an explicit simulated fill
    evaluate-open-paper-trades.ts     # scan completed candles and close eligible trades
    close-paper-trade.ts              # intentional local manual close
    get-paper-account-summary.ts      # account-level reporting

apps/api/src/infrastructure/database/repositories/
  postgres-paper-account-repository.ts
  postgres-paper-trade-repository.ts

apps/api/src/interfaces/cli/
  create-paper-account.ts
  open-paper-trade.ts
  evaluate-paper-trades.ts
  get-paper-account-summary.ts
```

The application and domain layers depend on repository interfaces, not PostgreSQL or a market-data provider. That makes it practical to test account creation, fills, exit order, P/L, and performance metrics with tiny deterministic fixtures.

## Database design and audit trail

Phase 2 supplies the lifecycle tables; Phase 8 gives them strict semantics.

```text
paper_accounts
  id, name, opening_balance, currency=INR, is_active
       |
       +-------------------------+
                                 |
                                 v
trade_ideas (optional source) -> paper_trades
                                  account, instrument, side, quantity
                                  entry / stop / target / timestamps
                                  status, exit, realised P/L, fees, slippage
                                               |
                                               v
                                      paper_trade_events
                                      OPENED / STOP_LOSS_HIT / TARGET_HIT
                                      MANUALLY_CLOSED / CANCELLED
                                      price, quantity, occurred_at, details
```

`paper_accounts` is deliberately INR-only in this first lifecycle. `opening_balance` is the initial simulated capital, not a broker balance. An account must be active before it can accept a new paper trade.

`paper_trades` carries the durable economic state. It links to the source trade idea when one exists, retains the instrument and side, stores the actual simulated entry rather than overwriting it with the idea's reference price, and preserves the initial protective stop and target. A trade is either `OPEN`, `CLOSED`, or `CANCELLED`; only a closed trade has a closed timestamp, exit price, exit reason, and realised P/L. Directional constraints keep a long stop below entry and target above it, with the inverse geometry for a short.

`paper_trade_events` is the chronological explanation layer. The opening event records the explicit manual-fill policy and inputs. An automatic exit event records the evaluated candle, applicable price path assumption, trigger, costs, and calculated P/L. Events are append-only history rather than a mutable substitute for the trade's current state.

Opening locks a still-`PROPOSED` idea and changes it to `ACCEPTED` in the same transaction as the paper trade and `OPENED` event. A retry therefore cannot quietly open a second position from that idea. The per-account trade-idea uniqueness constraint is a second database-level guard against duplicate state.

## Explicit manual fill policy

Opening a paper trade is a conscious simulation decision. The local operator must specify all material assumptions rather than inheriting invisible defaults:

| Input | Meaning |
| --- | --- |
| Account | The active local INR paper account that owns the simulated position. |
| Trade idea | A `PROPOSED` idea that had not expired at the simulated open time; its instrument, side, stop, and target supply the risk geometry. |
| Quantity | Positive simulated units. Position sizing is explicit; this phase does not infer it from confidence. |
| Fill price | The actual simulated entry price, supplied locally and never sent anywhere. It may differ from the strategy's reference close. |
| Open time | An optional explicit simulation timestamp at which the fill becomes knowable; when omitted, the local command records the current time. |
| Entry fees and slippage | Explicit INR costs retained for audit and deducted from net performance. |
| Notes | Optional local rationale, such as a chosen spread or next-session-open assumption. |

The policy is named `MANUAL_EXPLICIT`: it neither fetches an unverified quote nor asserts that a broker could have filled the order. A proposal is marked accepted only as part of successfully recording its associated paper trade. A rejected, expired-at-the-simulated-open-time, or already accepted proposal cannot become an open simulated position through this path.

For conservative cash capacity, an open position reserves its entry notional plus already-known entry costs. That rule applies to both long and short paper positions in this initial no-leverage model; it prevents a short position from being treated as free buying power just because its sale proceeds are hypothetical.

## Completed-candle exit evaluator

The evaluator reads only `is_complete = true` candles whose opening time is at or after the simulated entry timestamp and whose close is at or before the evaluation's as-of timestamp. It therefore skips a candle already under way when a fill is recorded. In particular, an idea created after source candle `T` closes cannot use `T`'s high or low to claim an intrabar exit. Its first automatic exit opportunity is a later eligible completed candle. This is the no-look-ahead boundary for paper-trade management.

For each eligible OHLC candle, the evaluator applies this deterministic ordering:

1. Check the candle open for a gap through the stop or target. This has precedence because the opening price is the first price represented by the bar.
2. If there was no gap decision, inspect the bar high and low for stop and target touches.
3. If both levels were reachable inside the same bar, close at the stop. OHLC data cannot tell which level was hit first, so the conservative stop-first rule avoids granting an optimistic target.
4. If only one level was touched, close at that level; otherwise leave the trade open.

| Side | Gap-at-open stop | Gap-at-open target | Same-bar conflict after an in-range open |
| --- | --- | --- | --- |
| Long | `open <= stop`: exit at `open`, reason `STOP_LOSS` | `open >= target`: exit at `open`, reason `TARGET` | If `low <= stop` and `high >= target`, exit at `stop` |
| Short | `open >= stop`: exit at `open`, reason `STOP_LOSS` | `open <= target`: exit at `open`, reason `TARGET` | If `high >= stop` and `low <= target`, exit at `stop` |

The gap price can be worse than the configured stop; this is intentional. A stop is not a guarantee of a fill at its level when the market has already opened beyond it. Conversely, a favorable gap reaches the target at the opening price, not an invented better intrabar price. The evaluator does not manufacture a tick-by-tick path from OHLC data.

Example: a long opens at 100, has a stop at 95 and target at 110. A later candle opens at 93, high 101, low 92, close 99. It exits at 93 for a stop-loss because gap-at-open precedence applies. If instead it opens at 100, trades from 94 to 111, and closes at 103, both thresholds are visible but their order is unknown; it exits at 95 under the conservative stop-first policy.

## Fees, slippage, and realised P/L

All monetary fields are stored and calculated as decimal INR values at persistence boundaries. Do not use binary floating point for durable currency values.

Let `Q` be quantity, `E` entry price, `X` exit price, `F` total entry plus exit fees, and `S` total entry plus exit simulated slippage costs. The effective fill prices are the explicit prices stored on the trade; `S` is additionally retained as a separately auditable INR cost and is not counted twice by changing those stored prices again.

| Side | Gross P/L | Net realised P/L |
| --- | --- | --- |
| Long | `(X - E) * Q` | `gross - F - S` |
| Short | `(E - X) * Q` | `gross - F - S` |

Entry costs are accumulated when the trade is opened. Exit costs are accumulated when the evaluator or a manual close records the exit. A profitable gross trade can therefore be a net loss after realistic simulated costs. The closing event must include the source of the exit, price, quantity, fee/slippage components, and rule details so a summary total can be traced to individual fills.

## Performance metrics

Account summaries distinguish realised information from open-position exposure. They should report at least:

- opening balance and available capital;
- counts of open, closed, and winning trades;
- net realised P/L, total fees, and total simulated slippage;
- win rate: profitable closed trades divided by closed trades (reported as `0` when no trades have closed);
- average realised reward: each closed trade's net P/L divided by its initial stop risk, when that risk is positive;
- realised equity: opening balance plus cumulative net realised P/L in deterministic close order;
- maximum realised drawdown percentage: the largest peak-to-trough decline in that realised equity series.

Available capital is not a broker cash balance and does not mark open positions to market. It is a conservative simulation capacity: opening balance plus realised net P/L, less notional and costs reserved by open trades. Unrealised P/L, margin rules, borrow availability, corporate actions, taxes, financing, and partial fills are intentionally outside this first paper-trading policy.

## Complete workflow

Start the local database and apply the schema before using the commands:

```powershell
npm run db:migrate
```

Create an INR paper account:

```powershell
npm run paper:accounts:create -- --name "Learning INR" --opening-balance 100000
```

Generate a valid Phase 7 proposal first, then accept one using an explicit simulated fill. Supply the account, trade-idea ID, quantity, entry fill, timestamp, and cost assumptions required by the command; do not substitute the strategy reference entry without deciding that it is your chosen fill assumption.

```powershell
npm run paper:trades:open -- --account "Learning INR" --idea <idea-id> --quantity 10 --fill-price 123.45 --fees 0 --slippage 0
```

Append `--opened-at 2026-07-26T09:15:00Z` when replaying a known historical simulation time.

After later candles have finalized, evaluate the account's open trades. `--as-of` is optional; when supplied it makes the historical cutoff explicit.

```powershell
npm run paper:trades:evaluate -- --account "Learning INR" --exit-fees 0 --exit-slippage 0
```

Append `--as-of 2026-07-26T15:30:00Z` to reproduce a historical cutoff.

An intentional local manual close is also available. It records a `MANUALLY_CLOSED` event; it is not a broker action.

```powershell
npm run paper:trades:close -- --trade <paper-trade-id> --price 123.45 --fees 0 --slippage 0
```

`--closed-at` and `--notes` are optional explicit timestamp and audit-note inputs for that local action.

Inspect realised results and remaining conservative capacity:

```powershell
npm run paper:accounts:summary -- --account "Learning INR"
```

The command names are intentionally separate. Creating an idea does not open a trade; opening a trade does not immediately evaluate an unknown future candle; evaluating a trade does not silently change its risk policy. Re-running an evaluation with no newer eligible completed candles should not create duplicate exit events or close an already closed trade again.

## Best practices

- Keep the strategy proposal, chosen fill inputs, candle IDs/times, and every event together in an auditable record.
- Use a single explicit timezone convention (UTC timestamps in storage) and preserve NSE-session context in display/reporting layers.
- Evaluate only final candles and run the evaluator after candle finalization, never from a provisional live bar.
- Treat gaps and same-bar ambiguity conservatively; document any future alternate policy as a new, versioned research assumption.
- Use positive quantities, finite prices, non-negative costs, valid directional stop/target geometry, and an active account.
- Keep fees and slippage visible in both trade detail and account totals; never turn them into hidden strategy adjustments.
- Test long and short trades, favorable/adverse gaps, single-level hits, same-bar conflicts, costs, idempotent retries, and an empty account summary.

## Common mistakes

- Treating `trade_ideas.entry_price` as proof of a tradable fill rather than supplying a paper-fill assumption.
- Closing a trade using the same source candle that created the idea, or any provisional/future-observed market data.
- Filling an overnight stop at the stop level after the next candle already opened far beyond it.
- Crediting a target whenever both stop and target appear in one OHLC candle without a path-order assumption.
- Double-counting slippage by both worsening the stored fill and subtracting the same amount again as a cost.
- Comparing gross P/L from one run with net P/L from another, or presenting win rate when there are no closed trades.
- Allowing retries to create multiple trades/events for the same accepted idea in one account.
- Calling simulated balance, P/L, or capacity a live broker balance, execution report, or investment recommendation.

## Production considerations

For a larger watchlist, execute account/trade mutations inside short transactions with row-level protection around an open trade. Use a durable idempotency key for operator actions, record the evaluator version and policy inputs in event details, and emit metrics for skipped candles, gap exits, same-bar conflicts, failed validations, and close latency. Schedule evaluation only after the data pipeline marks candles final; retain the exact candle version or ingestion provenance if corrections are possible.

A production-quality research system should also separate roles that can create accounts, accept ideas, edit configuration, and inspect results. Encrypt or avoid sensitive notes, back up the local database, use decimal-safe reporting, make all timestamps explicit, and alert when an account approaches its conservative available-capital limit. Adding broker connectivity later would be a separate, security-reviewed product with entirely different authorization, controls, and user consent; it is not an extension of this phase.

## Assignment

1. Create an INR account with a fixed opening balance, open one long and one short paper trade from eligible ideas, and write down the fill, fee, and slippage assumptions for each.
2. Construct a long-trade fixture whose next completed candle gaps below its stop. Verify that the recorded exit price is the opening price, not the stop price, and calculate gross and net P/L by hand.
3. Construct a short-trade fixture whose completed candle reaches both its target and stop after opening between them. Explain why the recorded exit is the stop under this policy.
4. Re-run the exit evaluator after a trade is closed. Confirm that it produces no second closing event and that account totals do not change.
5. Compare two otherwise identical paper trades: one with zero costs and one with fees/slippage. Explain the effect on available capital, net P/L, win rate, and realised drawdown.
6. Describe one alternate fill or intrabar policy you would like to study. Explain why it must be versioned and compared out of sample rather than silently replacing the conservative policy.
