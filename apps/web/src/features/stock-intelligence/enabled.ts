export function isStockIntelligenceUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_STOCK_INTELLIGENCE_ENABLED === "true";
}
