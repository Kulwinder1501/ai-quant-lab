import "dotenv/config";
import yahooFinance from "yahoo-finance2";

// Check how far back Yahoo Finance can provide data
async function main() {
  const yf = new (yahooFinance as any)({ suppressNotices: ['ripHistorical'] });

  // Try fetching 3 years of daily NIFTY50 data
  const from = new Date("2023-01-01");
  const to = new Date();

  console.log("=== DAILY DATA AVAILABILITY ===");
  try {
    const result = await yf.chart("^NSEI", { period1: from, period2: to, interval: "1d" });
    const quotes = result.quotes;
    const firstDate = new Date(quotes[0].date).toISOString().split("T")[0];
    const lastDate = new Date(quotes[quotes.length - 1].date).toISOString().split("T")[0];
    console.log(`NIFTY50 Daily: ${quotes.length} candles available from ${firstDate} to ${lastDate}`);
  } catch (err: any) {
    console.error("Daily error:", err.message);
  }

  // Check 15m data limits
  console.log("\n=== 15-MINUTE DATA AVAILABILITY ===");
  try {
    const result15m = await yf.chart("^NSEI", {
      period1: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
      period2: to,
      interval: "15m",
    });
    const quotes = result15m.quotes;
    const firstDate = new Date(quotes[0].date).toISOString().replace("T", " ").substring(0, 19);
    const lastDate = new Date(quotes[quotes.length - 1].date).toISOString().replace("T", " ").substring(0, 19);
    console.log(`NIFTY50 15m: ${quotes.length} candles available from ${firstDate} to ${lastDate}`);
  } catch (err: any) {
    console.error("15m error:", err.message);
  }

  // Check BANKNIFTY daily too
  console.log("\n=== BANKNIFTY DAILY AVAILABILITY ===");
  try {
    const result = await yf.chart("^NSEBANK", { period1: from, period2: to, interval: "1d" });
    const quotes = result.quotes;
    const firstDate = new Date(quotes[0].date).toISOString().split("T")[0];
    const lastDate = new Date(quotes[quotes.length - 1].date).toISOString().split("T")[0];
    console.log(`BANKNIFTY Daily: ${quotes.length} candles available from ${firstDate} to ${lastDate}`);
  } catch (err: any) {
    console.error("BANKNIFTY Daily error:", err.message);
  }
}

main();
