import type { Migration } from "../migration-runner.js";

/**
 * Gives the autonomous agent its own strategy identity, and repairs the ideas it mislabelled.
 *
 * ## The defect
 *
 * `ai-autonomous-agent.ts` stamped every proposal it persisted with
 *
 *     SELECT id FROM strategy_versions WHERE is_active = TRUE LIMIT 1
 *
 * No ORDER BY, no filter to its own engine -- and seven versions are active, so the row returned is
 * whatever the planner hands back. Measured 2026-09-03: all **8** ideas ever attributed to
 * `trend-breakout` carry "source": "AI_AUTONOMOUS_AGENT" in their evidence. They are the agent's
 * proposals wearing another strategy's name, and **3 of them became real trades**.
 *
 * `trend-breakout` has therefore produced zero ideas of its own, ever. An earlier reading of its
 * 7-idea history as "5m ideas predating a registry change" was wrong for this reason.
 *
 * ## Why a new strategy rather than a better query
 *
 * The agent is not a registered strategy. It scores with `scoreDirectionalSetup`, which Section 6
 * quarantines, and it appears in no bot roster. There is no correct row for it to point at, so
 * picking a *better* arbitrary row would only make the misattribution less obvious. It needs its own
 * identity, and then every per-strategy idea count means what it says.
 *
 * ## Why the version is is_active = FALSE, which looks wrong and is not
 *
 * `is_active` is read by two callers that pick "the" active version arbitrarily:
 * `backtesting.routes.ts` takes `ORDER BY created_at DESC LIMIT 1`, and the market-scanner query
 * filters on it. A newly inserted active row is the newest, so marking this active would silently
 * redirect the backtest default to the agent's configuration -- swapping one arbitrary-pick bug for
 * a worse one, on the day it was fixed.
 *
 * The agent resolves its own version by `strategy_key` and does not consult `is_active`, so nothing
 * about its operation depends on the flag. The honest reading of this row is "a real producer, and
 * deliberately not a candidate for anything that asks the database to nominate a strategy". Those
 * two callers picking arbitrarily is a separate defect and is not fixed here.
 *
 * ## The repair is exact, not heuristic
 *
 * `evidence->>'source'` records the true producer on every row the agent wrote, so the affected ideas
 * are identifiable individually rather than inferred from timing or shape. Only those rows move. The
 * `updated_at` touch trigger will fire on them, which is correct: this is a correction, and it should
 * be visible as one.
 */
export const autonomousAgentStrategyIdentityMigration: Migration = {
  id: "096-autonomous-agent-strategy-identity",
  sql: `
    INSERT INTO strategies (strategy_key, name, description)
    VALUES (
      'ai-autonomous-agent',
      'AI Autonomous Agent',
      'The autonomous decision engine behind AI_AGENT_TICK. Not a registered strategy: it appears in '
      'no bot roster and scores with the composite that Brain V2.2 Section 6 quarantines. Exists so '
      'its proposals are attributable to it rather than to whichever strategy an unordered '
      'is_active LIMIT 1 happened to return. See migration 096.'
    )
    ON CONFLICT (strategy_key) DO NOTHING;

    -- is_active FALSE on purpose; see the note above on the two callers that pick arbitrarily.
    INSERT INTO strategy_versions (strategy_id, version, configuration, is_active)
    SELECT id, 1,
           jsonb_build_object(
             'configuredInCode', true,
             'source', 'AI_AUTONOMOUS_AGENT',
             'note', 'The agent has no registry-driven configuration; its thresholds live in '
                     'ai-autonomous-agent.ts. Recorded as an object rather than left empty so a '
                     'reader is not left wondering whether the configuration was lost.'
           ),
           FALSE
    FROM strategies WHERE strategy_key = 'ai-autonomous-agent'
    ON CONFLICT (strategy_id, version) DO NOTHING;

    /*
     * Repair. Exact, because the agent recorded its own identity in the evidence payload even while
     * the foreign key pointed elsewhere.
     */
    UPDATE trade_ideas
    SET strategy_version_id = (
      SELECT sv.id FROM strategy_versions sv
      JOIN strategies s ON s.id = sv.strategy_id
      WHERE s.strategy_key = 'ai-autonomous-agent' AND sv.version = 1
    )
    WHERE evidence->>'source' = 'AI_AUTONOMOUS_AGENT'
      AND strategy_version_id <> (
        SELECT sv.id FROM strategy_versions sv
        JOIN strategies s ON s.id = sv.strategy_id
        WHERE s.strategy_key = 'ai-autonomous-agent' AND sv.version = 1
      );

    COMMENT ON TABLE strategies IS
      'Strategy identities. Includes ai-autonomous-agent, which is NOT a registered strategy and is '
      'in no bot roster -- it exists so the agent''s proposals are attributable to the agent. Before '
      'migration 096 they were stamped with an unordered is_active LIMIT 1, which put 8 of them under '
      'trend-breakout and made 3 real trades unattributable.';
  `,
};
