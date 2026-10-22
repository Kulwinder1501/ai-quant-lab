import { describe, expect, it } from "vitest";
import {
  candlestickAlgorithmVersion,
  priceActionAlgorithmVersion,
} from "../../pattern-recognition/domain/market-pattern.js";
import {
  defaultMomentumScalpPatternStrategyConfiguration,
  momentumScalpPatternStrategyRegistration,
  momentumScalpPatternStrategyV2Registration,
} from "./momentum-scalp-pattern-strategy.js";

/*
 * This strategy filters stored events by exact algorithm version. A pin that falls behind the
 * detector therefore reads nothing and fails silently: `priceActionAlgorithmVersion` named
 * "price-action-v2" for twelve days after the detector moved to v3 (2026-10-10), and no AutoBot-Sniper
 * idea carried a support/resistance or chart-pattern event in that time. These tests turn that into a
 * red build the next time the detector's version constants move.
 */
describe("momentum-scalp-pattern reads the versions the detector currently writes", () => {
  it("defaults its candlestick and price-action pins to the detector's current versions", () => {
    expect(defaultMomentumScalpPatternStrategyConfiguration.candlestickAlgorithmVersion).toBe(candlestickAlgorithmVersion);
    expect(defaultMomentumScalpPatternStrategyConfiguration.priceActionAlgorithmVersion).toBe(priceActionAlgorithmVersion);
  });

  it.each([
    ["momentum-scalp-pattern", momentumScalpPatternStrategyRegistration],
    ["momentum-scalp-pattern-v2", momentumScalpPatternStrategyV2Registration],
  ])("registers %s with the detector's current versions", (_key, registration) => {
    expect(registration.configuration.candlestickAlgorithmVersion).toBe(candlestickAlgorithmVersion);
    expect(registration.configuration.priceActionAlgorithmVersion).toBe(priceActionAlgorithmVersion);
  });
});
