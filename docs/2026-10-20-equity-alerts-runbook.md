# Equity Alerts and Event Flags Operations Runbook

**Module:** Equity Research Intelligence  
**Author:** AI Quant Lab Engineering  
**Version:** 1.0.0 (Post-Step 5)  
**Effective Date:** 2026-10-20  

---

## 1. Migration 140: Status & Verification

Migration `140-equity-alerts-and-events` introduces the immutable tables for alerts and event flags (`equity_research.alert`, `equity_research.alert_state`, and `equity_research.event_flag`).

### Live Environment Status
Migration 140 is **already applied** on the live production database (`applied_at: 2026-10-19 14:54:16 UTC`). **Do NOT re-apply or re-run on live.**

### Verification Commands (Read-Only)
Run the following SQL queries to verify migration state and table readiness:
```sql
-- 1. Verify migration registration in schema_migrations
SELECT id, applied_at 
FROM schema_migrations 
WHERE id = '140-equity-alerts-and-events';

-- 2. Verify existence of tables in equity_research schema
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'equity_research' 
  AND table_name IN ('alert', 'alert_state', 'event_flag')
ORDER BY table_name;

-- 3. Verify unique indexes enforcing idempotency
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE schemaname = 'equity_research' 
  AND tablename IN ('alert', 'event_flag')
  AND indexname IN ('alert_stock_kind_level_date_idx', 'event_flag_detected_uniq_idx');
```

If deploying to a fresh scratch database or disaster recovery instance:
```bash
npm run db:migrate --workspace @ai-quant-lab/api
```

---

## 2. Manual Execution & Historical Replay (`equity:alerts:eval`)

EOD alert evaluation runs automatically at 17:00 IST as part of the daily pipeline (`pipeline:eod` / `equity:collect:eod`). For manual re-runs, historical replays, or single-stock evaluations, use the CLI.

### CLI Commands
From repository root:
```bash
# Evaluate all active watchlist stocks for a specific date (YYYY-MM-DD)
npm run equity:alerts:eval --workspace @ai-quant-lab/api -- --date 2026-10-20

# Evaluate a single stock
npm run equity:alerts:eval --workspace @ai-quant-lab/api -- --date 2026-10-20 --symbol SUZLON

# Filter by exchange
npm run equity:alerts:eval --workspace @ai-quant-lab/api -- --date 2026-10-20 --exchange NSE

# Run for today's IST date (default if --date is omitted)
npm run equity:alerts:eval --workspace @ai-quant-lab/api
```

### Idempotency & Re-run Safety
- `equity_research.alert` enforces `UNIQUE (stock_id, kind, (COALESCE(level_key, '')), evaluated_date)`.
- `equity_research.event_flag` enforces `UNIQUE (stock_id, kind, event_date, (COALESCE(detail_json->>'key', ''))) WHERE origin = 'DETECTED'`.
- Duplicate evaluation passes use `ON CONFLICT DO NOTHING`. Re-running on an already evaluated date emits 0 duplicate alerts and 0 duplicate event flags.

### Calendar & Holiday Guards
- **Weekends**: Saturdays and Sundays evaluate 0 stocks and 0 alerts (`Weekend date (YYYY-MM-DD) has no trading session`).
- **Exchange Holidays**: Official exchange holidays stored in `nse_holidays` evaluate 0 stocks and 0 alerts.
- **Outage Detection**: Non-holiday weekdays with zero bars and zero successful chart calls emit a throttled `DATA_HEALTH` notice (`Market data source outage detected on YYYY-MM-DD: zero bars stored on non-holiday weekday; raised data-health notices`).

---

## 3. Live Tripwire Monitoring (5-Trading-Day Soak)

During the live deployment soak period, the live tripwire monitors alert frequency against the pre-registered budget.

### Tripwire Threshold & Rules
- **Level Alerts Only**: The tripwire strictly counts **level alerts only** (`LEVEL_BREAK`, `LEVEL_ZONE_ENTER`, `LEVEL_APPROACH`), matching the calibration protocol. Informational data-health notices and detected events are excluded from the frequency budget.
- **Pre-registered Budget**: Median $\le 3.0$ and 95th percentile $\le 8.0$ level alerts per stock-month.
- **Tripwire Rule**: If 95th percentile exceeds **8.0 level alerts per stock-month** over the first 20 trading days, pause deployments and tighten calibration parameters in `apps/api/src/modules/equity-research/domain/equity-alerts-v1.json`.
- **Trading Days from Bar Dates**: Trading days in the evaluation window are counted strictly from price bars stored in `equity_research.price_bar`, NEVER from dates on which alerts fired. Days with zero alerts are legitimate quiet trading days in the denominator.
- **Watchlist Sample Size**: With tiny watchlists (e.g. the 2 live stocks SUZLON and TMPV), percentiles ($p95$) are descriptive and equal the sample maximum. The tripwire distribution ($p95$ and median) becomes statistically meaningful once the watchlist scales to approximately 20 or more stocks. For smaller watchlists, inspect raw alert counts per stock directly.

### Tripwire Command
```bash
# Print live tripwire status in default mode (starts at first alert date, audits first 20 bar dates)
npm run equity:alerts:tripwire --workspace @ai-quant-lab/api

# Audit specific trading date range
npm run equity:alerts:tripwire --workspace @ai-quant-lab/api -- --from-date 2026-09-01 --to-date 2026-10-19

# Specify custom trading-day window (default: 20)
npm run equity:alerts:tripwire --workspace @ai-quant-lab/api -- --trading-days 20

# Machine-readable JSON output
npm run equity:alerts:tripwire --workspace @ai-quant-lab/api -- --json
```

---

## 4. Rollback Procedures

If issues arise in production, follow this rollback hierarchy.

### Level 1: Application Rollback (Zero Data Loss - Recommended)
If alert evaluation exhibits unintended behavior, roll back the application layer:
1. **Collector Hook Isolation (Gate E10)**: The EOD collector wraps alert evaluation in `try/catch`. Disabling or pausing alert evaluation never disrupts core price bar collection.
2. **Revert Application Deployment**: Deploy the previous release commit or git tag.
3. **Disable Feature in Web UI**: The Alerts tab and inbox gracefully handle empty states if the API returns 0 alerts.

### Level 2: Database Rollback (Migration 140 Reversal)
If tables or schema state must be rolled back completely, execute the following SQL script:
```sql
BEGIN;

-- 1. Drop dependent alert state table
DROP TABLE IF EXISTS equity_research.alert_state CASCADE;

-- 2. Drop alerts table
DROP TABLE IF EXISTS equity_research.alert CASCADE;

-- 3. Drop event flags table
DROP TABLE IF EXISTS equity_research.event_flag CASCADE;

-- 4. Unregister migration record
DELETE FROM schema_migrations WHERE id = '140-equity-alerts-and-events';

COMMIT;
```

**Post-Rollback Verification:**
```sql
SELECT count(*) FROM schema_migrations WHERE id = '140-equity-alerts-and-events'; -- Expected: 0
SELECT to_regclass('equity_research.alert');                                       -- Expected: NULL
SELECT to_regclass('equity_research.event_flag');                                  -- Expected: NULL
```

---

## 5. Annual Operations Checklist (Year-End Maintenance)

### Adding Calendar Year 2027 NSE Holidays
1. **Timing**: Complete prior to December 20, 2026 (before January 1, 2027).
2. **Source Authority**: Obtain the official circular published by the National Stock Exchange of India (Capital Market / Normal Trading Segment) for calendar year 2027.
3. **Provenance Requirement**: Cite **only** the actual circular reference number printed on the exchange document. Do not extrapolate, infer, or cite unverified circular numbers.
4. **SQL Seeding**:
   ```sql
   -- Insert official 2027 holidays into nse_holidays table
   INSERT INTO nse_holidays (holiday_date, name)
   VALUES 
     ('2027-01-26', 'Republic Day'),
     -- Additional dates as published in the official circular
   ON CONFLICT (holiday_date) DO NOTHING;
   ```
5. **Verification**:
   ```sql
   SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name 
   FROM nse_holidays 
   WHERE holiday_date >= '2027-01-01' 
   ORDER BY holiday_date ASC;
   ```
