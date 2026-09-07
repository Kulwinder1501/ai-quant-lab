import { describe, expect, it, vi } from "vitest";
import {
  RunVolatilityCompetition,
  type VolatilityCandidate,
  type VolatilityCompetitionRepository,
} from "./run-volatility-competition.js";
import type { VolatilityConfusionCell } from "../domain/volatility-competition.js";

const TODAY = "2026-08-03";

function cells(diagonal: number, offDiagonal: number): VolatilityConfusionCell[] {
  return [
    { prediction: "CONTRACTION", realizedLabel: "CONTRACTION", count: diagonal },
    { prediction: "STABLE", realizedLabel: "STABLE", count: diagonal },
    { prediction: "EXPANSION", realizedLabel: "EXPANSION", count: diagonal },
    { prediction: "CONTRACTION", realizedLabel: "STABLE", count: Math.ceil(offDiagonal / 2) },
    { prediction: "EXPANSION", realizedLabel: "CONTRACTION", count: Math.floor(offDiagonal / 2) },
  ];
}

function candidate(overrides: Partial<VolatilityCandidate> = {}): VolatilityCandidate {
  return {
    modelVersionId: "model-1",
    modelKey: "volatility-expansion-lightgbm--pool20-f887399b--1d--h5",
    role: null,
    cells: cells(150, 30),
    scoredDays: 20,
    lastScoredDate: TODAY,
    ...overrides,
  };
}

function build(candidates: VolatilityCandidate[]) {
  const applyRoles = vi.fn(
    async (_input: Parameters<VolatilityCompetitionRepository["applyRoles"]>[0]) => undefined,
  );
  const repository: VolatilityCompetitionRepository = {
    listCandidates: async () => candidates,
    applyRoles,
  };
  return {
    service: new RunVolatilityCompetition(repository, undefined, () => TODAY),
    applyRoles,
  };
}

describe("RunVolatilityCompetition", () => {
  it("assigns a first PRIMARY and records that it newly became one", async () => {
    const { service, applyRoles } = build([candidate()]);

    const result = await service.execute();

    expect(result.decision).toBe("INITIAL_PRIMARY_ESTABLISHED");
    expect(result.primaryModelKey).toContain("pool20");
    expect(applyRoles).toHaveBeenCalledOnce();
    expect(applyRoles.mock.calls[0]![0].assignments).toEqual([
      { modelVersionId: "model-1", role: "PRIMARY", becamePrimary: true, reason: "INITIAL_PRIMARY_ESTABLISHED" },
    ]);
  });

  it("does not re-flag an existing PRIMARY as newly promoted", async () => {
    const { service, applyRoles } = build([candidate({ role: "PRIMARY" })]);

    await service.execute();

    expect(applyRoles.mock.calls[0]![0].assignments[0]!.becamePrimary).toBe(false);
  });

  // A quarantine must actually clear the row. Skipping the write because there is
  // nothing to assign would leave a demoted model holding its authority.
  it("still writes when a quarantine leaves no PRIMARY", async () => {
    const { service, applyRoles } = build([
      candidate({ role: "PRIMARY", lastScoredDate: "2026-06-01" }),
    ]);

    const result = await service.execute();

    expect(result.decision).toBe("PRIMARY_QUARANTINED_SILENT");
    expect(result.primaryModelKey).toBeNull();
    expect(applyRoles).toHaveBeenCalledOnce();
    expect(applyRoles.mock.calls[0]![0].assignments.some((a) => a.role === "PRIMARY")).toBe(false);
  });

  it("reports why models were excluded rather than silently dropping them", async () => {
    const { service } = build([
      candidate({ modelVersionId: "thin", cells: cells(10, 2) }),
      candidate({
        modelVersionId: "spreader",
        // Realized outcomes are dominated by EXPANSION, so trivial accuracy is high and
        // this model's spread-out predictions land below it.
        cells: [
          { prediction: "EXPANSION", realizedLabel: "EXPANSION", count: 200 },
          { prediction: "CONTRACTION", realizedLabel: "EXPANSION", count: 250 },
          { prediction: "STABLE", realizedLabel: "EXPANSION", count: 250 },
          { prediction: "CONTRACTION", realizedLabel: "CONTRACTION", count: 60 },
        ],
      }),
    ]);

    const result = await service.execute();

    expect(result.candidatesExamined).toBe(2);
    expect(result.excludedForSample).toBe(1);
    expect(result.excludedBelowTrivial).toBe(1);
    expect(result.qualifying).toBe(0);
    expect(result.decision).toBe("NO_QUALIFYING_MODEL");
  });

  it("records a challenger distinct from the primary", async () => {
    const { service, applyRoles } = build([
      candidate({ modelVersionId: "champion", role: "PRIMARY", cells: cells(400, 60) }),
      candidate({ modelVersionId: "runner-up", modelKey: "runner-up-key", cells: cells(300, 90) }),
    ]);

    const result = await service.execute();

    expect(result.primaryModelKey).toContain("pool20");
    expect(result.challengerModelKey).toBe("runner-up-key");
    const roles = applyRoles.mock.calls[0]![0].assignments.map((a) => [a.modelVersionId, a.role]);
    expect(roles).toEqual([["champion", "PRIMARY"], ["runner-up", "CHALLENGER"]]);
  });

  it("passes the volatility scheme so the write cannot touch directional state", async () => {
    const { service, applyRoles } = build([candidate()]);

    await service.execute();

    expect(applyRoles.mock.calls[0]![0].labelScheme).toBe("volatility-expansion-v1");
  });
});
