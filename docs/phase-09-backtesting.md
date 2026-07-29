# Phase 9: reproducible historical backtesting

## Theory and purpose

A backtest is a chronological simulation of a strategy under rules that could have been followed at the time. It answers a narrower and more useful question than â€œwould this chart have made money?â€:

> Given only the completed information available at each point, a stated next-bar fill rule, finite capital, and stated costs, how would this exact strategy have behaved over this data window?

Phase 9 reuses the Phase 7 `trend-breakout` version 1 hypothesis. It does not turn that hypothesis into a prediction, a broker order, or evidence that a future result is achievable. Its job is to make the historical experiment repeatable: the strategy version, candles, date window, execution assumptions, capital, sizing, and results are stored together.

This separation matters. A strategy can look attractive when its source-candle close is silently treated as an executable entry, when later bars are used to confirm an earlier decision, or when every overlapping signal is allowed to use the same capital. The backtest engine instead models the sequence explicitly.

## Hard safety boundary

This phase is local research simulation only. It does not authenticate to a broker, submit an order, move money, inspect a real portfolio, or claim that a simulated fill was available in a live market. A backtest result is neither investment advice nor a guarantee of performance.

## Architecture

```text
completed historical candles + versioned research evidence
                         |
                         v
              RunBacktest application use case
                         |
        +----------------+------------------+
        |                                   |
        v                                   v
modules/backtesting/infrastructure/    strategy version lookup
PostgresBacktestMarketDataRepository   trend-breakout@1
chronological, completed-only context
        |                                   |
        +--------------+--------------------+
                       v
             BacktestEngine (pure replay)
                       |
   signal at close --> pending next-open entry --> one active position
                       |                              |
                       v                              v
                 invalid gap skip              conservative OHLC exit policy
                       |                              |
                       +--------------+---------------+
                                      v
                           metrics + monthly grouping
                                      |
                                      v
     backtest_runs -> backtest_run_instruments -> backtest_trades
                                      |
                                      v
                      backtest_monthly_performance
```

The engine is deterministic domain logic. It receives ordered completed market context and a run configuration, then returns simulated trades, monthly observations, and summary metrics. The application layer resolves the NSE instrument and immutable strategy version, validates the time window, persists run state, and reports the result. PostgreSQL adapters own SQL; the CLI only parses a local research request and prints the outcome.

## Folder structure

```text
apps/api/src/modules/backtesting/
  domain/
    backtesting.ts                         # run, configuration, trade, and repository contracts
    backtest-engine.ts                     # chronological, no-look-ahead simulation
    backtest-metrics.ts                    # summary, equity, drawdown, and monthly metrics
  application/
    run-backtest.ts                        # validation, loading, replay, and persistence orchestration

  infrastructure/
    postgres-backtest-market-data-repository.ts  # completed historical context for each as-of candle
    postgres-backtest-repository.ts              # run, trade, and monthly-performance persistence

apps/api/src/interfaces/cli/
  run-backtest.ts
```

The domain and application layers depend on repository contracts rather than PostgreSQL, HTTP, a clock, or a broker. Small in-memory fixtures can therefore test entries, gap rejection, exits, capacity, and drawdown without a database or market-data provider.

## Database design and reproducibility record

Phase 2 already provides the durable backtesting tables.

```text
strategies -> strategy_versions (trend-breakout, version 1)
                         |
                         v
                    backtest_runs
       run status, timeframe, data window/cutoff, engine version
       configuration JSON, metrics JSON, timestamps/error
                         |
          +--------------+-------------------+
          |                                  |
          v                                  v
backtest_run_instruments                backtest_trades
run + instrument                         executed entry/exit, quantity,
                                         net P/L, return, exit reason, reasoning
                                                  |
                                                  v
                                   backtest_monthly_performance
                                   exits grouped by calendar month
```

`backtest_runs` is the experiment header. It records the immutable `strategy_version_id`, timeframe, requested data window, `data_cutoff_at`, engine version, configuration, status, and calculated metrics. The configuration must preserve the full execution policy: fixed quantity, initial capital, maximum position count, fee amount, slippage rate, next-candle-open rule, invalid-gap rule, and the stop/target conflict rule. A result without those inputs is not reproducible.

`backtest_run_instruments` makes the tested universe explicit. The Phase 9 CLI currently runs one NSE instrument at a time, but the relationship prevents a later multi-instrument run from having an ambiguous universe.

Each `backtest_trades` row is one actually simulated position, not every detected signal. It stores the executed entry and exit times/prices, side, fixed quantity, net P/L, return, exit reason, and structured reasoning. The reasoning should retain the source-candle identity and strategy evidence so a trade can be traced back to the exact historical setup. A skipped setup is not represented as a profitable or losing trade.

`backtest_monthly_performance` stores exit-month aggregates: trade count, winning count, gross profit, gross loss, net P/L, and maximum drawdown percentage. `month_start` is the first day of the exit month, making grouping stable across reports.

`data_cutoff_at` is the persisted-data revision cutoff: it records the latest historical point/version eligible for the experiment, rather than merely the date printed in a report. No future candle is passed to the strategy signal, and no evidence produced after the cutoff may be used to justify an earlier decision. For audit-grade historical research, also retain raw-data provenance or a content hash outside this first schema; a timestamp alone cannot prove that a provider never revised an old candle.

## Reusing `trend-breakout` version 1

The backtest does not invent a separate historical strategy. It uses the same `trend-breakout@1` rule contract from Phase 7:

- completed-candle SMA(20), EMA(20), RSI(14), MACD(12, 26, 9), ATR(14), and Supertrend(10, 3) evidence from `ta-v1`;
- same-candle directional candlestick confirmation from `candlestick-v1`;
- same-candle directional `BREAKOUT` or `BREAKDOWN` confirmation from `price-action-v2`;
- the Phase 7 confidence gate and ATR-derived stop/target geometry.

The run evaluates that rule **as of each historical candle close**. Its analytical evidence must already have been precomputed and persisted for the same instrument/timeframe; the replay reads only the compatible historical context that was available at that point. It must not replay trade ideas generated today, use a later â€œlatestâ€ snapshot, substitute an indicator with different parameters, or backdate a swing event to its pivot. A swing is available only on its later confirmation candle, exactly as described in Phase 6.

If precomputed indicator evidence is unavailable because its warm-up history was insufficient, or if any other required compatible evidence is missing, that candle creates no signal. The runner does not fill missing data with a future value or loosen a gate to make the test produce more trades.

## No-look-ahead replay sequence

For every ordered, final candle `T`, the engine applies this timeline:

| Time in the simulation | Information/action permitted |
| --- | --- |
| Before `T` closes | Only evidence from candles before `T` is known. No rule may use `T`â€™s close, high, or low yet. |
| After `T` has finalized | Calculate/read compatible evidence using candles through `T`, evaluate `trend-breakout@1`, and, if eligible, create a pending simulated entry. The proposal is known at `T`â€™s close, not during its bar. |
| Open of `T+1` | Attempt the pending entry using **only** `T+1.open`. Validate the source stop/target gap bounds, capacity, and one-position policy before filling. |
| After `T+1` has finalized | If filled at its open, its high/low can now be evaluated for a stop/target exit. Later active positions are evaluated only after each later candle finalizes. |
| Final candle in the requested data window | Apply any stop/target decision first. If the position remains open, close it at that final completed candleâ€™s close with `END_OF_DATA`. |

This permits an entry and exit on `T+1`: the strategy was known at `T`â€™s close, the position existed from `T+1`â€™s open, and the OHLC range became observable only when `T+1` completed. It does not permit a fill at `T.close`, a stop/target result from a candle before the entry, or a signal based on future data.

A signal on the final requested candle has no next candle open within the experiment. It remains unfilled and does not become a fabricated trade.

## Entry, invalid-gap, capacity, and sizing policy

### Next-candle-open fills

The source candleâ€™s Phase 7 entry is a research reference, not an execution claim. A valid backtest fill occurs at the next completed candleâ€™s opening price, adjusted for configured adverse slippage. The source stop and target remain the tradeâ€™s initial protective geometry; they are not recalculated to make a gap look more favorable.

### Invalid-gap skip policy

The next open may mean the original setup was already invalid before it could be entered. Rather than retroactively entering and immediately declaring a win or loss, v1 skips that signal when the next open has crossed either source boundary:

| Side | Skip the pending signal when next open isâ€¦ |
| --- | --- |
| Long | `<= source stop` or `>= source target` |
| Short | `>= source stop` or `<= source target` |

Other in-range gaps may fill at their actual opening price. A skip creates no position, consumes no capital, and incurs no fee or slippage. The condition and source price levels belong in the persisted run configuration/reasoning so results do not disguise skipped opportunities as zero-return trades.

### One-position and fixed-quantity policy

The runner permits at most **one open or pending position per instrument per run**. There is no pyramiding, averaging in, hedging, reversal, or simultaneous reuse of capital. Signals that appear while a position is pending or open are ignored by this v1 policy.

`--quantity` is a fixed positive quantity for every eligible fill; it is not a confidence-weighted position size. Before a new entry, the engine checks conservative capacity using the requested initial capital, realised net P/L, and the entry notional plus its known entry fee. It reserves capacity for a short position as well, rather than treating hypothetical short proceeds as free buying power. If capacity is insufficient, the signal is skipped. This makes a comparison between runs meaningful: a higher trade count cannot be purchased by silently borrowing or scaling positions.

The default configuration is quantity `1`, initial capital `100000` INR, and a maximum of one position. All are persisted with the run and can be made explicit on the CLI.

## Fees and slippage assumptions

The baseline is intentionally frictionless but not hidden:

| Assumption | Default | Meaning |
| --- | ---: | --- |
| `feePerOrder` | `0` INR | A fixed fee applied once on entry and once on exit. |
| `slippageBps` | `0` basis points | Adverse fill adjustment applied to each executed price. |

Both assumptions are part of the saved configuration and can be overridden for a more conservative study. Let `r = slippageBps / 10,000` and let `P` be the observed eligible price. Slippage is adverse by direction:

| Fill | Executed price |
| --- | --- |
| Long entry | `P * (1 + r)` |
| Long exit | `P * (1 - r)` |
| Short entry | `P * (1 - r)` |
| Short exit | `P * (1 + r)` |

For quantity `Q`, entry price `E`, exit price `X`, and one fee `F` per order:

| Side | Gross P/L | Net P/L persisted for the trade |
| --- | --- | --- |
| Long | `(X - E) * Q` | `gross - 2F` |
| Short | `(E - X) * Q` | `gross - 2F` |

Slippage is already reflected in the executed prices above and must not be deducted a second time as a separate cash cost. Fees are charged only for an actual entry or exit; an invalid/capacity-skipped signal pays neither. Production research should replace zero-cost assumptions with documented, instrument-appropriate brokerage, taxes, spread, market-impact, and financing models, all versioned with the run.

## Completed-candle exit policy

The runner uses the Phase 8 conservative OHLC policy for every active position:

1. Inspect the completed candleâ€™s open first. A gap through stop or target exits at the opening price because it is the first represented price.
2. When the open is between the levels, inspect the candle high and low for stop/target touches.
3. If both thresholds were reachable in the same candle, exit at the stop. OHLC data does not reveal the intrabar order, so stop-first avoids an optimistic target assumption.
4. If exactly one threshold was reached, exit at that threshold; otherwise carry the position forward.

| Side | Gap stop | Gap target | Same-candle conflict after an in-range open |
| --- | --- | --- | --- |
| Long | `open <= stop`, exit at `open` | `open >= target`, exit at `open` | If `low <= stop` and `high >= target`, exit at `stop` |
| Short | `open >= stop`, exit at `open` | `open <= target`, exit at `open` | If `high >= stop` and `low <= target`, exit at `stop` |

The current v1 replay has no unstated discretionary or opposite-signal exit. It keeps an open trade until its protective stop, target, or the end of the requested data window. The schemaâ€™s `SIGNAL` exit reason is reserved for a future, explicitly versioned exit policy.

If a position survives the final candleâ€™s normal stop/target evaluation, the engine closes it at that completed candleâ€™s close and records `END_OF_DATA`. This avoids mixing an unmarked open position with realised performance and makes every run comparable at its declared endpoint. It is a reporting convention, not proof that a real order could have filled at the final close.

## Metrics and monthly performance

Metrics are calculated from trades in deterministic exit-time order. At minimum, a completed run should make these values visible:

- total, winning, and losing trade counts;
- win rate: winning closed trades divided by total closed trades (zero when no trade closed);
- gross profit, gross loss, and net P/L after configured costs;
- return on initial capital;
- profit factor: gross profit divided by absolute gross loss, reported as unavailable rather than infinity when there are no losses;
- expectancy per trade: net P/L divided by closed trades, reported as zero/no-data consistently for an empty run;
- realised equity: initial capital plus cumulative net P/L;
- maximum realised drawdown: the largest peak-to-trough percentage decline in that realised equity series.

Monthly rows group each closed trade by its `exit_time` calendar month. They show whether the aggregate result depends on one period, while avoiding the false precision of a daily marked-to-market equity curve that this first engine does not model. An `END_OF_DATA` closure belongs to the final windowâ€™s month.

Metrics compare configurations; they do not validate a strategy. Small sample sizes, a few concentrated trades, omitted costs, selection bias, parameter tuning on the same window, survivorship bias in the instrument list, dividends/corporate actions, and imperfect historical candles can all make a result misleading.

## Complete workflow

First ensure the local schema, the intended completed historical candles, and the Phase 5/6 analysis outputs exist for the same instrument/timeframe. Phase 7 documents the compatible `trend-breakout@1` evidence contract.

```powershell
npm run db:migrate
npm run analysis:calculate-indicators -- --instrument NIFTY50 --timeframe 1d
npm run analysis:detect-patterns -- --instrument NIFTY50 --timeframe 1d
```

Run a single-instrument historical experiment with explicit window, quantity, and capital:

```powershell
npm run backtest:run -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2025-01-01 --quantity 1 --initial-capital 100000
```

The baseline values can be made explicit (and overridden for a sensitivity study):

```powershell
npm run backtest:run -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2025-01-01 --quantity 1 --initial-capital 100000 --fee-per-order 0 --slippage-bps 0
```

`--from` and `--to` accept `YYYY-MM-DD` or ISO-8601 timestamps. For a fully repeatable stored-data snapshot, optionally supply `--data-cutoff-at 2025-01-02T00:00:00.000Z`; otherwise the command records its current timestamp as the revision cutoff. The saved execution configuration names the next-open entry, invalid-gap rejection, conservative stop-first exit, and final-candle-close policies in addition to quantity, capital, fees, and slippage.

The command resolves the NSE instrument, loads only completed candle contexts in the requested period, and uses their already-persisted analytical evidence (which must have been precomputed with any required warm-up). It then creates a `RUNNING` record, replays chronologically, writes the trades/monthly rows/metrics, and marks the run `COMPLETED` or `FAILED` with an error message. Re-running the command creates a new experiment rather than overwriting an earlier result, because a changed data import or assumption deserves a separately auditable run.

Use explicit non-zero fee and slippage options when comparing realistic assumptions; keep the resulting configuration alongside the output. Do not compare a frictionless run with a cost-inclusive run as if they measured the same strategy conditions.

## Best practices

- Treat every run as an experiment with a named strategy version, fixed window, source provenance, and immutable execution assumptions.
- Keep strategy development, parameter selection, and evaluation windows separate. Use an out-of-sample period that did not guide rule selection.
- Use final candles only, sort them chronologically, and reject duplicate/non-monotonic timestamps before replay.
- Precompute indicators with adequate warm-up history, while replaying only requested-test-window contexts and never allowing a trade before that window is eligible.
- Test long and short fills, invalid gaps, in-range gaps, capacity rejection, same-bar stop/target collisions, end-of-data closes, empty runs, and runs with no losses.
- Repeat a run with known synthetic candles and assert the exact trade sequence, cash path, exit reasons, P/L, drawdown, and monthly totals.
- Report the zero-cost baseline as a modelling baseline, then run cost and slippage sensitivity analyses instead of presenting it as executable performance.

## Common mistakes

- Filling at the signal candleâ€™s close even though the signal was only known after that close.
- Using a later indicator snapshot, future swing confirmation, corrected value, or current trade idea to decide an earlier historical trade.
- Entering after the next open is already outside the source stop/target and calling the immediate result a normal trade.
- Letting every signal open a position while another position is active, or reusing the same capital across simultaneous trades.
- Repricing the original stop/target after a gap to preserve a desired risk/reward ratio.
- Awarding a target whenever both stop and target occur in one OHLC candle.
- Charging slippage in adverse fills and then subtracting the same slippage as another fee.
- Treating `END_OF_DATA` close P/L as a live liquidation guarantee.
- Optimising thresholds, fees, or date windows until this one backtest looks best, then presenting it as out-of-sample evidence.

## Production considerations

A larger research platform should snapshot raw candle provenance, adjustment policy, instrument universe, strategy source/configuration hash, engine version, and all configuration values with each run. Treat provider corrections as new data versions rather than silently mutating reproducibility. Add idempotency and short transactions around run-state updates; write trades and metrics atomically only after a successful replay, and retain failed-run diagnostics without partially labelling results as complete.

For large universes, stream ordered candles in bounded batches, partition work by instrument/run, and preserve a deterministic event order. Add structured telemetry for skipped signals, missing evidence, capacity rejections, gap exits, same-candle conflicts, and runtime. Validate decimal arithmetic, timestamps, session calendars, corporate-action handling, delistings, trading halts, tick sizes, and exchange holidays before extending the study to more instruments or intraday data.

Finally, use walk-forward evaluation, multiple market regimes, sensitivity tests, and an untouched final holdout. A backtest system should make it easier to disprove a strategy, not merely easier to produce a compelling chart.

## Assignment

1. Run the supplied daily NIFTY50 experiment and record the run ID, strategy version, window, trade count, net P/L, win rate, profit factor, and maximum drawdown.
2. Build a five-candle fixture where a valid long signal occurs at candle `T`, then `T+1.open` is below the source stop. Verify that no trade is opened and no cost is charged.
3. Build a long fixture where an in-range next open fills a position and the same completed candle reaches both stop and target. Show why the recorded exit is the stop.
4. Run the same fixture with `feePerOrder = 0` / `slippageBps = 0` and with non-zero values. Calculate by hand how each adverse fill and each fee changes net P/L.
5. Create two qualifying signals while the first trade remains open. Verify that the second is ignored under the one-position policy, then explain what additional risk controls a multi-position version would require.
6. Compare an in-sample period with a later untouched period. Explain why a higher in-sample return alone is not enough to promote a strategy or model.

