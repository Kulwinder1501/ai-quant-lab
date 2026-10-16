import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/ai_quant_lab";
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const sampleOrg = await pool.query(`
    SELECT 
      id, 
      instrument_symbol, 
      trade_side, 
      pnl, 
      outcome, 
      analysis, 
      improvement_rule, 
      target_assessments, 
      primary_observed_event,
      trade_closed_at,
      evidence_available_at,
      review_available_at
    FROM ai_journal_reflections
    WHERE id NOT LIKE 'bench-ref-%'
    LIMIT 1;
  `);
  console.log("=== Sample Organic Reflection ===");
  console.log(JSON.stringify(sampleOrg.rows[0], null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
