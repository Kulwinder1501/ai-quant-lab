import { createDatabasePool } from "../../infrastructure/database/database.js";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab";

async function main() {
  const pool = createDatabasePool(DATABASE_URL);
  try {
    const res = await pool.query(`
      SELECT r.id, r.trade_id, r.target_assessments, r.primary_observed_event, r.terminal_outcome
      FROM ai_journal_reflections r
      JOIN candidate_decisions cd ON cd.paper_trade_id::text = r.trade_id
      LIMIT 5
    `);
    console.log("Joined sample:", JSON.stringify(res.rows, null, 2));

    const totalWithAssessments = await pool.query(`
      SELECT COUNT(*) as cnt, target_assessments
      FROM ai_journal_reflections
      GROUP BY target_assessments
      LIMIT 10
    `);
    console.log("Distinct target_assessments:", totalWithAssessments.rows);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
