import type { Migration } from "../migration-runner.js";

/**
 * Candlestick algorithm v2 definitions, v1 supersession, and point-in-time `known_at` on stored
 * pattern evidence.
 *
 * ## What changed in the rules (why a new algorithm version)
 *
 * The phase-06 rule is that any change to a detection rule needs a new algorithm version. v2 is the
 * v1 rule set with: a DOJI minimum range of two ticks, a longer documented prior-trend lookback on
 * intraday timeframes (daily unchanged), Piercing Line / Dark Cloud Cover requiring the open beyond
 * the prior bar's extreme (as their own descriptions always said), and detection run per IST
 * session with no-trade bars suppressed. A v1 row cannot be told apart from a v2 row by looking at
 * it, so consumers read only the current version (see `candlestickAlgorithmVersion`) and v1 rows are
 * marked superseded here rather than deleted.
 *
 * ## Nothing is deleted, nothing is re-detected here
 *
 * This migration inserts the v2 definition rows and marks the v1 ones superseded. It writes no
 * detections: v2 evidence comes only from re-running the detection CLI (see
 * docs/2026-10-10-pattern-recognition-v2-redetection.md and
 * scripts/redetect-candlestick-v2.ps1), which has not been run. Until it has,
 * a consumer reading the current version finds no candlestick evidence, which is the honest state.
 *
 * ## known_at
 *
 * `detected_at` is a most-recent-write field (bumped on any content change, and by every rebuild),
 * so it cannot date when a detection became knowable. `known_at` is the close of the candle the
 * detection is stored on (for multi-bar patterns that is the last bar; for swings and chart
 * patterns it is the confirmation bar), the earliest moment the information could exist.
 *
 * - New rows: a BEFORE INSERT trigger fills it from the candle when the writer leaves it NULL, so
 *   the repositories (whose upserts do not mention the column) need no change.
 * - Never overwritten: an upsert that re-detects the same row does not list known_at in its UPDATE
 *   set, and a BEFORE UPDATE trigger additionally keeps the earlier of the old and new value.
 * - Existing rows are backfilled with the same definition. For rows written long after their bar
 *   (a rebuild) that is optimistic: it is the earliest possible knowledge time, not proof of when
 *   the row existed. Replays that need the stricter reading should keep filtering on both.
 *
 * Replay and backtest reads should filter on known_at, not detected_at, for the reason above.
 */
export const candlestickV2PatternDefinitionsMigration: Migration = {
  id: "133-candlestick-v2-pattern-definitions",
  sql: `
    ALTER TABLE pattern_definitions
      ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS superseded_by_version TEXT;

    INSERT INTO pattern_definitions (pattern_code, category, algorithm_version, description)
    VALUES
      ('DOJI', 'CANDLESTICK', 'candlestick-v2', 'Small real body relative to the full candle range.'),
      ('DRAGONFLY_DOJI', 'CANDLESTICK', 'candlestick-v2', 'Doji with a long lower shadow and virtually no upper shadow.'),
      ('GRAVESTONE_DOJI', 'CANDLESTICK', 'candlestick-v2', 'Doji with a long upper shadow and virtually no lower shadow.'),
      ('HAMMER', 'CANDLESTICK', 'candlestick-v2', 'Lower-shadow reversal shape confirmed after a decline.'),
      ('INVERTED_HAMMER', 'CANDLESTICK', 'candlestick-v2', 'Upper-shadow reversal shape confirmed after a decline at support.'),
      ('HANGING_MAN', 'CANDLESTICK', 'candlestick-v2', 'Lower-shadow warning shape confirmed after an advance.'),
      ('SHOOTING_STAR', 'CANDLESTICK', 'candlestick-v2', 'Upper-shadow reversal shape confirmed after an advance.'),
      ('SPINNING_TOP', 'CANDLESTICK', 'candlestick-v2', 'Small real body with roughly balanced upper and lower shadows.'),
      ('BULLISH_ENGULFING', 'CANDLESTICK', 'candlestick-v2', 'Bullish real body engulfs the preceding bearish body.'),
      ('BEARISH_ENGULFING', 'CANDLESTICK', 'candlestick-v2', 'Bearish real body engulfs the preceding bullish body.'),
      ('MORNING_STAR', 'CANDLESTICK', 'candlestick-v2', 'Three-candle bullish reversal sequence after a decline.'),
      ('EVENING_STAR', 'CANDLESTICK', 'candlestick-v2', 'Three-candle bearish reversal sequence after an advance.'),
      ('BULLISH_HARAMI', 'CANDLESTICK', 'candlestick-v2', 'Small bullish body sits inside a preceding bearish body.'),
      ('BEARISH_HARAMI', 'CANDLESTICK', 'candlestick-v2', 'Small bearish body sits inside a preceding bullish body.'),
      ('THREE_WHITE_SOLDIERS', 'CANDLESTICK', 'candlestick-v2', 'Three consecutive advancing bullish candles.'),
      ('THREE_BLACK_CROWS', 'CANDLESTICK', 'candlestick-v2', 'Three consecutive declining bearish candles.'),
      ('INSIDE_BAR', 'CANDLESTICK', 'candlestick-v2', 'Current range is contained in the preceding range.'),
      ('OUTSIDE_BAR', 'CANDLESTICK', 'candlestick-v2', 'Current range contains the preceding range.'),
      ('PIERCING_LINE', 'CANDLESTICK', 'candlestick-v2', 'Bullish reversal opening below prior low and closing above midpoint of prior bearish body.'),
      ('DARK_CLOUD_COVER', 'CANDLESTICK', 'candlestick-v2', 'Bearish reversal opening above prior high and closing below midpoint of prior bullish body.'),
      ('TWEEZER_BOTTOM', 'CANDLESTICK', 'candlestick-v2', 'Two consecutive candles with matching lows within volatility tolerance.'),
      ('TWEEZER_TOP', 'CANDLESTICK', 'candlestick-v2', 'Two consecutive candles with matching highs within volatility tolerance.'),
      ('BULLISH_MARUBOZU', 'CANDLESTICK', 'candlestick-v2', 'Strong bullish candle with long body and minimal shadows.'),
      ('BEARISH_MARUBOZU', 'CANDLESTICK', 'candlestick-v2', 'Strong bearish candle with long body and minimal shadows.'),
      ('THREE_INSIDE_UP', 'CANDLESTICK', 'candlestick-v2', 'Bullish Harami followed by a third bullish candle closing above the first candle open.'),
      ('THREE_INSIDE_DOWN', 'CANDLESTICK', 'candlestick-v2', 'Bearish Harami followed by a third bearish candle closing below the first candle open.')
    ON CONFLICT (pattern_code, algorithm_version) DO NOTHING;

    -- Marked, not deleted: stored v1 rows and their foreign keys stay intact for audit.
    UPDATE pattern_definitions
       SET superseded_at = COALESCE(superseded_at, CURRENT_TIMESTAMP),
           superseded_by_version = 'candlestick-v2'
     WHERE algorithm_version = 'candlestick-v1'
       AND category = 'CANDLESTICK';

    ALTER TABLE pattern_detections ADD COLUMN IF NOT EXISTS known_at TIMESTAMPTZ;
    ALTER TABLE price_action_events ADD COLUMN IF NOT EXISTS known_at TIMESTAMPTZ;

    UPDATE pattern_detections AS d
       SET known_at = c.close_time
      FROM candles AS c
     WHERE c.id = d.candle_id AND d.known_at IS NULL;

    UPDATE price_action_events AS e
       SET known_at = c.close_time
      FROM candles AS c
     WHERE c.id = e.candle_id AND e.known_at IS NULL;

    ALTER TABLE pattern_detections ALTER COLUMN known_at SET NOT NULL;
    ALTER TABLE price_action_events ALTER COLUMN known_at SET NOT NULL;

    CREATE OR REPLACE FUNCTION set_pattern_evidence_known_at() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.known_at IS NULL THEN
          SELECT close_time INTO NEW.known_at FROM candles WHERE id = NEW.candle_id;
        END IF;
      ELSE
        -- The earliest knowledge time wins; a re-detection never moves it later.
        NEW.known_at := LEAST(OLD.known_at, COALESCE(NEW.known_at, OLD.known_at));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS pattern_detections_known_at_insert ON pattern_detections;
    CREATE TRIGGER pattern_detections_known_at_insert
      BEFORE INSERT ON pattern_detections
      FOR EACH ROW EXECUTE FUNCTION set_pattern_evidence_known_at();
    DROP TRIGGER IF EXISTS pattern_detections_known_at_update ON pattern_detections;
    CREATE TRIGGER pattern_detections_known_at_update
      BEFORE UPDATE ON pattern_detections
      FOR EACH ROW EXECUTE FUNCTION set_pattern_evidence_known_at();

    DROP TRIGGER IF EXISTS price_action_events_known_at_insert ON price_action_events;
    CREATE TRIGGER price_action_events_known_at_insert
      BEFORE INSERT ON price_action_events
      FOR EACH ROW EXECUTE FUNCTION set_pattern_evidence_known_at();
    DROP TRIGGER IF EXISTS price_action_events_known_at_update ON price_action_events;
    CREATE TRIGGER price_action_events_known_at_update
      BEFORE UPDATE ON price_action_events
      FOR EACH ROW EXECUTE FUNCTION set_pattern_evidence_known_at();
  `,
};
