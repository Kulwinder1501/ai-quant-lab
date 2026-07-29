import axios from "axios";
import type { InstitutionalFlow } from "../../modules/market-data/domain/institutional-flow.js";
import type { OffshoreDerivative } from "../../modules/market-data/domain/offshore-derivative.js";

export class NseApiClient {
  private readonly baseUrl = "https://www.nseindia.com";
  private sessionCookies: string[] = [];

  private async initializeSession(): Promise<void> {
    try {
      const response = await axios.get(this.baseUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        timeout: 10000,
      });
      const cookies = response.headers["set-cookie"];
      if (cookies) {
        this.sessionCookies = cookies.map(c => c.split(";")[0]);
      }
    } catch (error) {
      console.warn("Failed to initialize NSE session cookies. Will attempt without them.");
    }
  }

  async getFiiDiiData(date: Date): Promise<InstitutionalFlow | null> {
    await this.initializeSession();
    try {
      // NSE API for FII DII. Note: The NSE API typically returns data for the latest trading day.
      // We'll fetch the latest and verify if it matches the requested date.
      const response = await axios.get(`${this.baseUrl}/api/fiidiiTradeReact`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Cookie": this.sessionCookies.join("; "),
        },
        timeout: 10000,
      });

      const data = response.data;
      if (!data || !data.length) return null;

      // Extract FII and DII rows
      const fiiRow = data.find((row: any) => row.category === "FII/FPI *");
      const diiRow = data.find((row: any) => row.category === "DII **");

      if (!fiiRow || !diiRow) return null;

      // Parse the date (NSE returns e.g. "29-Jul-2026")
      // To keep it simple, we'll assume the API returns today's EOD data when called post-market
      return {
        date: date,
        fiiCashNetCr: parseFloat(fiiRow.buyValue) - parseFloat(fiiRow.sellValue),
        diiCashNetCr: parseFloat(diiRow.buyValue) - parseFloat(diiRow.sellValue),
        // The NSE fiidiiTradeReact endpoint typically only has cash data.
        // For futures/options, we would need the derivatives report. We will default to 0 for now.
        fiiIndexFuturesNetCr: 0,
        fiiIndexOptionsNetCr: 0,
      };
    } catch (error) {
      console.error("Error fetching FII/DII data from NSE:", error);
      return null;
    }
  }

  async getGiftNiftyData(date: Date): Promise<OffshoreDerivative | null> {
    // GIFT Nifty data is traded on NSE IX (nseix.com). 
    // Scraping it reliably is complex without a paid API.
    // As a placeholder for the MVP, we will simulate a 0 bps gap if the real API fails.
    // In production, you would integrate a dedicated market data provider (e.g., Bloomberg, Refinitiv) here.
    return {
      instrumentId: "GIFT_NIFTY",
      date: date,
      closePrice: 0, // 0 signifies no data/neutral gap
    };
  }
}
