import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { PostgresScalpResearchAcceptanceRepository } from "./postgres-scalp-research-acceptance-repository.js";

const cleanRow = {
  duplicate_persisted_keys: "0",
  reference_candle_mismatches: "0",
  feature_timestamp_after_data_through: "0",
  opportunities_without_members: "0",
  orphan_risk_decisions: "0",
  risk_snapshots_after_decision: "0",
  orphan_observations: "0",
  orphan_terminal_settlements: "0",
  cross_session_observations: "0",
  expected_control_grid_rows: "748",
  missing_control_grid_rows: "0",
  matured_eligible_observations: "120",
  missing_matured_eligible_observations: "0",
  matured_canonical_observations: "20",
  missing_matured_canonical_observations: "0",
  matured_native_terminals: "12",
  missing_matured_native_terminals: "0",
  matured_canonical_terminals: "20",
  missing_matured_canonical_terminals: "0",
  matured_terminals: "32",
  missing_matured_terminals: "0",
  unresolved_control_matching: "0",
  ambiguous_terminals: "3",
  same_candle_ambiguity: "2",
  data_incomplete_terminals: "2",
  eligible_data_incomplete: "5",
  policy_invalid_terminals: "1",
  off_grid_control_points: "0",
  off_grid_opportunities: "0",
  policy_determinism_violations: "0",
  common_support_failures: "4",
  matured_opportunities: "40",
};

describe("PostgresScalpResearchAcceptanceRepository", () => {
  it("passes clean plumbing while retaining outcome diagnostics", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [cleanRow] });
    const report = await new PostgresScalpResearchAcceptanceRepository(
      { query } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(report.passed).toBe(true);
    expect(report.counts.ambiguous_terminals).toBe(3);
    expect(report.counts.common_support_failures).toBe(4);
    expect(query.mock.calls[0]?.[1]).toHaveLength(4);
    // Spec-named rates, reported rather than left for the reader to divide.
    expect(report.rates.controlCommonSupportFailureRate).toBeCloseTo(0.1, 10);
    expect(report.rates.terminalResolutionCoverage).toBe(1);
  });

  it("reports the exact spec quantities, not their looser approximations", async () => {
    // sameCandleAmbiguity is narrower than "all AMBIGUOUS", and eligibleDataIncomplete is
    // observation-level rather than terminal-level. An acceptance gate must report what it names.
    const query = vi.fn().mockResolvedValue({ rows: [cleanRow] });
    const report = await new PostgresScalpResearchAcceptanceRepository(
      { query } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(report.counts.same_candle_ambiguity).toBe(2);
    expect(report.counts.ambiguous_terminals).toBe(3);
    expect(report.counts.eligible_data_incomplete).toBe(5);
    expect(report.counts.data_incomplete_terminals).toBe(2);
  });

  it("fails when canonical terminals are missing, which native-only coverage used to hide", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...cleanRow, missing_matured_canonical_terminals: "3", missing_matured_terminals: "3" }],
    });
    const report = await new PostgresScalpResearchAcceptanceRepository(
      { query } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(report.passed).toBe(false);
    expect(report.assertions.canonicalTerminalResolution).toBe(false);
    // Native still reads clean; that is precisely why it must not be the only reported coverage.
    expect(report.assertions.nativeTerminalResolution).toBe(true);
    expect(report.rates.canonicalTerminalResolutionCoverage).toBeCloseTo(0.85, 10);
  });

  it("fails on an off-grid decision and on a settlement policy determinism violation", async () => {
    const offGrid = vi.fn().mockResolvedValue({ rows: [{ ...cleanRow, off_grid_control_points: "1" }] });
    const offGridReport = await new PostgresScalpResearchAcceptanceRepository(
      { query: offGrid } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(offGridReport.assertions.onGridDecisions).toBe(false);

    const drifted = vi.fn().mockResolvedValue({ rows: [{ ...cleanRow, policy_determinism_violations: "1" }] });
    const driftedReport = await new PostgresScalpResearchAcceptanceRepository(
      { query: drifted } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(driftedReport.assertions.settlementPolicyDeterminism).toBe(false);
  });

  it("leaves a rate null rather than reporting a reassuring zero on an empty window", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...cleanRow, matured_opportunities: "0", common_support_failures: "0" }],
    });
    const report = await new PostgresScalpResearchAcceptanceRepository(
      { query } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(report.rates.controlCommonSupportFailureRate).toBeNull();
  });

  it("fails when a matured native proposal has no terminal resolution", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...cleanRow, missing_matured_native_terminals: "1" }],
    });
    const report = await new PostgresScalpResearchAcceptanceRepository(
      { query } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(report.passed).toBe(false);
    expect(report.assertions.nativeTerminalResolution).toBe(false);
  });

  it("cannot pass vacuously when completed source minutes were not captured", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...cleanRow, missing_control_grid_rows: "2" }],
    });
    const report = await new PostgresScalpResearchAcceptanceRepository(
      { query } as unknown as DatabaseQueryable,
    ).generate({ from: new Date("2026-08-17T03:45:00Z"), through: new Date("2026-08-21T10:01:00Z") });
    expect(report.passed).toBe(false);
    expect(report.assertions.controlGridCoverage).toBe(false);
  });
});
