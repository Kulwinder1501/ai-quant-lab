import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";

async function main() {
  const env = loadEnvironment();
  const db = createDatabasePool(env.DATABASE_URL);

  console.log("================================================================================");
  console.log("=== STAGE A INTERIM TELEMETRY & EVIDENCE-AVAILABILITY AUDIT                   ===");
  console.log("================================================================================\n");

  try {
    // 1. Corpus volume & reflection count
    const corpusRes = await db.query(`
      SELECT 
        COUNT(*) as total_reflections,
        COUNT(embedding) as with_embedding,
        COUNT(CASE WHEN embedding_dim = 384 THEN 1 END) as valid_dim_384,
        COUNT(CASE WHEN outcome_validity = 'VALID_RECONCILED' THEN 1 END) as valid_reconciled,
        COUNT(CASE WHEN excursion_validity = 'COMPLETE' THEN 1 END) as excursion_complete
      FROM ai_journal_reflections
    `);
    console.log("1. REFLECTION CORPUS VOLUME & INTEGRITY:");
    console.table(corpusRes.rows);

    // 2. Target Assessment counts (IMMEDIATE_ADVERSE_EXCURSION: POSITIVE, NEGATIVE, UNOBSERVABLE)
    const targetRes = await db.query(`
      SELECT 
        primary_observed_event,
        COUNT(*) as count
      FROM ai_journal_reflections
      GROUP BY primary_observed_event
      ORDER BY count DESC
    `);
    console.log("\n2. OBSERVED PATH EVENTS (PRIMARY):");
    console.table(targetRes.rows);

    // Check JSON target_assessments specifically for IMMEDIATE_ADVERSE_EXCURSION
    const targetJsonRes = await db.query(`
      SELECT 
        elem->>'targetEvent' as target_event,
        elem->>'label' as label,
        elem->>'evidenceStatus' as evidence_status,
        COUNT(*) as count
      FROM ai_journal_reflections,
      jsonb_array_elements(target_assessments) as elem
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, count DESC
    `);
    console.log("\n3. TARGET ASSESSMENTS BREAKDOWN:");
    console.table(targetJsonRes.rows);

    // Check candidate_decisions count
    const candidateRes = await db.query(`
      SELECT 
        decision,
        COUNT(*) as count
      FROM candidate_decisions
      GROUP BY decision
    `);
    console.log("\n3b. CANDIDATE DECISIONS:");
    console.table(candidateRes.rows);

    // 3. Instrument Representation - Reconciled by Eligible Corpus vs Legacy
    const instEligibleRes = await db.query(`
      SELECT 
        CASE WHEN embedding IS NOT NULL THEN 'ELIGIBLE_EMBEDDED' ELSE 'LEGACY_UNEMBEDDED' END as corpus_status,
        instrument_symbol,
        trade_side,
        COUNT(*) as count,
        COUNT(DISTINCT candidate_id) as unique_candidates,
        COUNT(DISTINCT trade_id) as unique_trades,
        COUNT(CASE WHEN primary_observed_event = 'IMMEDIATE_ADVERSE_EXCURSION' THEN 1 END) as pos_excursions
      FROM ai_journal_reflections
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `);
    console.log("\n4. INSTRUMENT RECONCILIATION (ELIGIBLE VS LEGACY):");
    console.table(instEligibleRes.rows);

    // 4. Point-In-Time Integrity
    // Required: trade_closed_at <= evidence_available_at <= review_available_at <= embedding_available_at
    const pitRes = await db.query(`
      SELECT 
        COUNT(*) as total_with_timestamps,
        COUNT(CASE WHEN evidence_available_at < trade_closed_at THEN 1 END) as evidence_before_close_violation,
        COUNT(CASE WHEN review_available_at < evidence_available_at THEN 1 END) as review_before_evidence_violation,
        COUNT(CASE WHEN embedding_available_at < review_available_at THEN 1 END) as embed_before_review_violation,
        COUNT(CASE WHEN trade_closed_at IS NULL THEN 1 END) as null_trade_closed,
        COUNT(CASE WHEN review_available_at IS NULL THEN 1 END) as null_review_available
      FROM ai_journal_reflections
      WHERE trade_closed_at IS NOT NULL
    `);
    console.log("\n5. POINT-IN-TIME (PIT) ORDERING INTEGRITY:");
    console.table(pitRes.rows);

    // 5. Operational Safety Invariant Check
    // Check aedls_shadow_recommendations table
    const safeRes = await db.query(`
      SELECT 
        COUNT(*) as total_recommendations,
        COUNT(CASE WHEN applied_confidence_delta != 0 THEN 1 END) as live_veto_violations,
        MIN(applied_confidence_delta) as min_applied_delta,
        MAX(applied_confidence_delta) as max_applied_delta,
        COUNT(CASE WHEN hypothetical_admission_decision = 'REJECT' THEN 1 END) as shadow_rejects,
        COUNT(CASE WHEN hypothetical_admission_decision = 'ADMIT' THEN 1 END) as shadow_admits
      FROM aedls_shadow_recommendations
    `);
    console.log("\n6. OPERATIONAL SAFETY & LIVE VETO INVARIANT:");
    console.table(safeRes.rows);

    // 6. Retrieval Fallback History across Last Sessions
    // Let's check status breakdown in aedls_shadow_recommendations per session date
    const fallbackRes = await db.query(`
      SELECT 
        DATE(decided_at AT TIME ZONE 'Asia/Kolkata') as session_date,
        COUNT(*) as total_queries,
        COUNT(CASE WHEN status LIKE '%FALLBACK%' OR status = 'FALLBACK_PRIOR' THEN 1 END) as fallback_count,
        ROUND((COUNT(CASE WHEN status LIKE '%FALLBACK%' OR status = 'FALLBACK_PRIOR' THEN 1 END)::numeric / NULLIF(COUNT(*), 0)) * 100, 2) as fallback_pct
      FROM aedls_shadow_recommendations
      GROUP BY 1
      ORDER BY session_date DESC
      LIMIT 10
    `);
    console.log("\n7. RETRIEVAL FALLBACK HISTORY (BY SESSION):");
    console.table(fallbackRes.rows);

  } finally {
    await db.end();
  }
}

main().catch(console.error);
