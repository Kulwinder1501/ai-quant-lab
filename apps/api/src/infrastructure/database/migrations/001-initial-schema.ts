import type { Migration } from "../migration-runner.js";

/**
 * The initial schema intentionally stores inputs and outputs separately.
 * Raw candles remain reproducible evidence for every derived research result.
 */
export const initialSchemaMigration: Migration = {
  id: "001-initial-schema",
  sql: `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE OR REPLACE FUNCTION touch_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TABLE market_data_ingestions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
      mode TEXT NOT NULL CHECK (mode IN ('HISTORICAL', 'LIVE')),
      status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
      request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_metadata) = 'object'),
      record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
      started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      error_message TEXT,
      CHECK (completed_at IS NULL OR completed_at >= started_at)
    );

    CREATE INDEX market_data_ingestions_history_idx ON market_data_ingestions (provider, started_at DESC);

    CREATE TABLE instruments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      exchange TEXT NOT NULL DEFAULT 'NSE' CHECK (exchange IN ('NSE', 'NFO', 'BSE')),
      symbol TEXT NOT NULL CHECK (length(trim(symbol)) > 0),
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
      instrument_type TEXT NOT NULL CHECK (instrument_type IN ('INDEX', 'EQUITY', 'ETF')),
      isin TEXT,
      currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      tick_size NUMERIC(18, 6) NOT NULL DEFAULT 0.05 CHECK (tick_size > 0),
      lot_size INTEGER NOT NULL DEFAULT 1 CHECK (lot_size > 0),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (exchange, symbol)
    );

    CREATE TRIGGER instruments_touch_updated_at
    BEFORE UPDATE ON instruments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    CREATE TABLE candles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      ingestion_id UUID REFERENCES market_data_ingestions(id) ON DELETE SET NULL,
      timeframe TEXT NOT NULL CHECK (length(trim(timeframe)) BETWEEN 2 AND 16),
      open_time TIMESTAMPTZ NOT NULL,
      close_time TIMESTAMPTZ NOT NULL CHECK (close_time > open_time),
      open NUMERIC(20, 6) NOT NULL CHECK (open > 0),
      high NUMERIC(20, 6) NOT NULL CHECK (high > 0),
      low NUMERIC(20, 6) NOT NULL CHECK (low > 0),
      close NUMERIC(20, 6) NOT NULL CHECK (close > 0),
      volume NUMERIC(24, 4) NOT NULL DEFAULT 0 CHECK (volume >= 0),
      is_complete BOOLEAN NOT NULL DEFAULT FALSE,
      source TEXT NOT NULL DEFAULT 'unknown' CHECK (length(trim(source)) > 0),
      source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_metadata) = 'object'),
      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (high >= open AND high >= close AND high >= low),
      CHECK (low <= open AND low <= close),
      UNIQUE (instrument_id, timeframe, open_time)
    );

    CREATE INDEX candles_lookup_idx ON candles (instrument_id, timeframe, open_time DESC);
    CREATE INDEX candles_completed_lookup_idx ON candles (instrument_id, timeframe, open_time DESC) WHERE is_complete;

    CREATE TABLE indicator_definitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      indicator_code TEXT NOT NULL CHECK (indicator_code IN ('EMA', 'SMA', 'RSI', 'MACD', 'ATR', 'VWAP', 'BOLLINGER_BANDS', 'SUPERTREND')),
      algorithm_version TEXT NOT NULL CHECK (length(trim(algorithm_version)) > 0),
      parameters JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
      parameters_hash TEXT NOT NULL CHECK (length(trim(parameters_hash)) > 0),
      output_schema JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_schema) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (indicator_code, algorithm_version, parameters_hash)
    );

    CREATE TABLE indicator_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE CASCADE,
      indicator_definition_id UUID NOT NULL REFERENCES indicator_definitions(id) ON DELETE RESTRICT,
      values JSONB NOT NULL CHECK (jsonb_typeof(values) = 'object'),
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (candle_id, indicator_definition_id)
    );

    CREATE INDEX indicator_snapshots_candle_idx ON indicator_snapshots (candle_id);

    CREATE TABLE pattern_definitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pattern_code TEXT NOT NULL CHECK (pattern_code IN (
        'DOJI', 'HAMMER', 'HANGING_MAN', 'SHOOTING_STAR', 'BULLISH_ENGULFING',
        'BEARISH_ENGULFING', 'MORNING_STAR', 'EVENING_STAR', 'BULLISH_HARAMI',
        'BEARISH_HARAMI', 'THREE_WHITE_SOLDIERS', 'THREE_BLACK_CROWS',
        'INSIDE_BAR', 'OUTSIDE_BAR'
      )),
      category TEXT NOT NULL DEFAULT 'CANDLESTICK' CHECK (category IN ('CANDLESTICK', 'PRICE_ACTION')),
      algorithm_version TEXT NOT NULL CHECK (length(trim(algorithm_version)) > 0),
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (pattern_code, algorithm_version)
    );

    CREATE TABLE pattern_detections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE CASCADE,
      pattern_definition_id UUID NOT NULL REFERENCES pattern_definitions(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL CHECK (direction IN ('BULLISH', 'BEARISH', 'NEUTRAL')),
      confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      context_candle_ids UUID[] NOT NULL DEFAULT '{}',
      details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (candle_id, pattern_definition_id)
    );

    CREATE INDEX pattern_detections_candle_idx ON pattern_detections (candle_id, detected_at DESC);

    CREATE TABLE price_action_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'BREAKOUT', 'BREAKDOWN', 'SUPPORT', 'RESISTANCE', 'UPTREND', 'DOWNTREND',
        'RANGE', 'PULLBACK', 'SWING_HIGH', 'SWING_LOW'
      )),
      direction TEXT NOT NULL CHECK (direction IN ('BULLISH', 'BEARISH', 'NEUTRAL')),
      level NUMERIC(20, 6),
      confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      algorithm_version TEXT NOT NULL CHECK (length(trim(algorithm_version)) > 0),
      details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (candle_id, event_type, algorithm_version)
    );

    CREATE INDEX price_action_events_candle_idx ON price_action_events (candle_id, detected_at DESC);

    CREATE TABLE strategies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_key TEXT NOT NULL UNIQUE CHECK (length(trim(strategy_key)) > 0),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      description TEXT NOT NULL DEFAULT '',
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TRIGGER strategies_touch_updated_at
    BEFORE UPDATE ON strategies
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    CREATE TABLE strategy_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_id UUID NOT NULL REFERENCES strategies(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      configuration JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (strategy_id, version)
    );

    CREATE INDEX strategy_versions_active_idx ON strategy_versions (strategy_id, version DESC) WHERE is_active;

    CREATE TABLE model_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_key TEXT NOT NULL CHECK (length(trim(model_key)) > 0),
      version INTEGER NOT NULL CHECK (version > 0),
      algorithm TEXT NOT NULL CHECK (length(trim(algorithm)) > 0),
      stage TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (stage IN ('CANDIDATE', 'PRODUCTION', 'REJECTED', 'ARCHIVED')),
      artifact_uri TEXT NOT NULL CHECK (length(trim(artifact_uri)) > 0),
      artifact_checksum TEXT,
      feature_schema JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(feature_schema) = 'array'),
      training_window_start TIMESTAMPTZ NOT NULL,
      training_window_end TIMESTAMPTZ NOT NULL CHECK (training_window_end > training_window_start),
      training_rows INTEGER NOT NULL CHECK (training_rows > 0),
      validation_metrics JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation_metrics) = 'object'),
      trained_at TIMESTAMPTZ NOT NULL,
      promoted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (model_key, version)
    );

    CREATE UNIQUE INDEX one_production_model_per_key_idx
    ON model_versions (model_key) WHERE stage = 'PRODUCTION';

    CREATE TABLE model_promotions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_version_id UUID NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
      previous_model_version_id UUID REFERENCES model_versions(id) ON DELETE SET NULL,
      comparison JSONB NOT NULL CHECK (jsonb_typeof(comparison) = 'object'),
      promoted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (model_version_id)
    );

    CREATE TABLE trade_ideas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      strategy_version_id UUID REFERENCES strategy_versions(id) ON DELETE SET NULL,
      model_version_id UUID REFERENCES model_versions(id) ON DELETE SET NULL,
      source_candle_id UUID REFERENCES candles(id) ON DELETE SET NULL,
      side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
      status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'ACCEPTED', 'EXPIRED', 'REJECTED')),
      entry_price NUMERIC(20, 6) NOT NULL CHECK (entry_price > 0),
      stop_loss NUMERIC(20, 6) NOT NULL CHECK (stop_loss > 0),
      target_price NUMERIC(20, 6) NOT NULL CHECK (target_price > 0),
      risk_reward NUMERIC(10, 4) NOT NULL CHECK (risk_reward > 0),
      confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      reasoning JSONB NOT NULL CHECK (jsonb_typeof(reasoning) = 'array'),
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
      generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (side = 'LONG' AND stop_loss < entry_price AND target_price > entry_price)
        OR (side = 'SHORT' AND stop_loss > entry_price AND target_price < entry_price)
      )
    );

    CREATE TRIGGER trade_ideas_touch_updated_at
    BEFORE UPDATE ON trade_ideas
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    CREATE INDEX trade_ideas_scanner_idx ON trade_ideas (instrument_id, status, generated_at DESC);
    CREATE INDEX trade_ideas_open_idx ON trade_ideas (generated_at DESC) WHERE status IN ('PROPOSED', 'ACCEPTED');

    CREATE TABLE trade_idea_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trade_idea_id UUID NOT NULL REFERENCES trade_ideas(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      source_type TEXT NOT NULL CHECK (source_type IN ('INDICATOR', 'PATTERN', 'PRICE_ACTION', 'MODEL', 'STRATEGY')),
      source_reference TEXT,
      label TEXT NOT NULL CHECK (length(trim(label)) > 0),
      contribution NUMERIC(12, 8),
      details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      UNIQUE (trade_idea_id, ordinal)
    );

    CREATE INDEX trade_idea_evidence_lookup_idx ON trade_idea_evidence (trade_idea_id, ordinal);

    CREATE TABLE paper_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
      opening_balance NUMERIC(20, 2) NOT NULL CHECK (opening_balance >= 0),
      currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TRIGGER paper_accounts_touch_updated_at
    BEFORE UPDATE ON paper_accounts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    CREATE TABLE paper_trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
      trade_idea_id UUID REFERENCES trade_ideas(id) ON DELETE SET NULL,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
      quantity NUMERIC(20, 4) NOT NULL CHECK (quantity > 0),
      entry_price NUMERIC(20, 6) NOT NULL CHECK (entry_price > 0),
      stop_loss NUMERIC(20, 6) NOT NULL CHECK (stop_loss > 0),
      target_price NUMERIC(20, 6) NOT NULL CHECK (target_price > 0),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMPTZ,
      exit_price NUMERIC(20, 6),
      exit_reason TEXT CHECK (exit_reason IN ('STOP_LOSS', 'TARGET', 'MANUAL', 'CANCELLED')),
      realized_pnl NUMERIC(20, 6),
      fees NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (fees >= 0),
      slippage NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (slippage >= 0),
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (side = 'LONG' AND stop_loss < entry_price AND target_price > entry_price)
        OR (side = 'SHORT' AND stop_loss > entry_price AND target_price < entry_price)
      ),
      CHECK (
        (status = 'OPEN' AND closed_at IS NULL AND exit_price IS NULL AND realized_pnl IS NULL)
        OR (status = 'CLOSED' AND closed_at IS NOT NULL AND exit_price IS NOT NULL AND realized_pnl IS NOT NULL)
        OR status = 'CANCELLED'
      )
    );

    CREATE TRIGGER paper_trades_touch_updated_at
    BEFORE UPDATE ON paper_trades
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    CREATE INDEX paper_trades_open_idx ON paper_trades (account_id, opened_at DESC) WHERE status = 'OPEN';
    CREATE INDEX paper_trades_history_idx ON paper_trades (account_id, closed_at DESC);
    CREATE UNIQUE INDEX paper_trades_one_per_idea_per_account_idx
    ON paper_trades (account_id, trade_idea_id) WHERE trade_idea_id IS NOT NULL;

    CREATE TABLE paper_trade_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      paper_trade_id UUID NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('OPENED', 'STOP_LOSS_HIT', 'TARGET_HIT', 'MANUALLY_CLOSED', 'CANCELLED')),
      price NUMERIC(20, 6),
      quantity NUMERIC(20, 4) CHECK (quantity IS NULL OR quantity > 0),
      details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX paper_trade_events_timeline_idx ON paper_trade_events (paper_trade_id, occurred_at);

    CREATE TABLE backtest_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id) ON DELETE RESTRICT,
      model_version_id UUID REFERENCES model_versions(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
      timeframe TEXT NOT NULL CHECK (length(trim(timeframe)) BETWEEN 2 AND 16),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      data_window_start TIMESTAMPTZ NOT NULL,
      data_window_end TIMESTAMPTZ NOT NULL CHECK (data_window_end > data_window_start),
      data_cutoff_at TIMESTAMPTZ NOT NULL,
      engine_version TEXT NOT NULL CHECK (length(trim(engine_version)) > 0),
      configuration JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (completed_at IS NULL OR started_at IS NOT NULL),
      CHECK (completed_at IS NULL OR completed_at >= started_at)
    );

    CREATE INDEX backtest_runs_history_idx ON backtest_runs (strategy_version_id, created_at DESC);

    CREATE TABLE backtest_run_instruments (
      backtest_run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      PRIMARY KEY (backtest_run_id, instrument_id)
    );

    CREATE TABLE backtest_trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      backtest_run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
      entry_time TIMESTAMPTZ NOT NULL,
      exit_time TIMESTAMPTZ NOT NULL CHECK (exit_time >= entry_time),
      entry_price NUMERIC(20, 6) NOT NULL CHECK (entry_price > 0),
      exit_price NUMERIC(20, 6) NOT NULL CHECK (exit_price > 0),
      quantity NUMERIC(20, 4) NOT NULL CHECK (quantity > 0),
      pnl NUMERIC(20, 6) NOT NULL,
      return_pct NUMERIC(12, 6) NOT NULL,
      exit_reason TEXT NOT NULL CHECK (exit_reason IN ('STOP_LOSS', 'TARGET', 'SIGNAL', 'END_OF_DATA')),
      reasoning JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasoning) = 'array')
    );

    CREATE INDEX backtest_trades_run_idx ON backtest_trades (backtest_run_id, entry_time);

    CREATE TABLE backtest_monthly_performance (
      backtest_run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
      month_start DATE NOT NULL CHECK (month_start = date_trunc('month', month_start)::date),
      trade_count INTEGER NOT NULL CHECK (trade_count >= 0),
      winning_trade_count INTEGER NOT NULL CHECK (winning_trade_count >= 0 AND winning_trade_count <= trade_count),
      gross_profit NUMERIC(20, 6) NOT NULL DEFAULT 0,
      gross_loss NUMERIC(20, 6) NOT NULL DEFAULT 0,
      net_pnl NUMERIC(20, 6) NOT NULL DEFAULT 0,
      max_drawdown_pct NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (max_drawdown_pct >= 0),
      PRIMARY KEY (backtest_run_id, month_start)
    );

    CREATE TABLE model_predictions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_version_id UUID NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      source_candle_id UUID REFERENCES candles(id) ON DELETE SET NULL,
      trade_idea_id UUID REFERENCES trade_ideas(id) ON DELETE SET NULL,
      prediction TEXT NOT NULL CHECK (prediction IN ('BULLISH', 'BEARISH', 'NEUTRAL')),
      confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      feature_contributions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(feature_contributions) = 'array'),
      explanation JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(explanation) = 'array'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX model_predictions_lookup_idx ON model_predictions (instrument_id, created_at DESC);
    CREATE INDEX model_predictions_model_idx ON model_predictions (model_version_id, created_at DESC);
  `,
};
