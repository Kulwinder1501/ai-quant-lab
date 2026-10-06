export type AutomatedTradeSource = "PAPER_BOT" | "AUTONOMOUS_AGENT" | "VOLATILITY_BOT";

export interface AutomatedTradeOpenedNotification {
  eventId: string;
  paperTradeId: string;
  source: AutomatedTradeSource;
  accountId: string;
  accountName: string;
  instrumentSymbol: string;
  timeframe: string | null;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  occurredAt: string;
  optionStrike: number | null;
  optionExpiry: string | null;
  optionType: "CE" | "PE" | null;
  underlyingSymbol: string | null;
}

export function automatedTradeSourceLabel(source: AutomatedTradeSource): string {
  if (source === "AUTONOMOUS_AGENT") return "Autonomous agent";
  if (source === "VOLATILITY_BOT") return "Volatility bot";
  return "Paper bot";
}

export function automatedTradeContractLabel(trade: AutomatedTradeOpenedNotification): string {
  if (
    trade.underlyingSymbol
    && trade.optionStrike !== null
    && (trade.optionType === "CE" || trade.optionType === "PE")
  ) {
    return `${trade.underlyingSymbol} ${trade.optionStrike} ${trade.optionType}`;
  }
  return trade.instrumentSymbol;
}

function amount(value: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
}

export function automatedTradeToastDescription(trade: AutomatedTradeOpenedNotification): string {
  return `${automatedTradeSourceLabel(trade.source)} bought ${amount(trade.quantity)} at ₹${amount(trade.entryPrice)}`
    + ` · SL ₹${amount(trade.stopLoss)} · Target ₹${amount(trade.targetPrice)}`;
}
