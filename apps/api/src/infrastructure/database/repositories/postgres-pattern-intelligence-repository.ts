import {
  calculateObservationLogicalKey,
} from "../../../modules/pattern-intelligence/domain/canonical-hash.js";
import type {
  AnyDetectedPattern,
  PatternCoverageRecord,
  PatternCoverageRecorder,
  PatternDefinition,
  PatternDefinitionRegistry,
  PatternLifecycleEvent,
  PatternObservationLedger,
} from "../../../modules/pattern-intelligence/domain/contracts.js";
import {
  registeredPatternDefinitions,
  type RegisteredPatternDefinition,
} from "../../../modules/pattern-intelligence/domain/pattern-definition-registry.js";
import type { Pool } from "pg";
import type { PatternObservationSummary } from "../../../modules/pattern-intelligence/domain/observation-summary.js";
import type { DatabaseQueryable } from "../database.js";

/**
 * Postgres storage for Pattern Intelligence V1.0.1.
 *
 * Reads and writes only the `*_v2` tables from migration 084. It never touches `pattern_detections`
 * or `price_action_events` — the incumbent module keeps its own store, and the two coexist without
 * either reading the other.
 */

/** Writes the frozen definition records, so the Implementation Gate has something to check against. */
export class PostgresPatternDefinitionRegistry implements PatternDefinitionRegistry {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Registers the frozen records, refusing rather than overwriting on a hash change.
   *
   * A definition whose stored hash differs from the code's is not a row to update — it means the
   * detection rules moved without a version bump, and observations already stored against the old
   * hash were produced under rules that no longer exist. Silently rewriting the row would make those
   * observations cite a specification that never generated them. The fix is always a new
   * `definitionVersion`, never an edit, which is why this throws instead of upserting.
   */
  async registerFrozenDefinitions(): Promise<{ inserted: number; alreadyPresent: number }> {
    let inserted = 0;
    let alreadyPresent = 0;
    for (const definition of registeredPatternDefinitions) {
      const existing = await this.database.query<{ definition_hash: string }>(
        `SELECT definition_hash FROM pattern_definitions_v2
          WHERE definition_id = $1 AND definition_version = $2`,
        [definition.definitionId, definition.definitionVersion],
      );
      const stored = existing.rows[0];
      if (stored) {
        if (stored.definition_hash !== definition.definitionHash) {
          throw new Error(
            `${definition.definitionId}@${definition.definitionVersion} is stored with hash `
            + `${stored.definition_hash} but the code now produces ${definition.definitionHash}. A `
            + "changed specification requires a new definitionVersion; observations already recorded "
            + "against the stored hash were produced under the old rules.",
          );
        }
        alreadyPresent++;
        continue;
      }
      await this.database.query(
        `INSERT INTO pattern_definitions_v2
           (definition_id, definition_version, family, parameters, invalidation_conditions,
            definition_hash, derived_from_implementation, frozen_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, $7, $8)
         ON CONFLICT (definition_id, definition_version) DO NOTHING`,
        [
          definition.definitionId, definition.definitionVersion, definition.family,
          JSON.stringify(definition.parameters), [...definition.invalidationConditions],
          definition.definitionHash, definition.derivedFromImplementation, definition.frozenAt,
        ],
      );
      inserted++;
    }
    return { inserted, alreadyPresent };
  }

  /**
   * Rehydrates the *whole* frozen record, `derived_from_implementation` included.
   *
   * That column is not decoration here — `recordDetectedPattern` re-derives
   * `calculateDefinitionHash` from whatever this returns and refuses the write on a mismatch. Since
   * the hash covers every non-hash field, dropping one on the way out of the database makes the
   * recomputation disagree with the stored hash and rejects every observation. The failure is loud,
   * which is the design working: a definition that cannot be reconstructed byte-for-byte is not a
   * definition an observation may cite.
   */
  async findFrozen(input: { definitionId: string; definitionVersion: string }): Promise<RegisteredPatternDefinition | null> {
    const result = await this.database.query<{
      definition_id: string; definition_version: string; family: string;
      parameters: Record<string, unknown>; invalidation_conditions: string[];
      definition_hash: string; derived_from_implementation: boolean; frozen_at: Date;
    }>(
      `SELECT definition_id, definition_version, family, parameters, invalidation_conditions,
              definition_hash, derived_from_implementation, frozen_at
         FROM pattern_definitions_v2
        WHERE definition_id = $1 AND definition_version = $2`,
      [input.definitionId, input.definitionVersion],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      definitionId: row.definition_id,
      definitionVersion: row.definition_version,
      family: row.family as PatternDefinition["family"],
      parameters: row.parameters,
      invalidationConditions: row.invalidation_conditions,
      definitionHash: row.definition_hash,
      derivedFromImplementation: row.derived_from_implementation,
      frozenAt: new Date(row.frozen_at),
    };
  }
}

export class PostgresPatternObservationLedger implements PatternObservationLedger {
  /**
   * Rows this ledger actually inserted, and rows an earlier pass had already stored.
   *
   * Counted because the domain contract returns void and the caller otherwise cannot tell the two
   * apart: a re-scan legitimately "records" every observation it re-finds while inserting none of
   * them, so reporting the seal count as a write count would claim thousands of rows were stored on
   * a run that stored nothing.
   */
  insertedCount = 0;
  deduplicatedCount = 0;

  constructor(private readonly pool: Pool, private readonly instrumentId: string) {}

  /**
   * Writes the master record and its sequence-1 DETECTED event in one transaction, or neither.
   *
   * The contract requires atomicity because an observation without its opening lifecycle event is
   * unfalsifiable — nothing can ever invalidate or expire it, so it would sit in the store as a
   * permanently open claim.
   *
   * `ON CONFLICT (logical_key) DO NOTHING` is what makes the detector re-runnable: a re-scan of an
   * overlapping window re-derives the same logical key and the insert is a no-op. When it is a no-op
   * the lifecycle insert is skipped too, since the existing row already owns its event chain and
   * appending a second DETECTED would break the sequence.
   */
  async insertObservationWithInitialEvent(input: {
    observation: AnyDetectedPattern;
    initialEvent: PatternLifecycleEvent;
  }): Promise<void> {
    const { observation, initialEvent } = input;
    const logicalKey = calculateObservationLogicalKey(observation);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ observation_id: string }>(
        `INSERT INTO pattern_observations_v2 (
           observation_id, instrument_id, pattern_family, pattern_subtype, orientation,
           timeframe, instrument_type, contract_symbol, contract_expiry, contract_role,
           data_vintage_id, data_vintage_at,
           definition_id, definition_version, definition_hash,
           start_at, data_through, detected_at, known_at, earliest_execution_at,
           duration_bars, range_bps, range_atr,
           trend_state, session_segment, volume_zscore, range_zscore, effort_result_divergence,
           details, engine_version, config_version, config_hash, data_source, data_schema_version,
           observation_hash, logical_key
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25, $26, $27, $28, $29::jsonb, $30, $31, $32, $33, $34, $35, $36
         )
         ON CONFLICT (logical_key) DO NOTHING
         RETURNING observation_id`,
        [
          observation.identity.observationId, this.instrumentId, observation.identity.patternFamily,
          observation.identity.patternSubtype, observation.identity.orientation,
          observation.source.timeframe, observation.source.instrumentType, observation.source.contractSymbol,
          observation.source.contractExpiry, observation.source.contractRole,
          observation.source.dataVintageId, observation.source.dataVintageAt,
          observation.definitionRef.definitionId, observation.definitionRef.definitionVersion,
          observation.definitionRef.definitionHash,
          observation.timing.startAt, observation.timing.dataThrough, observation.timing.detectedAt,
          observation.timing.knownAt, observation.timing.earliestExecutionAt,
          observation.geometry.durationBars, observation.geometry.rangeBps, observation.geometry.rangeAtr,
          observation.context.trendState, observation.context.sessionSegment,
          observation.context.volumeZscore, observation.context.rangeZscore,
          observation.context.effortResultDivergence,
          JSON.stringify(observation.details),
          observation.provenance.engineVersion, observation.provenance.configVersion,
          observation.provenance.configHash, observation.provenance.dataSource,
          observation.provenance.dataSchemaVersion, observation.provenance.observationHash,
          logicalKey,
        ],
      );

      // Already stored by an earlier pass. Its lifecycle chain belongs to that row, and appending a
      // second DETECTED would break the sequence.
      if (inserted.rows.length === 0) this.deduplicatedCount++;
      else this.insertedCount++;

      if (inserted.rows.length > 0) {
        await client.query(
          `INSERT INTO pattern_lifecycle_events_v2 (
             event_id, observation_id, event_schema_version, event_type,
             data_through, event_time, known_at, sequence_number, idempotency_key, cause
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            initialEvent.eventId, observation.identity.observationId, initialEvent.eventSchemaVersion,
            initialEvent.eventType, initialEvent.dataThrough, initialEvent.eventTime,
            initialEvent.knownAt, initialEvent.sequenceNumber, initialEvent.idempotencyKey,
            initialEvent.cause,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresPatternCoverageRecorder implements PatternCoverageRecorder {
  constructor(private readonly database: DatabaseQueryable, private readonly instrumentId: string) {}

  /**
   * `recorded_at` is first-cover stable; the counts describe the most recent pass.
   *
   * These are two different facts and only one of them may be frozen. `recorded_at` answers "when did
   * this window first become covered", which is what a reader needs to know whether its read raced
   * the detector -- advancing it on every re-run would degrade it into the most-recent-write field
   * that made `pattern_detections.detected_at` unable to date anything. So it is explicitly excluded
   * from the update below.
   *
   * `candles_evaluated` and `patterns_found` are the opposite: they are a *denominator*, and a stale
   * one silently understates. Not hypothetical -- healing 11 confirmed 5m collection gaps on
   * 2026-08-26 added three whole missing sessions inside an already-covered window, so `DO NOTHING`
   * would have left the row claiming 1,079 evaluated bars over a window that now holds more.
   * Comparing a sparse pattern family against that figure would divide by the wrong number.
   */
  async recordCoverage(record: PatternCoverageRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO pattern_coverage_v2 (
         coverage_id, instrument_id, timeframe, from_time, to_time,
         candles_evaluated, patterns_found, engine_version, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (instrument_id, timeframe, from_time, to_time, engine_version) DO UPDATE
         SET candles_evaluated = EXCLUDED.candles_evaluated,
             patterns_found = EXCLUDED.patterns_found`,
      [
        record.coverageId, this.instrumentId, record.source.timeframe,
        record.fromTime, record.toTime, record.candlesEvaluated, record.patternsFound,
        record.engineVersion, record.recordedAt,
      ],
    );
  }
}


/**
 * Which observations a read is allowed to see, stated at the call site because the two answer
 * different questions and only one of them can support a tradeable claim.
 *
 * - `POINT_IN_TIME` — only what was knowable by `knownBy`. The honest basis for "would this signal
 *   have helped?", and the only basis a strategy may use.
 * - `RETROSPECTIVE` — every observation on the bar, regardless of when the detector computed it.
 *   Valid for "does this pattern coincide with that outcome?", and invalid for any claim about
 *   tradeability, because a backfilled detector knows things the decision-maker did not.
 *
 * This is a discriminated union rather than an optional `asOf` on purpose. Measured on the live
 * store: joining the harness's 2,998 control points to backfilled 1m observations returns 1,398
 * matches retrospectively and **0** point-in-time, because detection ran two days after those
 * decisions. An optional filter would make the leaky reading the default and the difference between
 * a real result and a fabricated one a forgotten argument.
 */
export type PatternObservationVisibility =
  | { mode: "POINT_IN_TIME"; knownBy: Date }
  | { mode: "RETROSPECTIVE" };

export class PostgresPatternObservationReader {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * The observations attached to one bar, under an explicitly chosen visibility rule.
   *
   * `POINT_IN_TIME` filters on `known_at`, never on `detected_at`. Those differ whenever the detector
   * runs behind the tape: a backfill stamps `known_at` at the vintage it actually ran, so a consumer
   * replaying that bar must not see an observation that did not yet exist when the decision was
   * taken. Filtering on `detected_at` would leak the future in exactly the way this module's
   * point-in-time fields exist to prevent.
   */
  async findForBar(input: {
    instrumentId: string;
    timeframe: string;
    detectedAt: Date;
    visibility: PatternObservationVisibility;
  }): Promise<PatternObservationSummary[]> {
    // Narrowed off the discriminant directly; a boolean flag loses the union narrowing.
    const knownBy = input.visibility.mode === "POINT_IN_TIME" ? input.visibility.knownBy : null;
    const result = await this.database.query<Record<string, never>>(
      `SELECT observation_id, pattern_family, pattern_subtype, orientation,
              definition_id, definition_version, definition_hash,
              detected_at, known_at, earliest_execution_at,
              duration_bars, range_bps, range_atr,
              trend_state, session_segment, volume_zscore, range_zscore, effort_result_divergence,
              details
         FROM pattern_observations_v2
        WHERE instrument_id = $1 AND timeframe = $2 AND detected_at = $3
          AND ($4::timestamptz IS NULL OR known_at <= $4)
        ORDER BY pattern_family, pattern_subtype, observation_id`,
      [
        input.instrumentId, input.timeframe, input.detectedAt,
        knownBy,
      ],
    );
    return result.rows.map((row) => {
      const r = row as unknown as Record<string, unknown>;
      return {
        observationId: String(r.observation_id),
        patternFamily: String(r.pattern_family),
        patternSubtype: String(r.pattern_subtype),
        orientation: r.orientation as PatternObservationSummary["orientation"],
        definitionId: String(r.definition_id),
        definitionVersion: String(r.definition_version),
        definitionHash: String(r.definition_hash),
        detectedAt: new Date(r.detected_at as string),
        knownAt: new Date(r.known_at as string),
        earliestExecutionAt: new Date(r.earliest_execution_at as string),
        durationBars: Number(r.duration_bars),
        rangeBps: Number(r.range_bps),
        rangeAtr: Number(r.range_atr),
        trendState: String(r.trend_state),
        sessionSegment: String(r.session_segment),
        volumeZscore: r.volume_zscore === null ? null : Number(r.volume_zscore),
        rangeZscore: r.range_zscore === null ? null : Number(r.range_zscore),
        effortResultDivergence: r.effort_result_divergence === null ? null : Number(r.effort_result_divergence),
        details: (r.details ?? {}) as Record<string, unknown>,
      };
    });
  }

  /**
   * Whether the detector has covered the window containing this bar.
   *
   * Without this a consumer cannot tell an empty `findForBar` result from a bar the detector has not
   * reached — the ambiguity migration 079 exists to close, restated for this module. A consumer that
   * treats "uncovered" as "no patterns" reproduces the 46%-blind-read defect.
   */
  async isBarCovered(input: {
    instrumentId: string;
    timeframe: string;
    barOpenTime: Date;
    visibility: PatternObservationVisibility;
  }): Promise<boolean> {
    // Narrowed off the discriminant directly; a boolean flag loses the union narrowing.
    const knownBy = input.visibility.mode === "POINT_IN_TIME" ? input.visibility.knownBy : null;
    const result = await this.database.query<{ covered: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pattern_coverage_v2
          WHERE instrument_id = $1 AND timeframe = $2
            AND from_time <= $3 AND to_time >= $3
            AND ($4::timestamptz IS NULL OR recorded_at <= $4)
       ) AS covered`,
      [
        input.instrumentId, input.timeframe, input.barOpenTime,
        knownBy,
      ],
    );
    return result.rows[0]?.covered === true;
  }
}
