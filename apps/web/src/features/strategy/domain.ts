export interface TradeIdeaRow {
  id: string;
  instrumentId: string;
  instrumentSymbol: string;
  instrumentName: string;
  strategyVersionId?: string | null;
  strategyKey?: string | null;
  candleTimeframe?: string | null;
  candleCloseTime?: string | null;
  side: "BUY" | "SELL" | string;
  status: string;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  riskReward: number;
  confidence: number;
  reasoning?: Array<{ rule: string; passed: boolean; details?: unknown }> | unknown;
  evidence?: Record<string, unknown> | unknown;
  expiresAt?: string | null;
}
