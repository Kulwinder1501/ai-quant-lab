import { describe, expect, it } from "vitest";
import {
  assessImmediateAdverseExcursion,
  assessUnderlyingOptionPnlDivergence,
  assessExcessiveSpreadSlippage,
  calculatePlannedRiskRupees,
  calculateRealizedR,
  selectPrimaryObservedEvent,
  AEDLS_TAXONOMY_VERSION,
  AEDLS_REVIEWER_VERSION,
  AEDLS_EMBEDDING_TEMPLATE_VERSION,
  AEDLS_PINNED_MODEL_ID,
  AEDLS_PINNED_MODEL_REVISION,
  type AedlsTradeForensicReview,
  type EventTargetAssessment,
  type ObservedEventEvidence,
} from "../domain/aedls-forensic-review.js";

describe("AEDLS Phase 1 Forensic Integration Contract", () => {
  const t_entry = new Date("2026-10-14T09:30:00.000Z");
  const t_close = new Date("2026-10-14T09:45:00.000Z");
  const t_evidence = new Date("2026-10-14T09:45:30.000Z");
  const t_review = new Date("2026-10-14T09:46:00.000Z");
  const t_embedding = new Date("2026-10-14T09:46:15.000Z");

  it("satisfies strict 4-timestamp Point-in-Time ordering", () => {
    // Contract: t_close <= t_evidence <= t_review <= t_embedding < t_decision_future
    expect(t_close.getTime()).toBeLessThanOrEqual(t_evidence.getTime());
    expect(t_evidence.getTime()).toBeLessThanOrEqual(t_review.getTime());
    expect(t_review.getTime()).toBeLessThanOrEqual(t_embedding.getTime());

    // Replay invariant check
    const t_decision_replay = new Date("2026-10-14T09:47:00.000Z");
    const isPitEligible =
      t_close.getTime() < t_decision_replay.getTime() &&
      t_evidence.getTime() < t_decision_replay.getTime() &&
      t_review.getTime() < t_decision_replay.getTime() &&
      t_embedding.getTime() < t_decision_replay.getTime();

    expect(isPitEligible).toBe(true);

    // Decision at 09:44 (before trade close) cannot see this reflection
    const t_decision_past = new Date("2026-10-14T09:44:00.000Z");
    const isPitExcluded =
      t_close.getTime() < t_past_ts(t_decision_past) &&
      t_evidence.getTime() < t_past_ts(t_decision_past) &&
      t_review.getTime() < t_past_ts(t_decision_past) &&
      t_embedding.getTime() < t_past_ts(t_decision_past);

    function t_past_ts(d: Date) { return d.getTime(); }
    expect(isPitExcluded).toBe(false);
  });

  it("constructs an institutional-grade AedlsTradeForensicReview with complete provenance", () => {
    const plannedRisk = calculatePlannedRiskRupees({
      entryPrice: 120,
      stopLoss: 100,
      quantityUnits: 50,
      contractMultiplier: 1,
    });
    expect(plannedRisk).toBe(1000); // (120 - 100) * 50 = 1000 INR

    const realizedNetRupees = -1050; // Loss slightly beyond stop due to slippage
    const realizedNetR = calculateRealizedR(realizedNetRupees, plannedRisk);
    expect(realizedNetR).toBe(-1.05);

    // 3 completed 1-minute bars post-entry demonstrating immediate adverse excursion
    const candles = [
      { openTime: new Date("2026-10-14T09:31:00Z"), high: 121, low: 110, close: 112 }, // MAE 10 pts (0.5R), MFE 1 pt (0.05R)
      { openTime: new Date("2026-10-14T09:32:00Z"), high: 112, low: 98, close: 99 },    // MAE 22 pts (1.1R), MFE 0
      { openTime: new Date("2026-10-14T09:33:00Z"), high: 100, low: 97, close: 98 },
    ];

    const adverseAssessment = assessImmediateAdverseExcursion({
      side: "LONG",
      entryFillPrice: 120,
      riskPerUnit: 20,
      postEntry1mCandles: candles,
      entryTime: t_entry,
      tickSequenceVerified: true,
    });

    expect(adverseAssessment.label).toBe("POSITIVE");
    expect(adverseAssessment.evidenceStatus).toBe("TICK_VERIFIED");

    const targetAssessments: EventTargetAssessment[] = [adverseAssessment];
    const observedEvents: ObservedEventEvidence[] = [
      {
        event: "IMMEDIATE_ADVERSE_EXCURSION",
        evidenceStatus: adverseAssessment.evidenceStatus,
        eventWindowStart: adverseAssessment.windowStart,
        eventWindowEnd: adverseAssessment.windowEnd,
        evidenceReferences: adverseAssessment.evidenceReferences,
      },
    ];

    const review: AedlsTradeForensicReview = {
      tradeId: "pt-trade-12345",
      candidateId: "ti-idea-67890",
      observedEvents,
      targetAssessments,
      primaryObservedEvent: selectPrimaryObservedEvent(observedEvents),
      terminalOutcome: "STOP_LOSS",
      outcomeValidity: "VALID_RECONCILED",
      excursionValidity: "COMPLETE",
      plannedRiskRupees: plannedRisk,
      realizedGrossRupees: realizedNetRupees,
      realizedNetRupees,
      realizedGrossR: realizedNetR,
      realizedNetR,
      mae3BarsR: 1.1,
      mfe3BarsR: 0.05,
      maxAdverseExcursionR: 1.15,
      maxFavourableExcursionR: 0.05,
      underlyingExcursionPoints: -25.5,
      causalHypothesis: "OPPOSING_ORDER_FLOW",
      attributionStatus: "SUPPORTED",
      tradeClosedAt: t_close.toISOString(),
      evidenceAvailableAt: t_evidence.toISOString(),
      reviewAvailableAt: t_review.toISOString(),
      embeddingAvailableAt: t_embedding.toISOString(),
      reviewEmbeddingTemplateVersion: AEDLS_EMBEDDING_TEMPLATE_VERSION,
      embeddingModelId: AEDLS_PINNED_MODEL_ID,
      embeddingModelRevision: AEDLS_PINNED_MODEL_REVISION,
      embeddingConfigHash: "sha256-abc123mock",
      embeddingDim: 384,
      taxonomyVersion: AEDLS_TAXONOMY_VERSION,
      reviewerVersion: AEDLS_REVIEWER_VERSION,
      proposedResearchTags: ["IMMEDIATE_ADVERSE_EXCURSION", "OPPOSING_ORDER_FLOW"],
    };

    expect(review.primaryObservedEvent).toBe("IMMEDIATE_ADVERSE_EXCURSION");
    expect(review.outcomeValidity).toBe("VALID_RECONCILED");
    expect(review.excursionValidity).toBe("COMPLETE");
    expect(review.embeddingDim).toBe(384);
    expect(review.taxonomyVersion).toBe("taxonomy-v2.7");
  });

  it("prohibits training Experiment B on UNOBSERVABLE or ambiguous records", () => {
    // Intrabar threshold collision without tick tape
    const ambiguousCandles = [
      { openTime: new Date("2026-10-14T09:31:00Z"), high: 130, low: 95, close: 100 }, // Touches +0.5R and -1.25R
      { openTime: new Date("2026-10-14T09:32:00Z"), high: 105, low: 94, close: 96 },
      { openTime: new Date("2026-10-14T09:33:00Z"), high: 98, low: 92, close: 93 },
    ];

    const assessment = assessImmediateAdverseExcursion({
      side: "LONG",
      entryFillPrice: 120,
      riskPerUnit: 20,
      postEntry1mCandles: ambiguousCandles,
      entryTime: t_entry,
      tickSequenceVerified: false,
    });

    expect(assessment.label).toBe("UNOBSERVABLE");
    expect(assessment.evidenceStatus).toBe("INTRABAR_AMBIGUOUS");

    // Guard rule: filter for training set
    const isEligibleForExperimentB =
      assessment.label === "POSITIVE" || assessment.label === "NEGATIVE";

    expect(isEligibleForExperimentB).toBe(false);
  });
});
