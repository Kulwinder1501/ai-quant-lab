/** Shared contracts; keep framework and database imports out of this package. */
export type MarketSegment = "INDEX" | "EQUITY";
export type TradeSide = "LONG" | "SHORT";
export type TradeStatus = "OPEN" | "CLOSED" | "CANCELLED";

export interface Candle {
  instrumentId: string;
  timeframe: string;
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isComplete: boolean;
}

export interface TradeIdea {
  instrumentId: string;
  side: TradeSide;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  confidence: number;
  reasoning: string[];
  status: TradeStatus;
}
