# Phase 7: explainable strategy engine

## Theory and purpose

A strategy turns already-calculated market evidence into a structured, testable trade *idea*. It does not predict with certainty, fill an order, authenticate with a broker, or execute a trade. Its purpose is to make a hypothesis explicit enough that later paper trading and backtesting can measure whether the hypothesis has merit.

`trend-breakout` version 1 is a deterministic trend-following setup. It requires trend alignment, momentum confirmation, a same-candle directional candlestick pattern, and a same-candle breakout or breakdown. The conjunction deliberately favors selectivity over the number of ideas generated. Its confidence score measures rule support, not the probability of profit.

The strategy supports both directions:

- A `LONG` idea follows an upside trend and bullish breakout evidence.
- A `SHORT` idea follows a downside trend and bearish breakdown evidence.

Every accepted idea carries an entry reference, stop loss, target, risk/reward, confidence, human-readable reasoning, and structured source evidence. That makes it possible to inspect and later audit why a given proposal existed.

## Architecture

```text
CLI -> NSE instrument lookup -> GenerateTradeIdeas (application use case)
                                      |
             +------------------------+------------------------+
             |                                                 |
             v                                                 v
PostgresStrategyVersionRepository            PostgresStrategyMarketContextRepository
ensure trend-breakout@1                      latest completed candle only
             |                                   +-- ta-v1 snapshots with exact parameters
             |                                   +-- candlestick-v1 detections
             |                                   +-- price-action-v2 events
             +------------------------+------------------------+
                                      |
                                      v
                       TrendBreakoutStrategy (pure rules)
                                      |
                                      v
                     proposed trade idea + ordered evidence
                                      |
                                      v
                       PostgresTradeIdeaRepository (transaction)
                                      |
                                      v
                  strategy_versions -> trade_ideas -> trade_idea_evidence
```

The pure strategy only receives an as-of-candle market snapshot and returns a proposal or a rejection. It has no SQL, HTTP, broker, clock, or order-routing dependency. The application layer is responsible for selecting the completed source candle, loading evidence with compatible versions, persisting an idea, and reporting the result.

## Folder structure

```text
apps/api/src/modules/strategy-engine/
  domain/
    strategy.ts                       # strategy input/output and evidence contracts
    trend-breakout-strategy.ts         # deterministic trend-breakout-v1 rules
  application/
    generate-trade-ideas.ts            # loading, timing, persistence orchestration

apps/api/src/infrastructure/database/repositories/
  postgres-strategy-market-context-repository.ts  # latest completed candle + same-candle evidence
  postgres-strategy-version-repository.ts  # stable strategy and immutable version lookup
  postgres-trade-idea-repository.ts    # proposal and ordered evidence persistence

apps/api/src/interfaces/cli/
  generate-trade-ideas.ts
```

The names outside the strategy module are infrastructure adapters. Domain and application code depend on repository interfaces, so rule tests can use in-memory fakes and do not require PostgreSQL, provider credentials, or market access.

## Database design

Phase 2 already provides the tables used by this phase:

```text
strategies
  strategy_key = "trend-breakout"              --> stable strategy identity
       |
       v
strategy_versions
  strategy_id + version = 1                    --> immutable rule/configuration identity
       |
       +------------------------------+
                                      |
                                      v
trade_ideas                            trade_idea_evidence
  strategy_version_id                  trade_idea_id + ordinal
  source_candle_id                     source type/reference/label/details
  side, entry, stop, target            --> auditable contributors in evaluation order
  risk_reward, confidence
  reasoning, evidence, expires_at
```

`trade_ideas.source_candle_id` establishes the exact completed candle that made the setup knowable. `reasoning` is a JSON array for the concise explanation shown to a user, while `evidence` and `trade_idea_evidence` retain structured facts such as source candle ID, indicator values, pattern codes, price-action codes/levels, and rule contributions.

A partial unique index on `(strategy_version_id, source_candle_id, side)` makes a retry of the same deterministic proposal idempotent. While an idea remains `PROPOSED`, a re-run can refresh its derived fields and ordered evidence in one transaction; once another workflow changes its status, the existing record is returned without overwriting that decision.

The database constraints protect the directional price geometry: a long stop must be below entry and target above it; a short stop must be above entry and target below it. They are a final safety net, not a substitute for validating the calculations in the domain rule.

## Deterministic `trend-breakout-v1` rule set

The strategy consumes only these versioned research outputs:

| Input | Required version | Requirement |
| --- | --- | --- |
| Technical indicators | `ta-v1` | Exact definitions: SMA(20), EMA(20), RSI(14, Wilder), MACD(12, 26, 9), ATR(14, Wilder), and Supertrend(10, 3) |
| Candlestick patterns | `candlestick-v1` | A current-candle detection whose persisted direction matches the proposed side |
| Price action | `price-action-v2` | A current-candle directional `BREAKOUT` or `BREAKDOWN` event |

The algorithm version alone is not enough to identify an indicator definition: one `ta-v1` implementation can have several parameter sets. `trend-breakout-v1` pins the exact definitions in the table above, so an EMA(50), RSI(7), alternate smoothing convention, or Supertrend with another multiplier is incompatible evidence even if it shares the `ta-v1` label. All criteria below are mandatory. Missing, non-finite, stale, differently versioned, differently parameterized, or directionally conflicting evidence produces no idea.

| Rule | Long proposal | Short proposal |
| --- | --- | --- |
| Price versus trend averages | Source close > EMA(20) and SMA(20) | Source close < EMA(20) and SMA(20) |
| Momentum band | RSI(14) from 52 through 70 | RSI(14) from 30 through 48 |
| MACD | Histogram > 0 | Histogram < 0 |
| Supertrend | `UP` | `DOWN` |
| Candlestick confirmation | Current source-candle pattern is `BULLISH` | Current source-candle pattern is `BEARISH` |
| Price-action confirmation | Current source-candle `BREAKOUT` is bullish | Current source-candle `BREAKDOWN` is bearish |
| Volatility regime (v2) | `LOW_VOL` | `HIGH_VOL` |
| Confidence gate | Computed score >= 0.70 | Computed score >= 0.70 |

### The volatility regime gate (v2)

Version 2 adds one gate. The regime is India VIX's close against its own SMA(20) at
`ta-v1`: above that average is `HIGH_VOL`, at or below is `LOW_VOL`. It is defined
relative to volatility's own recent average rather than an absolute level, because a
fixed threshold silently means something different in each era.

The VIX bar behind a regime must be complete, must have closed no later than the
source candle, and must be within five bars of it. Those three conditions are what
make the regime knowable at decision time and stop a gap in the VIX series from
carrying an old reading forward.

An unmeasurable regime is **unknown**, not calm. When no VIX bar qualifies, or its
average is missing, the field is absent rather than defaulted — reporting missing data
as `LOW_VOL` would let a gap in the series masquerade as a quiet market. What happens
next is the `requireRegime` configuration flag: `false` opens the gate when the regime
is unknown, `true` refuses the proposal. Because it is configuration rather than code,
the stored `strategy_versions.configuration` fully describes the decision rule.

An absent regime never discards the surrounding context. The source instrument's own
evidence remains valid research evidence, so a missing VIX series degrades this one
field instead of suppressing trade-idea generation and reporting it as a missing candle.

The regime is a gate, not a term in the confidence formula, so its evidence row records
a `null` contribution. Claiming a number there would over-attribute the computed score.

This is intentionally a rule *intersection*, not a weighted vote that lets a breakout override a missing trend or a strong RSI override a bearish Supertrend. The confidence score communicates how strongly the valid evidence supports the setup; it must never be presented as a calibrated chance of success until a separate, properly validated calibration study exists.

After all gates pass, v1 calculates a bounded score with the selected matching pattern and trigger:

```text
confidence = clamp(
  0.38
  + 0.30 * triggerConfidence
  + 0.22 * patternConfidence
  + 0.10 * min(1, abs(close - EMA20) / ATR14)
)
```

The fixed portion represents the required trend and momentum gates; the variable portion retains the detector strengths and the normalized distance from EMA. If several same-direction patterns or triggers qualify on the source candle, the engine uses the one with the highest persisted confidence. The result must still meet the configured `0.70` minimum.

## Risk, target, and expiry

ATR supplies a volatility-scaled initial stop. Let `E` be the source candle close used as the reference entry and `A` be ATR(14):

| Field | Long | Short |
| --- | --- | --- |
| Reference entry | `E` | `E` |
| Stop loss | `E - 1.5 * A` | `E + 1.5 * A` |
| Per-unit risk | `E - stop` | `stop - E` |
| Target | `E + 2 * risk` | `E - 2 * risk` |
| Nominal risk/reward | `2R` | `2R` |

The entry is rounded to the nearest valid instrument tick. The long stop rounds down to a tick and the short stop rounds up; targets round away from entry in the favorable direction. Therefore the stored risk/reward is recalculated from the rounded prices and can be slightly different from the nominal `2.0R`. The engine rejects a candidate if ATR is absent, non-positive, or creates invalid price geometry. An idea expires one requested timeframe after the source candle closes. For example, a daily-candle idea expires one day after that daily candle's close; an expiry means the setup is no longer fresh, not that it was filled or traded.

`entry_price` is a close-time reference price for research. It is **not** a claim that a later paper trade can fill at that price. Phase 8 must record an explicit paper-fill policy, including gaps, spread, fees, and next-candle/session timing.

## Completed-candle and no-look-ahead timing

The use case proposes an idea only after the source candle has finalized:

```text
T-1 completed inputs           T source candle closes             after close
--------------------           ----------------------             -----------
prior indicators/events   +--> calculate ta/pattern/event   +--> evaluate strategy
                           |    using only <= T candles       |    create proposal
                           +----------------------------------+    expiry = T + timeframe
```

The source candle may contribute its own finalized indicator snapshot, pattern detection, and breakout/breakdown event because those observations become known at its close. It may not consume a future candle, future corrected value, or a swing event backdated to its pivot. Phase 6 anchors a confirmed swing to its later confirmation candle; that event is usable only from that confirmation candle onward.

This timing rule is critical for a later backtest. A historical strategy run must reconstruct exactly what was available at each candle close, then apply an explicit next-bar or next-session fill assumption if it simulates a trade.

## Complete implementation and use

After importing completed history through the Phase 3 provider-specific workflow, complete the prerequisite analysis pipeline for the same instrument and timeframe:

```powershell
npm run analysis:calculate-indicators -- --instrument NIFTY50 --timeframe 1d
npm run analysis:detect-patterns -- --instrument NIFTY50 --timeframe 1d
npm run analysis:generate-trade-ideas -- --instrument NIFTY50 --timeframe 1d
```

The final command resolves the NSE instrument, selects its latest completed candle, registers or resolves `trend-breakout` version 2, loads only compatible `ta-v1`, `candlestick-v1`, and `price-action-v2` evidence for that as-of point, and evaluates the pure strategy. If every requirement passes, it persists a `PROPOSED` trade idea and ordered evidence rows. If any requirement fails, it reports that no proposal was generated rather than inventing defaults.

`trend-breakout` and version `2` are stored as the strategy identity fields. Its persisted configuration is deliberately explicit:

```json
{
  "indicatorAlgorithmVersion": "ta-v1",
  "indicatorParameters": {
    "EMA": { "period": 20 },
    "SMA": { "period": 20 },
    "RSI": { "period": 14, "smoothing": "WILDER" },
    "MACD": { "fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9 },
    "ATR": { "period": 14, "smoothing": "WILDER" },
    "SUPERTREND": { "atrPeriod": 10, "multiplier": 3 }
  },
  "candlestickAlgorithmVersion": "candlestick-v1",
  "priceActionAlgorithmVersion": "price-action-v2",
  "rsiLongMin": 52,
  "rsiLongMax": 70,
  "rsiShortMin": 30,
  "rsiShortMax": 48,
  "atrStopMultiple": 1.5,
  "rewardRiskMultiple": 2,
  "minimumConfidence": 0.7,
  "expiryCandles": 1,
  "requireRegime": false
}
```

Persisting this contract is what lets a later backtest, paper-trade record, or dashboard reproduce the same result without relying on the current source code alone.

## Reasoning and evidence

An explainable proposal should answer both "why was it created?" and "which exact records supported it?" A useful reasoning sequence is:

1. State the direction and source-candle close.
2. State the EMA/SMA, RSI, MACD histogram, and Supertrend conditions that passed.
3. Name the directional candlestick pattern detected on the source candle.
4. Name the matching breakout or breakdown event and its level/context.
5. Show the ATR-derived stop, 2R target, risk/reward, confidence, and expiry.

The durable evidence should retain source values and versioned references rather than duplicate only prose:

- `INDICATOR` evidence records the exact snapshot values and `ta-v1` references.
- `PATTERN` evidence records the selected pattern code, its `candlestick-v1` reference, confidence, context candle IDs, and rule details.
- `PRICE_ACTION` evidence records the selected breakout/breakdown code, level, confidence, details, and `price-action-v2` version.
- `STRATEGY` evidence records `trend-breakout` version 2, threshold values, entry, stop, target, confidence, and timing policy.

An explanation that cannot be traced to persisted evidence is a presentation, not an audit trail.

## Strategy versioning

`strategies.strategy_key` is the long-lived concept (`trend-breakout`). `strategy_versions.version` is the immutable research contract (`1`). Never modify version 1's thresholds, input versions, confidence policy, or timing semantics in place after it has generated ideas.

Create version 2 when changing any behavior that could alter an historical decision, for example changing the RSI bands, using a different MACD calculation, allowing prior-candle patterns, using a 1.25 ATR stop, or replacing the confidence calculation. Old trade ideas remain linked to version 1; new ideas and backtests point to version 2. This preserves a fair comparison and prevents silent research-history rewrites.

## Best practices

- Run indicator and pattern jobs after candle finalization and before strategy generation for the same instrument/timeframe.
- Treat missing compatible input as a rejection, not as zero, false, or a substitute from another algorithm version.
- Keep decimal storage at the persistence boundary and validate finite numeric values at the strategy boundary.
- Store the source candle, input definition versions and parameters, configuration, and individual evidence references with every idea.
- Test long, short, rejection, risk geometry, expiry, and no-look-ahead cases with deterministic fixtures.
- Evaluate the setup across different NSE instruments, market regimes, and out-of-sample periods before trusting its performance.

## Common mistakes

- Creating an idea from a provisional candle or using an indicator snapshot that will change before close.
- Reading a future candle, or using a swing as though it were known on its earlier pivot candle.
- Mixing `ta-v1` values with a different parameter set or a later pattern/price-action algorithm while labeling the result `trend-breakout-v1`.
- Treating a close-time reference entry as an executable fill, especially across overnight gaps.
- Dividing by a zero/negative ATR risk amount or persisting a stop/target on the wrong side of entry.
- Calling the confidence score a win probability without calibration and validation.
- Changing parameters under version 1 and thereby making old ideas irreproducible.

## Production considerations

For a watchlist, make strategy generation an idempotent, scheduled post-close job keyed by the instrument, timeframe, strategy version, and source candle. Use a transaction to persist the idea and its evidence together, emit metrics for evaluated/rejected/generated candidates, and alert on missing snapshots or unexpectedly sparse/dense output. Keep a run identifier and input-data freshness information so corrected candles can trigger a controlled recomputation.

Backtesting must use the same versioned rule and as-of timing, then model fills, gaps, fees, slippage, position sizing, and overlapping signals explicitly. Paper trading in the next phase should record an independently auditable fill lifecycle rather than treating a proposal as a trade. This project remains local, educational, and paper-trading-only: it does not contain broker authentication, order routing, or real-order execution.

## Assignment

1. Import enough completed daily history for NIFTY 50 to satisfy all indicator warm-ups, then run the prerequisite calculations and strategy command twice. Confirm why the second run does not create a second logical proposal for the same source candle/version.
2. Inspect one generated long or short idea. Trace each reasoning item to its indicator snapshot, pattern detection, or price-action event.
3. Verify by hand that the unrounded stop distance is 1.5 ATR and the unrounded target is 2R, then explain any small difference in the persisted risk/reward caused by tick rounding.
4. Create a fixture where every long rule passes except RSI is 71. Confirm the strategy rejects it and records no idea.
5. Describe a `trend-breakout` version 2 experiment that changes one threshold only. Explain how you would backtest it out of sample while preserving version 1 results.


