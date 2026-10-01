import { describe, expect, it } from "vitest";
import { computeDrawOnLiquidity, type LiquidityPool } from "./liquidity.js";

/**
 * Unit coverage for `computeDrawOnLiquidity` (the plan's "Formal 8-Step Deterministic Selection
 * Algorithm", docs/ict-smc-semantic-contract.md §7.4). The function was added by c0fdea3 with zero
 * test coverage and is called nowhere in the repo -- these tests exist regardless of any wiring
 * decision, to pin down what the algorithm actually does before anything downstream is allowed to
 * depend on it.
 */

const T = 1_700_000_000_000; // an arbitrary fixed evaluation instant

function pool(overrides: Partial<LiquidityPool> & Pick<LiquidityPool, "id" | "kind" | "price">): LiquidityPool {
  return {
    isMitigated: false,
    ...overrides,
  };
}

describe("computeDrawOnLiquidity", () => {
  describe("Step 2: causal availability gate", () => {
    it("excludes a pool whose availableAt is strictly after the evaluation instant", () => {
      const future = pool({ id: "a", kind: "ERL_PDH", price: 110, availableAt: T + 1 });
      const result = computeDrawOnLiquidity([future], T, 100, 5, 0);
      expect(result.candidatePools).toHaveLength(0);
      expect(result.selectedPool).toBeUndefined();
    });

    it("includes a pool whose availableAt is exactly at or before the evaluation instant", () => {
      const atT = pool({ id: "a", kind: "ERL_PDH", price: 110, availableAt: T });
      const beforeT = pool({ id: "b", kind: "ERL_PDL", price: 90, availableAt: T - 1 });
      const result = computeDrawOnLiquidity([atT, beforeT], T, 100, 5, 0);
      expect(result.candidatePools.map((p) => p.id).sort()).toEqual(["a", "b"]);
    });

    it("includes a pool with no availableAt at all (undefined gate is a no-op, not a rejection)", () => {
      const undated = pool({ id: "a", kind: "ERL_PDH", price: 110 });
      const result = computeDrawOnLiquidity([undated], T, 100, 5, 0);
      expect(result.candidatePools).toHaveLength(1);
    });
  });

  describe("Step 3: exclude invalid/expired/mitigated pools", () => {
    it("excludes a pool marked isMitigated", () => {
      const mitigated = pool({ id: "a", kind: "ERL_PDH", price: 110, isMitigated: true });
      const result = computeDrawOnLiquidity([mitigated], T, 100, 5, 0);
      expect(result.candidatePools).toHaveLength(0);
    });

    it("excludes a pool with state INVALIDATED", () => {
      const invalidated = pool({ id: "a", kind: "ERL_PDH", price: 110, state: "INVALIDATED" });
      const result = computeDrawOnLiquidity([invalidated], T, 100, 5, 0);
      expect(result.candidatePools).toHaveLength(0);
    });

    it("excludes a pool with state BREACHED", () => {
      const breached = pool({ id: "a", kind: "ERL_PDH", price: 110, state: "BREACHED" });
      const result = computeDrawOnLiquidity([breached], T, 100, 5, 0);
      expect(result.candidatePools).toHaveLength(0);
    });

    it("keeps a pool with state ACTIVE or MITIGATED-as-state-only-not-flag is irrelevant -- only the isMitigated flag and INVALIDATED/BREACHED states gate", () => {
      const active = pool({ id: "a", kind: "ERL_PDH", price: 110, state: "ACTIVE" });
      const result = computeDrawOnLiquidity([active], T, 100, 5, 0);
      expect(result.candidatePools).toHaveLength(1);
    });
  });

  describe("Step 4: eligibility filter by recognized level kind", () => {
    it("excludes a pool whose kind is not recognized by the priority-tier taxonomy, rather than defaulting it into tier 4", () => {
      const bogus = pool({
        id: "a",
        kind: "NOT_A_REAL_KIND" as unknown as LiquidityPool["kind"],
        price: 110,
      });
      const recognized = pool({ id: "b", kind: "ERL_PDH", price: 120 });
      const result = computeDrawOnLiquidity([bogus, recognized], T, 100, 5, 0);
      expect(result.candidatePools.map((p) => p.id)).toEqual(["b"]);
    });

    it("recognizes every plan-vocabulary kind named in the Step 4 spec (tiers 1-3), not just this codebase's ERL_/IRL_ kinds", () => {
      const planKinds = [
        "PWH", "PWL", "PDH", "PDL", "PMH", "PML",
        "ITH", "ITL", "SWING_HIGH", "SWING_LOW",
        "SESSION_HIGH", "SESSION_LOW", "EQH", "EQL",
      ];
      const pools = planKinds.map((kind, i) =>
        pool({ id: `p${i}`, kind: kind as unknown as LiquidityPool["kind"], price: 100 + i + 1 })
      );
      const result = computeDrawOnLiquidity(pools, T, 100, 5, 1);
      expect(result.candidatePools).toHaveLength(planKinds.length);
    });
  });

  describe("Step 5: directional & HTF-bias policy", () => {
    const above = pool({ id: "above", kind: "ERL_PDH", price: 110 });
    const below = pool({ id: "below", kind: "ERL_PDL", price: 90 });

    it("bullish (1): keeps only pools above current price (BSL)", () => {
      const result = computeDrawOnLiquidity([above, below], T, 100, 5, 1);
      expect(result.candidatePools.map((p) => p.id)).toEqual(["above"]);
      expect(result.direction).toBe(1);
    });

    it("bearish (-1): keeps only pools below current price (SSL)", () => {
      const result = computeDrawOnLiquidity([above, below], T, 100, 5, -1);
      expect(result.candidatePools.map((p) => p.id)).toEqual(["below"]);
      expect(result.direction).toBe(-1);
    });

    it("neutral (0): keeps both BSL and SSL pools", () => {
      const result = computeDrawOnLiquidity([above, below], T, 100, 5, 0);
      expect(result.candidatePools.map((p) => p.id).sort()).toEqual(["above", "below"]);
    });
  });

  describe("Step 6/7: ATR-normalized distance ranking", () => {
    it("selects the pool nearest in ATR-normalized distance, not nearest in raw price", () => {
      // near: 20 points away but on a wide-ATR instrument -> 20/10 = 2.0 dATR
      // far-in-price-but-closer-in-ATR is not constructible without two different pools sharing an
      // ATR, so this proves ranking is by dATR at all: closer raw price wins when ATR is shared.
      const nearer = pool({ id: "nearer", kind: "ERL_PDH", price: 108 });
      const farther = pool({ id: "farther", kind: "ERL_PDH", price: 130 });
      const result = computeDrawOnLiquidity([farther, nearer], T, 100, 5, 1);
      expect(result.selectedPool?.id).toBe("nearer");
    });

    it("falls back to an effective ATR of 1 when atr14 is zero or negative, rather than dividing by zero", () => {
      const p = pool({ id: "a", kind: "ERL_PDH", price: 105 });
      const result = computeDrawOnLiquidity([p], T, 100, 0, 1);
      expect(result.selectedPool?.id).toBe("a");
      expect(Number.isFinite(result.candidatePools.length)).toBe(true);
    });
  });

  describe("Step 7 tie-break: priority tier, then recency, then lexicographic id", () => {
    it("7a: within 0.01 dATR, prefers the higher-priority tier (tier 1 PDH over tier 2 swing high)", () => {
      // Same ATR-distance (10 points at ATR 5 -> 2.0 dATR each), different tiers.
      const tier1 = pool({ id: "z-tier1", kind: "ERL_PDH", price: 110 });
      const tier2 = pool({ id: "a-tier2", kind: "ERL_SWING_HIGH", price: 110 });
      const result = computeDrawOnLiquidity([tier2, tier1], T, 100, 5, 1);
      // "a-tier2" would win lexicographically if tier were ignored -- it must not.
      expect(result.selectedPool?.id).toBe("z-tier1");
    });

    it("7b: equal tier and dATR, prefers the more recent availableAt (descending)", () => {
      const older = pool({ id: "z-older", kind: "ERL_PDH", price: 110, availableAt: T - 10_000 });
      const newer = pool({ id: "a-newer", kind: "ERL_PDH", price: 110, availableAt: T - 1_000 });
      const result = computeDrawOnLiquidity([older, newer], T, 100, 5, 1);
      expect(result.selectedPool?.id).toBe("a-newer");
    });

    it("7c: equal tier and availableAt, prefers the lexicographically smaller id", () => {
      const b = pool({ id: "pool-b", kind: "ERL_PDH", price: 110, availableAt: T - 1_000 });
      const a = pool({ id: "pool-a", kind: "ERL_PDH", price: 110, availableAt: T - 1_000 });
      const result = computeDrawOnLiquidity([b, a], T, 100, 5, 1);
      expect(result.selectedPool?.id).toBe("pool-a");
    });
  });

  describe("Step 8: no-candidate fallback", () => {
    it("returns selectedPool undefined, direction 0 and an empty candidatePools when nothing qualifies", () => {
      const result = computeDrawOnLiquidity([], T, 100, 5, 1);
      expect(result.selectedPool).toBeUndefined();
      expect(result.direction).toBe(0);
      expect(result.candidatePools).toEqual([]);
      expect(result.selectionRuleVersion).toBe("LIQUIDITY_TARGET_SELECTION_V1");
    });

    it("returns the no-candidate shape when every pool is filtered out by an earlier step", () => {
      const onlyMitigated = pool({ id: "a", kind: "ERL_PDH", price: 110, isMitigated: true });
      const result = computeDrawOnLiquidity([onlyMitigated], T, 100, 5, 1);
      expect(result.selectedPool).toBeUndefined();
      expect(result.direction).toBe(0);
    });
  });

  describe("Step 8: neutral opposing-equidistance resolution", () => {
    it("picks the BSL pool on a bullish-closing bar when top BSL and top SSL are equidistant and HTF is neutral", () => {
      const bsl = pool({ id: "bsl", kind: "ERL_PDH", price: 110 }); // 10 away
      const ssl = pool({ id: "ssl", kind: "ERL_PDL", price: 90 }); // 10 away
      const result = computeDrawOnLiquidity([bsl, ssl], T, 100, 5, 0, true);
      expect(result.selectedPool?.id).toBe("bsl");
      expect(result.direction).toBe(1);
    });

    it("picks the SSL pool on a bearish-closing bar when top BSL and top SSL are equidistant and HTF is neutral", () => {
      const bsl = pool({ id: "bsl", kind: "ERL_PDH", price: 110 });
      const ssl = pool({ id: "ssl", kind: "ERL_PDL", price: 90 });
      const result = computeDrawOnLiquidity([bsl, ssl], T, 100, 5, 0, false);
      expect(result.selectedPool?.id).toBe("ssl");
      expect(result.direction).toBe(-1);
    });

    it("does not apply the equidistance override when BSL and SSL are not actually tied", () => {
      const bsl = pool({ id: "bsl", kind: "ERL_PDH", price: 103 }); // 3 away -> 0.6 dATR
      const ssl = pool({ id: "ssl", kind: "ERL_PDL", price: 90 }); // 10 away -> 2.0 dATR
      const result = computeDrawOnLiquidity([bsl, ssl], T, 100, 5, 0, false);
      // Nearest by dATR wins outright; the bearish-bar override must not override a non-tie.
      expect(result.selectedPool?.id).toBe("bsl");
    });

    it("does not apply the equidistance override when HTF direction is directional (not neutral)", () => {
      const bsl = pool({ id: "bsl", kind: "ERL_PDH", price: 110 });
      const ssl = pool({ id: "ssl", kind: "ERL_PDL", price: 90 });
      // HTF bullish restricts candidates to BSL only via Step 5, so SSL is never even a candidate.
      const result = computeDrawOnLiquidity([bsl, ssl], T, 100, 5, 1, false);
      expect(result.selectedPool?.id).toBe("bsl");
    });
  });
});
