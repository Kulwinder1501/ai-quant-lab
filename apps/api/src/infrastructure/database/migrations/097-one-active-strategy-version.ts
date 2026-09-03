import type { Migration } from "../migration-runner.js";

/**
 * Leaves exactly one active version per strategy, and stops the drift recurring.
 *
 * ## Why two versions were active
 *
 * `is_active` defaults to TRUE and `StrategyVersionRepository.ensure` never sets it, so **every
 * version bump left its predecessor active**. Measured 2026-09-03:
 *
 * | strategy | code declares | active in the database | ideas on the stale row |
 * | :--- | ---: | :--- | ---: |
 * | momentum-scalp | 3 | 2 and 3 | 0 |
 * | trend-breakout | 2 | 1 and 2 | 0 |
 *
 * Both stale rows carry **zero** trade ideas, so deactivating them orphans nothing. That is not
 * luck: `ensure` resolves by `(strategy_id, version)` using the version the *code* declares, so the
 * generator never asked for the stale row. The ambiguity only ever reached the callers that ask the
 * database to nominate a version -- `backtesting.routes.ts` takes `ORDER BY created_at DESC LIMIT 1`,
 * and the market-scanner query filters on the flag.
 *
 * ## Deactivated by name rather than by rule
 *
 * The two rows are named explicitly. A clever predicate -- "deactivate anything with no ideas", say
 * -- would also match a version legitimately bumped minutes ago that has not yet produced one, and
 * this migration runs on every deploy. Naming them makes the change auditable and impossible to
 * over-apply.
 *
 * ## The index needs the writer fixed first
 *
 * A partial unique index on `(strategy_id) WHERE is_active` is what makes the invariant structural.
 * On its own it would turn the next routine version bump into an outage: `ensure` inserts a new
 * version with the default TRUE while the previous one is still active, so the insert would violate
 * the index and idea generation would throw. `ensure` is changed in the same commit to deactivate a
 * strategy's other versions before activating the one the code declares, which keeps the index
 * satisfiable and makes the database follow the code.
 *
 * Zero active versions is permitted by the index, deliberately: `ai-autonomous-agent` is inactive on
 * purpose (migration 096), and `ensure`'s two-step update passes briefly through zero rather than
 * through two.
 */
export const oneActiveStrategyVersionMigration: Migration = {
  id: "097-one-active-strategy-version",
  sql: `
    -- Named explicitly. Both carry zero trade ideas; see the note above on why a predicate would be
    -- the wrong instrument here.
    UPDATE strategy_versions sv
    SET is_active = FALSE
    FROM strategies s
    WHERE s.id = sv.strategy_id
      AND sv.is_active
      AND (
        (s.strategy_key = 'momentum-scalp' AND sv.version = 2)
        OR (s.strategy_key = 'trend-breakout' AND sv.version = 1)
      );

    /*
     * The invariant, structural from here. Partial so it constrains only the active row, and unique
     * on the strategy so a second one cannot exist. Zero is allowed -- see the note on 096 and on
     * ensure's two-step update.
     */
    CREATE UNIQUE INDEX IF NOT EXISTS strategy_versions_one_active_per_strategy
      ON strategy_versions (strategy_id) WHERE is_active;

    COMMENT ON INDEX strategy_versions_one_active_per_strategy IS
      'At most one active version per strategy. is_active defaults to TRUE and ensure() never set '
      'it, so every version bump used to leave its predecessor active -- momentum-scalp had 2 and 3, '
      'trend-breakout had 1 and 2, and the callers that ask the database to nominate "the" active '
      'version were choosing arbitrarily between them. Zero active is permitted: the agent version '
      'is inactive by design and ensure() passes through zero rather than two. See migration 097.';
  `,
};
