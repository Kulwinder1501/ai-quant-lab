import type { Migration } from "../migration-runner.js";

// Registers 20 liquid NSE large-caps purely to widen the model training set.
//
// Why: every quality claim this project has made rests on one instrument. At 882 daily
// candles, SE(macro-F1) is large enough that a 0.38 and a 0.34 are the same measurement,
// and no cross-validation scheme fixes that -- resampling cannot manufacture information
// the data does not contain. Twenty more instruments take the daily pool from ~880 rows
// to ~17,600, which is the only lever that adds genuinely independent observations.
//
// Registered INACTIVE on purpose. `is_active` is not a cosmetic flag: the market scanner
// (`postgres-market-scanner-query-repository`) and trade-idea generation both select on
// it, so flipping these on would immediately push twenty instruments with no indicator
// snapshots, no trained model, and no volatility regime into live idea generation. The
// backfill path does not care -- `collect-historical-data` resolves through
// `findByExchangeAndSymbol`, which ignores the flag -- so training data can be collected
// while the live surface stays exactly as it is today. Activating one is a deliberate,
// separate decision.
//
// Corporate actions, audited before seeding rather than assumed. The historical provider
// reads Yahoo's raw `close`, never `adjclose`. Measured across all twenty symbols over
// 2023-01-02..2026-07-31 (886 rows each): the largest single-day move anywhere is -14.4%
// and no symbol has a single move beyond +/-20%, so the series is already split-adjusted
// -- an unadjusted 1:5 split would print as a -80% day and be labelled BEARISH.
//
// Dividends are NOT folded into `close`: adjclose diverges from close by 0.34%-14.22% at
// the start of the window and converges to 0.00% at the present, which is the signature
// of a back-propagated dividend adjustment. That is left alone deliberately. Storing
// adjclose would be a look-ahead leak of exactly the kind this codebase forbids elsewhere
// -- the adjusted 2023 price is a function of dividends declared in 2025, so it encodes
// the future into the past and is silently revised every time a new dividend is paid.
// Raw close is what actually traded that day. The residual cost is that an ex-dividend
// drop is a real but economically uninformative price move; at roughly 2-4 ex-dates per
// symbol per year it touches ~1% of rows, and it is a known, bounded, point-in-time-honest
// imperfection rather than a fabricated one.
export const equityTrainingUniverseMigration: Migration = {
  id: "027-equity-training-universe",
  sql: `
    INSERT INTO instruments (exchange, symbol, display_name, instrument_type, tick_size, lot_size, is_active, metadata)
    VALUES
      ('NSE', 'RELIANCE',   'Reliance Industries',            'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'TCS',        'Tata Consultancy Services',      'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'HDFCBANK',   'HDFC Bank',                      'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'INFY',       'Infosys',                        'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'ICICIBANK',  'ICICI Bank',                     'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'HINDUNILVR', 'Hindustan Unilever',             'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'ITC',        'ITC',                            'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'SBIN',       'State Bank of India',            'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'BHARTIARTL', 'Bharti Airtel',                  'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'KOTAKBANK',  'Kotak Mahindra Bank',            'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'LT',         'Larsen & Toubro',                'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'AXISBANK',   'Axis Bank',                      'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'ASIANPAINT', 'Asian Paints',                   'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'MARUTI',     'Maruti Suzuki India',            'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'TITAN',      'Titan Company',                  'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'SUNPHARMA',  'Sun Pharmaceutical Industries',  'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'ULTRACEMCO', 'UltraTech Cement',               'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'WIPRO',      'Wipro',                          'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'NESTLEIND',  'Nestle India',                   'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'BAJFINANCE', 'Bajaj Finance',                  'EQUITY', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb)
    ON CONFLICT (exchange, symbol) DO NOTHING;

    COMMENT ON COLUMN instruments.is_active IS
      'Drives the market scanner and trade-idea generation. Instruments registered only to widen the ML training set stay FALSE so collection can run without exposing them to live idea generation.';
  `,
};
