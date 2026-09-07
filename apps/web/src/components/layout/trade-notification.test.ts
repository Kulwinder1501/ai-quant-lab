import { describe, expect, it } from "vitest";
import {
  automatedTradeContractLabel,
  automatedTradeSourceLabel,
  automatedTradeToastDescription,
  type AutomatedTradeOpenedNotification,
} from "./trade-notification";

const notification: AutomatedTradeOpenedNotification = {
  eventId: "event-1",
  paperTradeId: "trade-1",
  source: "AUTONOMOUS_AGENT",
  accountId: "account-1",
  accountName: "Default Paper Account",
  instrumentSymbol: "NIFTY50",
  timeframe: "5m",
  side: "LONG",
  quantity: 65,
  entryPrice: 123.45,
  stopLoss: 98.76,
  targetPrice: 160,
  occurredAt: "2026-08-12T08:00:00.000Z",
  optionStrike: 25000,
  optionExpiry: "2026-08-13T10:00:00.000Z",
  optionType: "CE",
  underlyingSymbol: "NIFTY50",
};

describe("automated trade notifications", () => {
  it("shows the actual option contract instead of the index", () => {
    expect(automatedTradeContractLabel(notification)).toBe("NIFTY50 25000 CE");
  });

  it("includes fill, quantity, stop and target in the toast", () => {
    expect(automatedTradeToastDescription(notification)).toBe(
      "Autonomous agent bought 65 at ₹123.45 · SL ₹98.76 · Target ₹160",
    );
  });

  it("labels every automated execution source", () => {
    expect(automatedTradeSourceLabel("PAPER_BOT")).toBe("Paper bot");
    expect(automatedTradeSourceLabel("AUTONOMOUS_AGENT")).toBe("Autonomous agent");
    expect(automatedTradeSourceLabel("VOLATILITY_BOT")).toBe("Volatility bot");
  });
});
