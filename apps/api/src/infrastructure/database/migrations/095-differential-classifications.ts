import type { Migration } from "../migration-runner.js";

/**
 * Lets a divergence be classified, which nothing could do before.
 *
 * ## Why this blocked everything downstream
 *
 * `run-shadow-decisions` hardcoded every divergence as `UNKNOWN`, and `promotionBlocker` makes
 * `UNKNOWN` a promotion blocker by design. There was no table, no write path and no CLI, so P13 could
 * never reach `promotable: true` — not as a matter of evidence but as a matter of mechanism. The
 * shadow path was about to produce its first real divergences with nothing able to resolve any of
 * them.
 *
 * ## Append-only, with revisions rather than updates
 *
 * A classification legitimately changes: a `BUG` carries `resolutionRef: null` until it is fixed, and
 * §6's rule turns on whether it is *resolved*. So a correction appends a new revision and the highest
 * revision wins, rather than editing the row — the history of how a divergence was understood is
 * itself part of the evidence, and this system has twice been misled by a record that was quietly
 * rewritten.
 *
 * `revision` is explicit and unique per observation rather than ordering by `classified_at`. Two
 * classifications written in the same clock tick would otherwise have no defined order, and the
 * uniqueness makes a concurrent double-write collide loudly instead of silently picking one. Same
 * reasoning as the ledger's `aggregate_version`.
 *
 * ## Three invariants the database enforces, not the caller
 *
 * 1. **Only a divergence may be classified.** `agreed` is a generated column on the observation, so a
 *    foreign key cannot express this; a trigger looks it up. Classifying an agreement is meaningless,
 *    and a meaningless row in a population the gate counts is the failure mode this whole table
 *    exists to serve.
 * 2. **The evidence must match the kind.** `DivergenceEvidence` is a discriminated union where each
 *    arm requires different fields — `designDecision` for an expected change, both boundaries for a
 *    data difference, `resolutionRef` for a bug. A `CHECK` per kind makes "classified without the
 *    required evidence" unrepresentable, which is the entire point of the type. Without it the JSONB
 *    would accept `{}` under any label and the classification would be a label rather than a claim.
 * 3. **The observation must exist**, by composite foreign key on the same three columns that identify
 *    it — including `producer_id`, because native and ported are separate populations and a
 *    classification belongs to one of them.
 *
 * ## `UNKNOWN` is storable on purpose
 *
 * Absence already means unclassified. An explicit `UNKNOWN` row means something different and worth
 * keeping: a human looked and could not classify it. Both block promotion identically, but only one
 * of them tells the next reader that the work was attempted.
 */
export const differentialClassificationsMigration: Migration = {
  id: "095-differential-classifications",
  sql: `
    CREATE TABLE IF NOT EXISTS differential_classifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      comparison_key TEXT NOT NULL,
      comparison_version TEXT NOT NULL,
      producer_id TEXT NOT NULL,
      -- Highest revision wins. Explicit so ordering never depends on the clock.
      revision INTEGER NOT NULL CHECK (revision >= 1),
      kind TEXT NOT NULL CHECK (kind IN (
        'EXPECTED_ARCHITECTURAL_CHANGE', 'DATA_DIFFERENCE', 'POLICY_DIFFERENCE', 'RISK_DIFFERENCE',
        'EXECUTION_DIFFERENCE', 'BUG', 'UNKNOWN'
      )),
      evidence JSONB NOT NULL,
      /*
       * Who decided, and why. The rationale supplements the evidence and never substitutes for it:
       * the CHECK below is what makes a classification a claim rather than a label.
       */
      classified_by TEXT NOT NULL CHECK (length(trim(classified_by)) > 0),
      rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
      classified_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT differential_classifications_unique_revision
        UNIQUE (comparison_key, comparison_version, producer_id, revision),
      CONSTRAINT differential_classifications_observation_exists
        FOREIGN KEY (comparison_key, comparison_version, producer_id)
        REFERENCES differential_observations (comparison_key, comparison_version, producer_id),

      -- Each kind requires its own evidence. Anything less is a label, not a classification.
      CONSTRAINT differential_classifications_evidence_matches_kind CHECK (
        (kind = 'EXPECTED_ARCHITECTURAL_CHANGE'
          AND evidence ? 'designDecision'
          AND length(trim(evidence->>'designDecision')) > 0)
        OR (kind = 'DATA_DIFFERENCE'
          AND evidence ? 'legacyBoundary' AND length(trim(evidence->>'legacyBoundary')) > 0
          AND evidence ? 'v2Boundary' AND length(trim(evidence->>'v2Boundary')) > 0)
        OR (kind = 'POLICY_DIFFERENCE'
          AND evidence ? 'legacyPolicyVersion' AND length(trim(evidence->>'legacyPolicyVersion')) > 0
          AND evidence ? 'v2PolicyVersion' AND length(trim(evidence->>'v2PolicyVersion')) > 0)
        OR (kind = 'RISK_DIFFERENCE'
          AND evidence ? 'riskRule' AND length(trim(evidence->>'riskRule')) > 0)
        OR (kind = 'EXECUTION_DIFFERENCE'
          AND evidence ? 'executionCondition'
          AND length(trim(evidence->>'executionCondition')) > 0)
        -- resolutionRef must be PRESENT and may be null: null is "not yet fixed", absent is an
        -- unanswered question, and Section 6 turns on the difference.
        OR (kind = 'BUG' AND evidence ? 'resolutionRef')
        OR (kind = 'UNKNOWN' AND evidence = '{}'::jsonb)
      )
    );

    CREATE INDEX IF NOT EXISTS differential_classifications_latest_idx
      ON differential_classifications (comparison_version, producer_id, comparison_key, revision DESC);

    /*
     * Only a divergence may be classified. agreed is generated on the observation, so this cannot
     * be a foreign key or a column CHECK -- it has to be looked up.
     */
    CREATE OR REPLACE FUNCTION reject_classification_of_agreement()
    RETURNS TRIGGER AS $$
    DECLARE
      observation_agreed BOOLEAN;
    BEGIN
      SELECT agreed INTO observation_agreed
      FROM differential_observations
      WHERE comparison_key = NEW.comparison_key
        AND comparison_version = NEW.comparison_version
        AND producer_id = NEW.producer_id;

      IF observation_agreed IS NULL THEN
        -- The foreign key should already have refused this; belt and braces, and a clearer message.
        RAISE EXCEPTION
          'No differential observation for % / % / %, so there is nothing to classify.',
          NEW.comparison_key, NEW.comparison_version, NEW.producer_id;
      END IF;

      IF observation_agreed THEN
        RAISE EXCEPTION
          'Refusing to classify % / % / %: the two systems agreed, so there is no divergence. A '
          'classification on an agreement is meaningless, and the promotion gate counts rows.',
          NEW.comparison_key, NEW.comparison_version, NEW.producer_id;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS differential_classifications_require_divergence
      ON differential_classifications;
    CREATE TRIGGER differential_classifications_require_divergence
      BEFORE INSERT ON differential_classifications
      FOR EACH ROW EXECUTE FUNCTION reject_classification_of_agreement();

    CREATE OR REPLACE FUNCTION reject_differential_classification_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION
        'differential_classifications is append-only: % is refused. A classification is a record of '
        'what somebody concluded and why; editing it rewrites the reasoning the promotion gate rests '
        'on. Append a higher revision instead -- the highest revision wins, and the earlier one stays '
        'as the history of how the divergence was understood.',
        TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS differential_classifications_reject_mutation
      ON differential_classifications;
    CREATE TRIGGER differential_classifications_reject_mutation
      BEFORE UPDATE OR DELETE ON differential_classifications
      FOR EACH ROW EXECUTE FUNCTION reject_differential_classification_mutation();

    COMMENT ON TABLE differential_classifications IS
      'Brain P13 divergence classifications. Append-only with explicit revisions; highest revision '
      'wins. The evidence CHECK enforces that each kind carries the fields its DivergenceEvidence arm '
      'requires, and a trigger refuses classifying an observation whose two sides agreed. An explicit '
      'UNKNOWN row means a human looked and could not classify; absence means nobody has looked. '
      'See migration 095.';
  `,
};
