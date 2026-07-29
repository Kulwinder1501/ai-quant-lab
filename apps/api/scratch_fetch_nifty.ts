import "dotenv/config";
import { YahooHistoricalDataProvider } from "./src/infrastructure/market-data/yahoo-historical-data-provider.js";
import { resolveYahooSymbol } from "./src/modules/market-data/domain/yahoo-symbol-resolver.js";

async function main() {
  console.log("Fetching NIFTY50 data from Yahoo Finance...");
  const provider = new YahooHistoricalDataProvider();
  
  const from = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
  const to = new Date();
  
  try {
    const candles = await provider.fetchCandles({
      providerInstrumentId: "NIFTY50", // It gets resolved to ^NSEI or similar
      timeframe: "1d",
      from,
      to
    });
    
    console.log(`Fetched ${candles.length} candles.`);
    for (const c of candles.slice(-5)) { // Print last 5
      console.log(`Date: ${c.timestamp}, Open: ${c.open}, High: ${c.high}, Low: ${c.low}, Close: ${c.close}, Vol: ${c.volume}`);
    }
  } catch (error) {
    console.error("Error fetching data:", error);
  }
}

main();
