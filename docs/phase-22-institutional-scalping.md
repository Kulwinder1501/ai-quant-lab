# Phase 22: Institutional Flows, GIFT Nifty, and Scalping Dashboard

Phase 22 extends the AI Quant Lab with automated institutional context, candidate model pruning, and a dedicated UI for the momentum scalping strategy.

## 1. Institutional Flows & GIFT Nifty Data Integration
The platform now tracks end-of-day FII (Foreign Institutional Investor) and DII (Domestic Institutional Investor) flow data, alongside the implied pre-market gap from the GIFT Nifty (offshore derivative).

- **Data Collection**: A new automated scraper (`npm run data:collect:institutional`) runs every weekday at 6:30 PM IST via a scheduled cron job to retrieve the latest institutional flows and offshore derivative prints from the NSE.
- **Database**: The flows and offshore derivations are persisted locally in `institutional_flows` and `offshore_derivatives` tables.
- **ML Integration**: The ML feature schema (`ai_quant_lab_ml/features.py`) was updated to emit three new scale-free market features: `market.fii_net_flow_ratio`, `market.dii_net_flow_ratio`, and `market.gift_nifty_implied_gap_bps`.
- **Live Agent Context**: The `AiAutonomousAgent` pulls this institutional flow data into its decision matrix, heavily discounting bullish trades if there are extreme FII outflows or rewarding confidence if inflows are high.

## 2. ML Candidate Pruning
To prevent excessive artifact bloat during hyperparameter tuning and model retraining, a new administrative script was introduced:
- `npm run ml:prune` runs a python script that iterates over the `model_versions` table and deletes the `.pkl` artifact file and database row for any `CANDIDATE` model older than 7 days. `PRODUCTION` models are untouched.

## 3. Scalping Dashboards
A dedicated space in the frontend Dashboard was created to isolate and run the high-frequency `1m` momentum scalp strategy, separating it from the longer-horizon EOD swing ideas:
- **Scalp Strategy / Ideas (`/scalp-ideas`)**: Evaluates recent minute-candles to propose `1m` scalp setups, natively locking the Timeframe selector to prevent cross-contamination with EOD strategies.
- **Scalp Trade History (`/scalp-trade-history`)**: A dedicated ledger filtering historical simulations to display exclusively the `1m` "momentum-scalp" paper trades.
