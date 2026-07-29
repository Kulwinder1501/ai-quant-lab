# Phase 6: deterministic pattern recognition

## Theory and purpose

Candlestick patterns and price action turn completed OHLCV history into named, inspectable market observations. They are not predictions, entry instructions, or a substitute for risk management. In AI Quant Lab, their purpose is to provide reproducible evidence that later strategies, backtests, paper-trading workflows, and ML experiments can evaluate.

The candlestick engine recognises deterministic, textbook-inspired shapes and sequences:

- doji, hammer, hanging man, and shooting star
- bullish/bearish engulfing and bullish/bearish harami
- morning star and evening star
- three white soldiers and three black crows
- inside bar and outside bar

The price-action engine records trend state, range state, breakouts, breakdowns, pullbacks, confirmed swing highs/lows, and the support/resistance levels derived from those swings. Each rule has an explicit lookback and threshold, so a result can be reproduced from the same completed candle series.

## Architecture

```text
completed candles only
        |
        v
DetectMarketPatterns (application use case)
        |
        +--> CandlestickPatternEngine (pure deterministic rules)
        |       |
        |       +--> pattern_definitions (candlestick-v1)
        |       +--> pattern_detections (context + explanation)
        |
        +--> PriceActionEngine (pure deterministic rules)
                |
                +--> price_action_events (price-action-v2)

CLI -> instrument lookup -> completed-candle repository -> use case
```

The two engines have no database, provider, HTTP, or broker dependency. The application layer translates persisted decimal candles into finite numbers at the calculation boundary, invokes the engines, and uses repositories to persist their evidence.

## Folder structure

```text
apps/api/src/modules/pattern-recognition/
  domain/market-pattern.ts
  domain/candlestick-pattern-engine.ts
  domain/price-action-engine.ts
  application/detect-market-patterns.ts
apps/api/src/infrastructure/database/repositories/
  postgres-pattern-definition-repository.ts
  postgres-pattern-detection-repository.ts
  postgres-price-action-event-repository.ts
apps/api/src/interfaces/cli/
  detect-market-patterns.ts
```

## Database design

Phase 2 already created the persistence model used here:

```text
pattern_definitions
  pattern_code + algorithm_version     --> a versioned candlestick-rule identity
                    |
                    v
pattern_detections
  candle_id + pattern_definition_id    --> idempotent detected pattern
  context_candle_ids + details         --> evidence and explainability

price_action_events
  candle_id + event_type + algorithm_version
                                       --> idempotent, versioned price-action evidence
```

`pattern_definitions` stores candlestick definitions with the `CANDLESTICK` category. Price-action events use their own table because a swing, level, or breakout carries a numeric level and does not map cleanly to a single candlestick-pattern definition.

Re-running the same algorithm version updates the same evidence row. Changing a rule, threshold, or interpretation must create a new version (for example, `candlestick-v2` or `price-action-v2`) instead of silently revising research history.

## Rules and confirmation timing

| Observation | Default rule | Event time |
| --- | --- | --- |
| Candlestick shape/sequence | Explicit candle-body, shadow, containment, and trend-context thresholds | The close of the final pattern candle |
| Trend / range | 20-candle close change of at least 1 unit up or down | The current completed candle |
| Breakout / breakdown | Close crosses the highest high / lowest low of the prior 20 candles by a 0.1-unit buffer, and the previous close had not already crossed its own prior-20 barrier | The crossing candle close |
| Pullback | In a detected trend, close crosses 2 units back from the recent 10-candle extreme | The crossing candle close |
| Swing high / low | Pivot exceeds (or is below) its two neighbours on each side | The second future confirmation candle closes |
| Resistance / support | A confirmed swing high / low; distinct touches use a 0.3-unit tolerance | The same confirmation candle |

### Distance units and timeframes

Every distance threshold is a count of **units**, and `thresholdMode` decides what one
unit is:

| Mode | One unit is | Use for |
| --- | --- | --- |
| `PERCENT` | 1% of the reference price | Daily bars |
| `ATR` | One ATR, matching the `ta-v1` definition | Intraday bars |

The unit indirection exists because a fixed percentage is not a portable threshold. A 1%
move across twenty candles is a trend on a daily chart and a violent session on a
one-minute chart, so percentage thresholds go effectively silent on intraday data — a
`BREAKOUT` would need roughly 25 NIFTY points above the twenty-bar high inside twenty
minutes, and a `PULLBACK` would need 2%. Measuring in ATR instead makes one
configuration mean the same thing on every timeframe and instrument.

The unit counts are calibrated so the two modes agree closely on daily NIFTY, where
ATR(14) runs near 1% of price. That is deliberate: switching modes on the same history
is then a comparison of measurement, not a switch to a different rule set.

In `ATR` mode no distance rule fires until ATR(14) has left its warm-up window. Guessing
a scale during warm-up would invent the threshold, so the engine stays silent instead.
ATR is computed inside the engine from the same candles, keeping the rules a pure
function of the series; it matches the `ta-v1` Wilder definition apart from that
indicator's display rounding.

Switching modes changes what the rules mean, so it requires its own algorithm version.
The CLI pairs them so a run cannot write ATR-mode evidence under the percentage label,
and every event records its `thresholdMode` in `details`:

```powershell
npm run analysis:detect-patterns -- --instrument NIFTY50 --timeframe 5m --threshold-mode atr
```

| `--threshold-mode` | Stored version |
| --- | --- |
| `percent` (default) | `price-action-v2` |
| `atr` | `price-action-v2-atr` |

A breakout is reported once per crossing, not once per candle that happens to sit above the barrier. Because the barrier is a rolling extreme that includes the previous candle's own high, the previous close must be tested against the barrier *as it stood on that candle*; otherwise one sustained advance is re-reported as a fresh breakout on every candle.

Level touches count distinct visits rather than nearby candles. Consecutive candles inside the tolerance band form one touch, and a new touch is only counted after price has left the band, so a single consolidation cannot inflate a level's touch count or its confidence.

The future candles used to confirm a swing are deliberate. A swing is **not** recorded on its pivot candle, because it was not knowable then. Instead, its event is anchored to the later confirmation candle and its `details` include both the pivot candle ID and confirmation candle ID. This prevents a strategy or backtest from acting on information that was unavailable at the apparent pivot time.

## Implementation

After importing completed history, run detection for one instrument and timeframe:

```powershell
npm run analysis:detect-patterns -- --instrument NIFTY50 --timeframe 1d
```

The command:

1. Resolves the NSE instrument and reads its completed candles in chronological order.
2. Runs the candlestick and price-action engines over that history.
3. Ensures versioned candlestick definitions such as `candlestick-v1` exist.
4. Upserts detections and `price-action-v2` events with direction, confidence, context, level, and rule details.

Incomplete live candles are excluded. Run this after a live candle finalises, or after a historical import, so the input evidence is stable.

## Code decisions

- Pattern rules are pure functions over `PatternCandle` values. This makes fixtures and edge cases easy to test without PostgreSQL or provider credentials.
- Confidence is a bounded rule-strength score, not a calibrated probability of return or a recommendation to trade.
- Confidence measures how well the observation fits its own rule, so a trend scores on the size of its move while a range scores on the absence of one. A flat market is a high-confidence `RANGE`; a drift just under the trend threshold is a low-confidence one.
- Candlestick detections retain every candle used by the pattern in `context_candle_ids`; details retain values such as body ratios, trend context, or mother-bar bounds.
- Price-action events retain their triggering level and details such as lookback, trigger, touch count, pivot, and confirmation IDs.
- Only completed candles are supplied to either engine. A provisional candle must never create a permanent analytical event.
- The repository keys make an unchanged re-run idempotent while algorithm versions preserve prior research results.

## Best practices

- Use the same pattern and price-action algorithm versions in strategy definition, backtesting, paper trading, and feature generation.
- Treat a pattern as one piece of evidence; combine it with liquidity, regime, indicators, risk limits, and out-of-sample testing before assigning any trading meaning.
- Keep a sufficiently long completed-candle history. Trend, breakout, level-touch, and swing rules need their full lookback windows.
- Review the stored context and details before trusting a detection; named patterns are sensitive to exact rule definitions.
- Re-run detection after deliberately corrected or newly completed candle data, and record the algorithm version used by every downstream strategy.

## Common mistakes

- Calling a pattern on an in-progress candle, then treating a changing result as a signal.
- Backdating a confirmed swing to its pivot candle in a backtest. That introduces look-ahead bias.
- Treating the confidence score as a win probability or using it without calibration.
- Mixing adjusted and unadjusted price histories in one detection run.
- Changing a threshold in code while retaining the old algorithm version.
- Assuming a breakout is valid without accounting for costs, gaps, liquidity, regime, and a next-candle execution assumption.

## Production considerations

For a larger watchlist, run incrementally from the earliest new or corrected candle plus the largest rule lookback and swing-confirmation window. Add scheduled jobs, run identifiers, metrics, failure alerts, and a review queue for unusually dense detections. Maintain reference fixtures for every pattern when a version changes, and validate the exact same confirmation-timing rules in the backtest engine. If configurations become user-editable, persist their canonical parameters or a parameters hash alongside the algorithm version.

This phase remains analysis-only. It does not authenticate with a broker, route orders, or create real trades.

## Assignment

1. Import at least 60 completed daily candles for NIFTY 50 and run the detection command twice; confirm the second run does not create duplicate evidence.
2. Inspect one engulfing or inside-bar detection and explain its stored context candle IDs and details.
3. Find a `SWING_HIGH` event and verify that its `confirmationCandleId` is later than its `pivotCandleId` by the configured swing window.
4. Create a small fixture with a known breakout and verify the prior 20-candle resistance, buffer, and crossing close by hand.
5. Propose one change to a threshold, assign it a new algorithm version, and describe how you would compare its out-of-sample results with `v1` without rewriting history.

