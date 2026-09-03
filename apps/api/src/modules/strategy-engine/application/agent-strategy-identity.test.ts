import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_STRATEGY_KEY } from "./ai-autonomous-agent.js";
import { findRegisteredStrategy } from "../domain/strategy-registry.js";

/**
 * The agent must own its proposals, and must never be nominated as a strategy.
 *
 * It used to stamp every persisted proposal with `SELECT id FROM strategy_versions WHERE is_active =
 * TRUE LIMIT 1` -- unordered, unfiltered, seven rows matching. Measured 2026-09-03: all 8 ideas ever
 * attributed to `trend-breakout` were the agent's, 3 of them became real trades, and `trend-breakout`
 * had produced none of its own. Migration 096 gives the agent its own identity.
 */
describe("the autonomous agent's strategy identity", () => {
  const agentSource = readFileSync(
    resolve(process.cwd(), "src", "modules", "strategy-engine", "application", "ai-autonomous-agent.ts"),
    "utf8",
  );
  const migrationSource = readFileSync(
    resolve(
      process.cwd(), "src", "infrastructure", "database", "migrations",
      "096-autonomous-agent-strategy-identity.ts",
    ),
    "utf8",
  );

  it("is not a registered strategy, so no bot can be given it", () => {
    /*
     * The agent is in no roster and scores with the composite Section 6 quarantines. If it ever
     * became registered, `generate-trade-ideas` would evaluate it as a rule and a bot could be
     * handed it -- neither of which it is built to be.
     */
    expect(findRegisteredStrategy(AGENT_STRATEGY_KEY)).toBeNull();
  });

  it("uses the same key the migration inserts", () => {
    // Three copies of a string -- constant, migration, guard -- is how they stop agreeing.
    expect(migrationSource).toContain(`'${AGENT_STRATEGY_KEY}'`);
    expect(agentSource).toContain(`AGENT_STRATEGY_KEY = "${AGENT_STRATEGY_KEY}"`);
  });

  it("no longer asks the database to nominate a strategy", () => {
    /*
     * The regression tripwire. The old query reads as harmless -- "resolve active strategy version"
     * -- and is one line, so it is exactly the kind of thing that comes back. Comments are not
     * stripped here on purpose: the docblock explaining the defect quotes the query, so the
     * assertion is on the executed shape rather than the mere appearance of the words.
     */
    expect(agentSource).not.toMatch(/query<[^>]*>\(\s*"SELECT id FROM strategy_versions WHERE is_active = TRUE LIMIT 1"/);
    // And it must resolve by key instead.
    expect(agentSource).toMatch(/WHERE s\.strategy_key = \$1/);
  });

  it("records a thought when its identity is missing, rather than returning silently", () => {
    // A bare `return` here is the same failure that hid BANKNIFTY from the feed: "evaluated and did
    // nothing" is indistinguishable from "never ran".
    expect(agentSource).toContain("AGENT_STRATEGY_MISSING");
  });

  it("keeps the agent's version inactive, so it cannot become the backtest default", () => {
    /*
     * `backtesting.routes.ts` takes `ORDER BY created_at DESC LIMIT 1` over active versions, so a new
     * active row would be the newest and would silently redirect the backtest default to the agent's
     * configuration. Verified by dry-run: after 096 the newest active version is still
     * `momentum-scalp-pattern-v2`.
     */
    expect(migrationSource).toContain("version, configuration, is_active)");
    // The literal the INSERT supplies for that column, on its own line in the SELECT list.
    expect(migrationSource).toMatch(/^\s+FALSE$/m);
    expect(migrationSource).not.toMatch(/is_active\s*\)\s*[\s\S]{0,600}?TRUE/);
  });
});
