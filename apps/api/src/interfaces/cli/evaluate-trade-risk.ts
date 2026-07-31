import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresRiskStateRepository } from "../../infrastructure/database/repositories/postgres-risk-state-repository.js";
import { defaultRiskPolicy, evaluateRisk } from "../../modules/risk-management/domain/risk.js";
import { getOption, requireOption } from "./arguments.js";
import { parsePositiveNumber } from "./paper-trading-arguments.js";

/**
 * Evaluates every PROPOSED trade idea against the risk engine and prints the decision.
 *
 * Read-only: nothing is executed or persisted. The point is that a risk decision is
 * inspectable before the engine is wired into execution, so the sizing and the reason
 * codes can be checked against real account state and real volatility predictions.
 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const client = await database.connect();
  try {
    const accountName = requireOption(argumentsList, "account");
    const asOfRaw = getOption(argumentsList, "as-of");
    const asOf = asOfRaw ? new Date(asOfRaw) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      throw new Error(`Invalid --as-of "${asOfRaw}".`);
    }
    const policy = {
      ...defaultRiskPolicy,
      riskFractionPerTrade: getOption(argumentsList, "risk-fraction")
        ? parsePositiveNumber(getOption(argumentsList, "risk-fraction")!, "risk-fraction")
        : defaultRiskPolicy.riskFractionPerTrade,
      // Overridable so an approval path can be exercised against real state even when
      // the account already holds its limit of positions.
      maxConcurrentPositions: getOption(argumentsList, "max-positions")
        ? parsePositiveNumber(getOption(argumentsList, "max-positions")!, "max-positions")
        : defaultRiskPolicy.maxConcurrentPositions,
    };

    const account = await client.query<{ id: string; opening_balance: string }>(
      "SELECT id, opening_balance FROM paper_accounts WHERE name = $1 OR id::text = $1 LIMIT 1",
      [accountName],
    );
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error(`Paper account "${accountName}" was not found.`);

    const ideas = await client.query<{
      id: string; instrument_id: string; symbol: string; side: "LONG" | "SHORT";
      entry_price: string; stop_loss: string; target_price: string;
    }>(`
      SELECT trade_ideas.id, trade_ideas.instrument_id, instruments.symbol, trade_ideas.side,
             trade_ideas.entry_price, trade_ideas.stop_loss, trade_ideas.target_price
      FROM trade_ideas
      JOIN instruments ON instruments.id = trade_ideas.instrument_id
      WHERE trade_ideas.status = 'PROPOSED'
      ORDER BY trade_ideas.generated_at DESC
      LIMIT 20
    `);

    const repository = new PostgresRiskStateRepository(client);
    console.log(`account ${accountName} as of ${asOf.toISOString()}, risk fraction ${policy.riskFractionPerTrade}`);
    if (ideas.rows.length === 0) {
      console.log("no PROPOSED trade ideas to evaluate");
      return;
    }

    for (const idea of ideas.rows) {
      const state = await repository.findRiskState({ accountId, instrumentId: idea.instrument_id, asOf });
      const decision = evaluateRisk({
        instrumentId: idea.instrument_id,
        decisionTimestamp: asOf,
        side: idea.side,
        entryPrice: Number(idea.entry_price),
        stopLoss: Number(idea.stop_loss),
        targetPrice: Number(idea.target_price),
      }, state, policy);

      const regime = state.volatilityRegime;
      console.log(
        `${idea.id.substring(0, 8)}  ${idea.symbol.padEnd(10)} ${idea.side.padEnd(5)} `
        + `${decision.approved ? "APPROVED" : "REJECTED"} qty=${String(decision.approvedQuantity).padStart(5)} `
        + `risk=${String(decision.estimatedRiskAmount).padStart(10)} `
        + `regime=${regime ? `${regime.prediction}@${regime.confidence}` : "none"}  [${decision.reasonCodes.join(", ")}]`,
      );
    }

    const state = await repository.findRiskState({
      accountId, instrumentId: ideas.rows[0].instrument_id, asOf,
    });
    console.log(`\nequity ${state.accountEquity} | peak ${state.peakEquity} | today ${state.realizedPnlToday} `
      + `| open ${state.openPositionCount}`);
  } finally {
    client.release();
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
