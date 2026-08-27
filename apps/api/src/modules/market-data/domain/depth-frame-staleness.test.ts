import { describe, expect, it } from "vitest";
import {
  DEPTH_STRUCTURAL_SILENCE_MS,
  describeContractRoll,
  evaluateDepthCaptureStaleness,
  frontMonthFuturesSymbol,
  parseFuturesSymbol,
  type DepthSymbolObservation,
} from "./depth-frame-staleness.js";

/** 09:15 and 15:40 IST on 2026-08-27, as UTC. */
const session = {
  opensAt: new Date("2026-08-27T03:45:00.000Z"),
  closesAt: new Date("2026-08-27T10:10:00.000Z"),
};
/** Mid-session, comfortably past the warm-up. */
const midSession = new Date("2026-08-27T06:00:00.000Z");

function streaming(lastFrameAt: Date, providerSymbol = "NSE:BANKNIFTY26SEPFUT"): DepthSymbolObservation {
  return { providerSymbol, frames: 240, lastFrameAt };
}

describe("evaluateDepthCaptureStaleness", () => {
  it("reports HEALTHY while frames are arriving mid-session", () => {
    const status = evaluateDepthCaptureStaleness({
      now: midSession,
      session,
      observations: [streaming(new Date(midSession.getTime() - 2_000))],
    });

    expect(status.status).toBe("HEALTHY");
    expect(status.findings).toEqual(["DEPTH_CAPTURE_STREAMING"]);
    expect(status.silentForMs).toBe(2_000);
  });

  /**
   * The 2026-08-26 incident, reduced: the August contract had expired, so the subscription resolved
   * to nothing and the table stopped growing while the socket stayed open. Nothing observed at all
   * during a live session is the shape that went unnoticed for two sessions.
   */
  it("reports SILENT when no symbol produced a frame during market hours", () => {
    const status = evaluateDepthCaptureStaleness({
      now: midSession,
      session,
      observations: [],
    });

    expect(status.status).toBe("SILENT");
    expect(status.findings).toEqual(["NO_DEPTH_FRAMES_DURING_MARKET_HOURS"]);
    expect(status.silentForMs).toBeNull();
  });

  it("reports STALE when frames stopped more than one silence window ago", () => {
    const status = evaluateDepthCaptureStaleness({
      now: midSession,
      session,
      observations: [streaming(new Date(midSession.getTime() - DEPTH_STRUCTURAL_SILENCE_MS - 1_000))],
    });

    expect(status.status).toBe("STALE");
    expect(status.findings).toContain("DEPTH_CAPTURE_SILENT");
  });

  /**
   * NOT_DUE is not HEALTHY. A collector that is correctly idle outside market hours must not be
   * reported as working, or a check that never ran would look like a passing one.
   */
  it("returns NOT_DUE rather than HEALTHY outside a session", () => {
    for (const [label, input] of [
      ["weekend or holiday", { now: midSession, session: null }],
      ["before the warm-up elapses", { now: new Date(session.opensAt.getTime() + 60_000), session }],
      ["at or after the close", { now: session.closesAt, session }],
    ] as const) {
      const status = evaluateDepthCaptureStaleness({ ...input, observations: [] });
      expect(status.status, label).toBe("NOT_DUE");
    }
  });

  it("does not alarm inside the opening warm-up, and does immediately after it", () => {
    const justInside = new Date(session.opensAt.getTime() + 299_000);
    const justOutside = new Date(session.opensAt.getTime() + 300_000);

    expect(evaluateDepthCaptureStaleness({ now: justInside, session, observations: [] }).status)
      .toBe("NOT_DUE");
    expect(evaluateDepthCaptureStaleness({ now: justOutside, session, observations: [] }).status)
      .toBe("SILENT");
  });

  /**
   * The roll signature: other symbols stream fine, the named one produced nothing at all. That is a
   * dead subscription rather than a stalled one, so it reads as SILENT, not STALE.
   */
  it("flags an expected symbol that is absent while another streams", () => {
    const status = evaluateDepthCaptureStaleness({
      now: midSession,
      session,
      observations: [streaming(new Date(midSession.getTime() - 1_000), "NSE:NIFTY26SEPFUT")],
      expectedSymbols: ["NSE:BANKNIFTY26AUGFUT"],
    });

    expect(status.status).toBe("SILENT");
    expect(status.missingSymbols).toEqual(["NSE:BANKNIFTY26AUGFUT"]);
    expect(status.findings).toContain("EXPECTED_SYMBOL_ABSENT:NSE:BANKNIFTY26AUGFUT");
  });

  it("matches expected symbols case-insensitively", () => {
    const status = evaluateDepthCaptureStaleness({
      now: midSession,
      session,
      observations: [streaming(new Date(midSession.getTime() - 1_000))],
      expectedSymbols: ["nse:banknifty26sepfut"],
    });

    expect(status.status).toBe("HEALTHY");
    expect(status.missingSymbols).toEqual([]);
  });
});

describe("parseFuturesSymbol", () => {
  it("decomposes a Fyers futures ticker", () => {
    expect(parseFuturesSymbol("NSE:BANKNIFTY26AUGFUT"))
      .toEqual({ exchange: "NSE", underlying: "BANKNIFTY", year: 26, month: 8 });
    expect(parseFuturesSymbol("NIFTY26SEPFUT"))
      .toEqual({ exchange: null, underlying: "NIFTY", year: 26, month: 9 });
  });

  it("returns null for anything that is not a futures ticker", () => {
    // Options and equities are a different shape and must not be guessed at.
    for (const symbol of ["NSE:BANKNIFTY2682652000CE", "NSE:SBIN-EQ", "NSE:BANKNIFTY26XXXFUT", ""]) {
      expect(parseFuturesSymbol(symbol), symbol).toBeNull();
    }
  });
});

describe("describeContractRoll", () => {
  const expiries = ["2026-07-28", "2026-08-25", "2026-09-29"];

  it("explains a silence caused by an expired contract", () => {
    const roll = describeContractRoll({
      lastCapturedSymbol: "NSE:BANKNIFTY26AUGFUT",
      now: midSession,
      expiries,
    });

    expect(roll?.expiredContract).toBe("NSE:BANKNIFTY26AUGFUT");
    expect(roll?.expiredOn).toBe("2026-08-25");
  });

  /**
   * A confident roll hint for a live contract would send an operator to change a symbol that is
   * already correct, so the silence must be left unexplained instead.
   */
  it("stays silent when the contract has not expired", () => {
    expect(describeContractRoll({
      lastCapturedSymbol: "NSE:BANKNIFTY26SEPFUT",
      now: midSession,
      expiries,
    })).toBeNull();
  });

  it("stays silent on expiry day itself, when the contract is still tradeable", () => {
    expect(describeContractRoll({
      lastCapturedSymbol: "NSE:BANKNIFTY26AUGFUT",
      now: new Date("2026-08-25T06:00:00.000Z"),
      expiries,
    })).toBeNull();
  });

  it("stays silent when the calendar has no expiry for the contract month", () => {
    expect(describeContractRoll({
      lastCapturedSymbol: "NSE:BANKNIFTY26JANFUT",
      now: midSession,
      expiries,
    })).toBeNull();
  });
});

describe("frontMonthFuturesSymbol", () => {
  const SEPT = "2026-09-29";
  const AUG = "2026-08-25";
  const OCT = "2026-10-27";

  it("builds the front-month ticker from the listed expiries", () => {
    expect(frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-27T04:00:00.000Z"),
      expiries: [AUG, SEPT, OCT],
    })).toBe("NSE:BANKNIFTY26SEPFUT");
  });

  it("keeps the contract through its own expiry session, not until the day before", () => {
    /*
     * A contract trades on its expiry date: BANKNIFTY26AUGFUT produced 42,704 frames on 2026-08-25,
     * its expiry day. Rolling on `>` instead of `>=` would abandon a live, maximally liquid contract
     * for one that is still thin.
     */
    expect(frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-25T04:00:00.000Z"),
      expiries: [AUG, SEPT],
    })).toBe("NSE:BANKNIFTY26AUGFUT");
  });

  it("rolls from the session after expiry", () => {
    // 2026-08-26 IST: the August contract is spent and capture in fact went to zero on this date.
    expect(frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-26T04:00:00.000Z"),
      expiries: [AUG, SEPT],
    })).toBe("NSE:BANKNIFTY26SEPFUT");
  });

  it("uses the IST session date, not UTC", () => {
    // 2026-08-25T19:00Z is 2026-08-26 00:30 IST -- already the next session, so already rolled.
    expect(frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-25T19:00:00.000Z"),
      expiries: [AUG, SEPT],
    })).toBe("NSE:BANKNIFTY26SEPFUT");
  });

  it("returns null rather than inventing a contract when nothing is listed", () => {
    /*
     * Refusing beats guessing. A computed last-Thursday fallback is wrong exactly when it matters --
     * that rule put the August expiry on the 27th when the calendar says the 25th -- and this feed
     * accepts an invalid symbol and then delivers silence, so a wrong guess is undetectable.
     */
    expect(frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-27T04:00:00.000Z"),
      expiries: [AUG],
    })).toBeNull();
    expect(frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-27T04:00:00.000Z"),
      expiries: [],
    })).toBeNull();
  });

  it("ignores malformed expiry rows instead of trusting them", () => {
    expect(frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-27T04:00:00.000Z"),
      expiries: ["not-a-date", "2026-9-29", SEPT],
    })).toBe("NSE:BANKNIFTY26SEPFUT");
  });

  it("round-trips through parseFuturesSymbol", () => {
    // The two are inverses; a divergence would make the staleness detector disagree with the thing
    // that chose the symbol, which is worse than either being wrong alone.
    const symbol = frontMonthFuturesSymbol({
      underlying: "BANKNIFTY",
      now: new Date("2026-08-27T04:00:00.000Z"),
      expiries: [SEPT],
    })!;
    expect(parseFuturesSymbol(symbol)).toEqual({
      exchange: "NSE", underlying: "BANKNIFTY", year: 26, month: 9,
    });
  });

  it("refuses a blank underlying", () => {
    expect(frontMonthFuturesSymbol({
      underlying: "   ", now: new Date("2026-08-27T04:00:00.000Z"), expiries: [SEPT],
    })).toBeNull();
  });
});
