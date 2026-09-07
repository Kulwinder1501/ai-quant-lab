# Phase 22: Institutional Flows, GIFT Nifty, and Scalping Dashboard

Phase 22 extends the AI Quant Lab with automated institutional context, candidate model pruning, and a dedicated UI for the momentum scalping strategy.

## 1. Institutional Flows & GIFT Nifty Data Integration
The platform tracks end-of-day FII (Foreign Institutional Investor) and DII (Domestic Institutional Investor) cash-flow data. GIFT Nifty (the offshore derivative) is wired through the same pipeline but is **provider-gated**: NSE IX publishes no free machine-readable feed, so the collector returns no offshore print unless `GIFT_NIFTY_YAHOO_SYMBOL` names a series a data provider actually carries. No placeholder price is ever persisted.

- **Data Collection**: A scraper (`npm run data:collect:institutional`) runs every weekday at 6:30 PM IST via a scheduled cron job. It fetches the latest FII/DII cash print from NSE's `fiidiiTradeReact` endpoint and, if a provider is configured, the offshore close. The row is stored under **the session NSE itself reports** — never the collection date — and the CLI exits non-zero if that session is older than expected (holiday or a run before publication) so a scheduler can retry. Values are parsed comma-tolerantly; a value that cannot be parsed is stored as `NULL`, never coerced to `0`.
- **Database**: Flows and offshore closes are persisted in `institutional_flows` and `offshore_derivatives`. Both carry a `published_at` timestamp (migration `010`) recording when the figures became public; a `CHECK (close_price > 0)` on offshore rows enforces that an absent quote is an absent row rather than a zero.
- **ML Integration**: The feature schema (`ai_quant_lab_ml/features.py`) emits two scale-free market features: `market.fii_net_flow_ratio` and `market.dii_net_flow_ratio`, each the net crore normalised by the trailing mean-absolute net flow of **strictly prior** published sessions. Both are populated by `PostgresMlRepository._load_institutional_flow` on **both** the training and inference paths, and are read point-in-time: a bar may only see a print published on or before its own close and from a strictly earlier session, so the feature cannot leak. When no print is visible the feature is left missing (never imputed to `0`). A `gift_nifty_implied_gap_bps` column was intentionally **not** shipped — a declared column with no loader is a guaranteed-NaN constant that only forces a retrain, so it waits for a real offshore feed. The swing schema is `ml-feature-v5`; scalp is `ml-feature-scalp-v2`.
- **Live Agent Context**: The `AiAutonomousAgent` reads the most recently *published* flow (not today's row, which does not exist during the session) via `institutionalFlowBias()`. The bias nets DII against FII — heavy FII selling absorbed by DII buying reads as rotation, not an exodus — is graded by magnitude rather than a flat step, and weights outflows ~1.5× inflows to discount bullish trades harder on extreme FII outflows.

## 2. ML Candidate Pruning
To prevent excessive artifact bloat during hyperparameter tuning and model retraining, a new administrative script was introduced:
- `npm run ml:prune` runs a python script that deletes the database row and `.pkl` artifact for any `CANDIDATE` model older than 7 days. `PRODUCTION` models are untouched. Candidates still referenced by a `model_prediction` or `model_promotion` (both `ON DELETE RESTRICT` — the prediction rows are the audit trail) are **skipped and reported**, not force-deleted. Each row is deleted in its own transaction and committed **before** its artifact file is unlinked, so a failure on one candidate leaves the others pruned and the worst case is a recoverable orphaned file rather than a committed row pointing at a deleted artifact. Use `--dry-run` to preview; the script exits non-zero if any deletion fails.

## 3. Scalping Dashboards
A dedicated space in the frontend Dashboard was created to isolate and run the high-frequency `1m` momentum scalp strategy, separating it from the longer-horizon EOD swing ideas:
- **Scalp Strategy (`/scalp-strategy`)**: Evaluates recent minute-candles to propose `1m` scalp setups, natively locking the Timeframe selector to prevent cross-contamination with EOD strategies.
- **Scalp Trade History (`/scalp-trade-history`)**: A dedicated ledger filtering historical simulations to display exclusively the `1m` "momentum-scalp" paper trades.

### Both directions (LONG / SHORT)
The momentum-scalp rule set is symmetric: a **SHORT** triggers when price is below VWAP, the fast EMA is below the slow EMA, and RSI sits in the 20–40 band (the mirror of the LONG rule). Two things previously made the dashboard look call-only, both now fixed:

- **Seed data** (`seed-scalp-data.ts`) hard-coded a single `LONG` placeholder per instrument. It now seeds a balanced `LONG` + `SHORT` demo pair (clearly flagged `"seeded": true`) so first-boot UI shows both.
- **Idea generation** evaluated only the single latest completed candle, so a SHORT appeared only when the most-recent bar was bearish at run time. `analysis:generate-trade-ideas` now accepts an opt-in **`--lookback N`** flag that scans the last `N` completed candles and persists every proposal — long and short — each keyed to its own source bar. Default (no flag) behaviour is unchanged.

```bash
npm run analysis:generate-trade-ideas -- --instrument NIFTY50 --timeframe 1m --lookback 300
```

The scan reads indicators as they already exist in the database, so `analysis:calculate-indicators` must have run for the timeframe first (the scalp rule needs EMA-9, EMA-20, RSI-14, VWAP, and ATR-14 present, or it resolves nothing). Historical scanned bars produce already-expired ideas; the dashboard applies no status/expiry filter, so they still display.
