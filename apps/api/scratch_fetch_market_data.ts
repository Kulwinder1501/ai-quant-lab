import "dotenv/config";
import yahooFinance from "yahoo-finance2";

async function main() {
  const yf = new (yahooFinance as any)({ suppressNotices: ['ripHistorical'] });

  const symbols = [
    { name: "NIFTY50", yahoo: "^NSEI" },
    { name: "BANKNIFTY", yahoo: "^NSEBANK" },
    { name: "INDIA_VIX", yahoo: "^INDIAVIX" },
  ];

  // Fetch daily data for the last 15 trading days
  const from = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
  const to = new Date();

  for (const sym of symbols) {
    console.log(`\n========== ${sym.name} (${sym.yahoo}) ==========`);
    try {
      const result = await yf.chart(sym.yahoo, {
        period1: from,
        period2: to,
        interval: "1d",
      });

      const quotes = result.quotes;
      console.log(`Total candles: ${quotes.length}`);
      for (const q of quotes) {
        const date = new Date(q.date).toISOString().split("T")[0];
        console.log(
          `${date} | O: ${q.open?.toFixed(2)} | H: ${q.high?.toFixed(2)} | L: ${q.low?.toFixed(2)} | C: ${q.close?.toFixed(2)} | V: ${q.volume}`
        );
      }
    } catch (err: any) {
      console.error(`Error fetching ${sym.name}:`, err.message);
    }
  }

  // Fetch 15-minute intraday for NIFTY50 today
  console.log(`\n========== NIFTY50 INTRADAY 15m (Today) ==========`);
  try {
    const intraday = await yf.chart("^NSEI", {
      period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      period2: to,
      interval: "15m",
    });
    const quotes = intraday.quotes;
    console.log(`Total 15m candles: ${quotes.length}`);
    // Print last 30 candles (today's session)
    const recent = quotes.slice(-30);
    for (const q of recent) {
      const dt = new Date(q.date).toISOString().replace("T", " ").substring(0, 19);
      console.log(
        `${dt} | O: ${q.open?.toFixed(2)} | H: ${q.high?.toFixed(2)} | L: ${q.low?.toFixed(2)} | C: ${q.close?.toFixed(2)} | V: ${q.volume}`
      );
    }
  } catch (err: any) {
    console.error("Error fetching intraday:", err.message);
  }

  // Fetch 15-minute intraday for BANKNIFTY today
  console.log(`\n========== BANKNIFTY INTRADAY 15m (Today) ==========`);
  try {
    const intraday = await yf.chart("^NSEBANK", {
      period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      period2: to,
      interval: "15m",
    });
    const quotes = intraday.quotes;
    console.log(`Total 15m candles: ${quotes.length}`);
    const recent = quotes.slice(-30);
    for (const q of recent) {
      const dt = new Date(q.date).toISOString().replace("T", " ").substring(0, 19);
      console.log(
        `${dt} | O: ${q.open?.toFixed(2)} | H: ${q.high?.toFixed(2)} | L: ${q.low?.toFixed(2)} | C: ${q.close?.toFixed(2)} | V: ${q.volume}`
      );
    }
  } catch (err: any) {
    console.error("Error fetching BANKNIFTY intraday:", err.message);
  }
}

main();
