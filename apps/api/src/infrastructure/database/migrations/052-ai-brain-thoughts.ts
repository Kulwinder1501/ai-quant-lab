import type { Migration } from "../migration-runner.js";

/**
 * Persists the autonomous agent's thought stream, which was in-memory only.
 *
 * `AiAutonomousAgent` held its thoughts in a private array and served them straight from it, which
 * worked for exactly as long as the process that produced them was the process that answered the
 * dashboard. It no longer is: the agent tick moved out of `GET /api/v1/stream/live-agent` into the
 * scheduler's `AI_AGENT_TICK` job, because a GET that mutates paper trades bypassed the mutation
 * rate limiter and only ran while a browser tab happened to be open. After that move the API's own
 * agent instance never ticks, so its array stays empty and the dashboard's brain panel renders
 * nothing while the agent is in fact running normally in another process.
 *
 * Reflections were already persisted, which is why they kept working and thoughts did not -- the
 * panel showed six reflections beside zero thoughts, which is the shape of this bug.
 *
 * Persisting is better than the arrangement it replaces regardless of process boundaries: the old
 * array was also lost on every API restart, so the panel silently began each deploy blank.
 *
 * `details` stays `jsonb` because a thought's payload differs by action -- an EXECUTING thought
 * carries a contract and premiums, a MONITORING one carries a refusal reason -- and pinning columns
 * for the union of those would invent a schema the producer does not have.
 */
export const aiBrainThoughtsMigration: Migration = {
  id: "052-ai-brain-thoughts",
  sql: `
    CREATE TABLE IF NOT EXISTS ai_brain_thoughts (
      id            text PRIMARY KEY,
      timestamp     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      symbol        text NOT NULL,
      action        text NOT NULL,
      confidence    numeric(5,2) NOT NULL,
      message       text NOT NULL,
      details       jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- Which process wrote it. The scheduler, a manual CLI run and the API are all plausible
      -- authors, and "the agent said nothing today" reads very differently from "the scheduler
      -- never ran", so the author is recorded rather than inferred.
      recorded_by   text NOT NULL DEFAULT 'unknown'
    );

    -- The only read pattern is "the most recent N", optionally for one symbol.
    CREATE INDEX IF NOT EXISTS ai_brain_thoughts_timestamp_idx
      ON ai_brain_thoughts (timestamp DESC);
    CREATE INDEX IF NOT EXISTS ai_brain_thoughts_symbol_timestamp_idx
      ON ai_brain_thoughts (symbol, timestamp DESC);

    COMMENT ON TABLE ai_brain_thoughts IS
      'Autonomous agent thought stream. Written by whichever process ticks the agent; read by the '
      'dashboard. Previously in-memory, which broke when the tick moved to the scheduler.';
  `,
};
