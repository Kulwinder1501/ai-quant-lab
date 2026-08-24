# Scalp Engine Research Harness V1.3.1

Status: implemented as a physically isolated, shadow-only research subsystem. Production and paper execution are not consumers of this subsystem.

## Frozen implementation

The isolated pipeline is:

```text
StrategyMarketContext
  -> Momentum v4-Research / Index v2-Research / Pattern v3-Research
  -> immutable proposals
  -> grouping-only MarketOpportunity
  -> canonical and proposal-native settlement
  -> outcome-blind matched controls
  -> read-only risk snapshots and observational decisions
  -> research analytics
```

The research strategies live in their own registry. They are deliberately absent from the operational strategy registry and paper bot. Their source-file SHA-256 checksums are tested, so modifying a frozen source strategy requires a new research version and checksum.

Research records are stored under the `research_scalp` PostgreSQL schema. Every table is append-only at the database layer: updates and deletes are rejected by triggers. Logical keys and payload hashes use versioned canonical JSON plus SHA-256. An identical retry returns the original record; the same logical key with a different payload raises an idempotency conflict.

## Timing and reference policy

- Grid: every one-minute NSE decision boundary anchored at 09:15 IST.
- `decisionAt`: exclusive close boundary of the completed reference minute.
- `dataThrough`: `decisionAt - 1ms`.
- Reference price: exact close of the 1m candle ending at `decisionAt`.
- Strategy contexts on 3m/5m are admitted only when they close at the same `decisionAt`.
- No observation or terminal settlement crosses the persisted session close.
- Horizons 5m, 15m, 30m and 60m are independently eligible.
- The 15:30 close decision is retained, but every forward horizon and terminal is session-ineligible.

## Feature-availability gate

A completed candle is not the same thing as a *computed* candle. Indicator, candlestick-pattern and
price-action detection run on their own schedules; capture runs every minute. Before 2026-08-24 the
harness read whatever was present at that instant, so a live capture could be taken mid-computation
and record a partial feature layer as though it were the real one. Measured on 2026-08-24, the live
cohort saw an incomplete layer on 45.9% of evaluations and was missing 69% of pattern content, against
0/473 for the backfilled cohort — which inverts the usual assumption, since the *backfilled* session
is the trustworthy one.

The defect was invisible because absence was ambiguous: "detection ran and found nothing" and
"detection has not run yet" both look like zero rows, and neither `calculated_at` nor `detected_at` can
date availability because both are batch-rewritten on recomputation.

Coverage is therefore recorded explicitly. Migration `079` adds `candle_feature_coverage`
(`candle_id`, `feature_layer`, `algorithm_version`, `computed_at`), written by the detection jobs with
`ON CONFLICT DO NOTHING` so `computed_at` is a stable **first-cover** time. It is deliberately **not
backfilled**: an absent row means "unknown", and fabricating one would destroy the only evidence that
distinguishes a covered bar from an uncovered one.

Capture then gates on it:

- A candidate minute requires both `CANDLESTICK_PATTERN@candlestick-v1` and `PRICE_ACTION@price-action-v2`
  on all three sibling timeframes (1m/3m/5m). Both layers are matched at **exact** `algorithm_version`,
  so a variant cannot open the gate for a consumer expecting the canonical one.
- An uncovered minute younger than 25 minutes is **deferred**, not captured. Past that it is captured
  and counted, so a stalled detection job cannot silently drain the grid.
- `controlIneligibleReason` gains `FEATURE_LAYER_NOT_COMPUTED`, alongside the existing
  `FEATURE_WARMUP:<codes>` for missing canonical indicators. An ungated capture is refused rather than
  quietly taken on partial state.

The sibling join matches on `open_time = close_time - span` to hit the unique index; the earlier
predicate bitmap-scanned ~73k rows per candidate minute (455 ms, worsening with history) against 52 ms
now, flat.

`LIVE_BACKFILL_FEATURE_PARITY_V1` (`npm run research:parity:live-backfill`) is the acceptance test for
this gate — see §8.11 of [phase-29](phase-29-directional-intelligence-v2.md). It is read-only, stops
before outcomes, and never compares P&L. 2026-08-24 is kept unrepaired as the negative control, where
it correctly reports `NO_PARITY`.

## Canonical and native settlement

`CANONICAL_GEOMETRY_V1` uses completed `ta-v1` Wilder ATR(14), one ATR stop, 1.5 ATR target and a 60-minute timeout. Tick rounding is frozen:

- LONG: entry and target round up; stop rounds down.
- SHORT: entry and target round down; stop rounds up.

`FILL_POLICY_V1` separates entry and exit fill conditions. Stop gaps fill at the gap open; target gaps fill at the frozen target and therefore receive no positive slippage. A barrier touched in the candle that first triggers an entry is ambiguous. Stop and target in the same active candle are also ambiguous. Missing candles produce `DATA_INCOMPLETE`, never a fabricated timeout.

Economic terminal outcomes are `TARGET`, `STOP`, `TIMEOUT`, `AMBIGUOUS`, and `ENTRY_NOT_TRIGGERED`. Engineering outcomes are `DATA_INCOMPLETE` and `POLICY_INVALID` and are excluded from edge estimates.

## Controls and estimands

Controls match the same instrument, session, evaluation direction and volatility regime within +/-15 minutes. Five controls are selected by deterministic hash rank without replacement within the set; global reuse is allowed. Fewer than five controls is an explicit common-support failure.

- Signal Edge uses paired selected canonical R minus the mean canonical R of its five controls.
- Native Execution Policy Edge reports intent-to-trade and conditional-on-entry separately. `ENTRY_NOT_TRIGGERED` is 0R only for intent-to-trade.
- Gate Value segments shadow outcomes by ALLOW/REJECT and is observational, not causal.
- Inference uses trading-day block bootstrap/day clustering.

## Database isolation

Apply migrations using the database owner, then apply [scalp-research-role.sql](../infra/postgres/scalp-research-role.sql). Create a distinct login role, grant it `scalp_research_writer`, and expose its URL only as `SCALP_RESEARCH_DATABASE_URL`. The CLI refuses to start if the operational and research URLs use the same database username.

The capability role can:

- read operational tables;
- insert/select in `research_scalp`;
- never update or delete research rows;
- never write paper trades, trade ideas, accounts, or market data.

## Commands

```powershell
npm run db:migrate
npm run research:scalp:capture -- --instruments NIFTY50,BANKNIFTY
npm run research:scalp:match-controls
npm run research:scalp:settle -- --limit 500
npm run research:scalp:audit -- --from 2026-08-24T03:45:00.000Z --through 2026-08-28T10:31:00.000Z
```

Capture runs on completed bars and has no execution dependency. Matching should run after the +/-15-minute control window has matured. Settlement should run after the maximum eligible horizon/native expiry plus the normal market-data ingestion grace.

Capture performs bounded same-session recovery. It processes up to 30 uncaptured completed 1m decisions per instrument per tick (`--catch-up-limit` can override this). The two directional control rows are written last and act as the completion marker: if a process stops after any earlier immutable write, the minute remains discoverable and its retry is idempotent.

For unattended collection, build the API image and start only the opt-in research profile:

```powershell
docker compose -f docker-compose.v2.yml --profile research up -d scalp-research-scheduler-v2
```

Set `POSTGRES_RESEARCH_USER` and `POSTGRES_RESEARCH_PASSWORD` to the distinct LOGIN role created for `scalp_research_writer`. The container receives no usable operational database credential. It runs capture, matching, and settlement in a separate process; the operational scheduler never imports this harness.

## Five-day engineering acceptance

The five-day run validates plumbing, not statistical edge. Required evidence includes:

- the architecture isolation test remains green;
- zero persisted duplicate logical keys;
- zero corrupt writes during deliberate changed-payload retry tests;
- complete proposal/opportunity/control/risk traceability;
- two control rows for every completed NIFTY50/BANKNIFTY 1m source candle in the audited grid;
- 100% eligible observation and terminal coverage after the drain sweep;
- explicit ambiguity, incomplete-data and common-support-failure counts;
- zero observations spanning a persisted session boundary.

The audit command exits `0` when every dynamic assertion passes, `2` when the report is generated but an assertion fails, and `1` on an audit/runtime error. Run it only after the final 15:31 IST drain for the requested window. Ambiguity, incomplete-data, policy-invalid, and common-support counts are diagnostics rather than automatic engineering failures; they must be reviewed, not hidden.
