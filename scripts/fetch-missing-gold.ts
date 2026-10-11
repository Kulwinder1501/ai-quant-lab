import { Client } from 'pg';
import { execSync } from 'child_process';
import "dotenv/config";
import { OandaHistoricalDataProvider } from "../apps/api/src/infrastructure/market-data/oanda-historical-data-provider.js";
import type { HistoricalMarketCandle } from "../apps/api/src/modules/market-data/domain/historical-data-provider.js";

const OANDA_INSTRUMENT = "XAU_USD";
const OANDA_GRANULARITY = "1m";

function createOandaProvider(): OandaHistoricalDataProvider {
    const accessToken = process.env.OANDA_ACCESS_TOKEN;
    if (!accessToken) {
        throw new Error("OANDA_ACCESS_TOKEN is not set in the .env file.");
    }
    const environment = (process.env.OANDA_ENVIRONMENT ?? "practice") as "practice" | "trade";
    return new OandaHistoricalDataProvider({ accessToken, environment });
}

// Mirrors fetch-bid-ask-xauusd.ts's insert path: this is the only table XAU_USD bid/ask
// candles are stored in, and collect-historical-data.ts never writes to it -- that CLI
// persists mid-price OHLC into the unrelated `candles` table regardless of provider.
async function insertBidAskCandles(client: Client, candles: HistoricalMarketCandle[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < candles.length; i += 2000) {
        const slice = candles.slice(i, i + 2000);
        const values: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        for (const c of slice) {
            // The CHECK constraint on oanda_bid_ask_candles requires complete = true, and a
            // catch-up fetch to "now" can include the still-forming trailing bar.
            if (!c.bid || !c.ask || c.complete === false) continue;

            values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
            params.push(
                OANDA_INSTRUMENT, OANDA_GRANULARITY, c.openTime,
                c.bid.open, c.bid.high, c.bid.low, c.bid.close,
                c.ask.open, c.ask.high, c.ask.low, c.ask.close,
                parseInt(c.volume, 10), true,
                "OANDA", "v3",
            );
        }

        if (values.length === 0) continue;

        await client.query(
            `INSERT INTO oanda_bid_ask_candles (
                instrument, granularity, time,
                bid_open, bid_high, bid_low, bid_close,
                ask_open, ask_high, ask_low, ask_close,
                volume, complete, source, provider_version
            )
            VALUES ${values.join(", ")}
            ON CONFLICT (instrument, granularity, time, source) DO NOTHING`,
            params,
        );
        inserted += values.length;
    }
    return inserted;
}

async function fetchAndStoreBidAskGap(
    client: Client,
    provider: OandaHistoricalDataProvider,
    from: Date,
    to: Date,
): Promise<number> {
    const candles = await provider.fetchCandles({
        providerInstrumentId: OANDA_INSTRUMENT,
        timeframe: "1m",
        from,
        to,
    });
    return insertBidAskCandles(client, candles);
}

async function main() {
    console.log("==========================================");
    console.log("   XAU_USD Missing Data Auto-Fetcher");
    console.log("==========================================");

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error("❌ Error: DATABASE_URL is not set in the .env file.");
        process.exit(1);
    }

    const client = new Client({ connectionString: dbUrl });
    await client.connect();

    const oandaProvider = createOandaProvider();

    console.log("\n🔍 Checking for inner gaps in XAU_USD 1m data (machine downtime)...");
    
    // Find gaps larger than 5 minutes. 
    // This will flag periods where the machine was off.
    // We restrict to the last 14 days to prevent fetching ancient gaps (e.g. from 2020) if bad sparse data exists.
    const gapQuery = `
        WITH lagged AS (
            SELECT time, lag(time) over (order by time) as prev_time
            FROM oanda_bid_ask_candles
            WHERE instrument = 'XAU_USD' AND granularity = '1m'
              AND time > NOW() - interval '14 days'
        )
        SELECT prev_time as gap_start, time as gap_end, 
               EXTRACT(EPOCH FROM (time - prev_time))/60 as gap_minutes
        FROM lagged
        WHERE time - prev_time > interval '5 minutes'
          AND prev_time IS NOT NULL
        ORDER BY gap_start ASC
    `;
    
    const res = await client.query(gapQuery);
    const gaps = res.rows;
    
    if (gaps.length === 0) {
        console.log("✅ No inner missing gaps found!");
    } else {
        console.log(`⚠️ Found ${gaps.length} potential gaps (including weekends).`);
    }
    
    for (const gap of gaps) {
        const fromDate = new Date(gap.gap_start.getTime() + 60000);
        const toDate = gap.gap_end;

        console.log(`\n⬇️ Fetching missing data gap: ${fromDate.toISOString()} to ${toDate.toISOString()} (${Math.round(gap.gap_minutes)} min)`);

        try {
            const inserted = await fetchAndStoreBidAskGap(client, oandaProvider, fromDate, toDate);
            console.log(`  -> Inserted ${inserted} bid/ask candles.`);
        } catch (e) {
            console.error("❌ Failed to fetch data for this gap. It may be a weekend or OANDA returned an error.", e);
        }
    }

    console.log("\n🔍 Checking for latest missing data (from last recorded candle to NOW)...");
    const maxQuery = `SELECT MAX(time) as max_time FROM oanda_bid_ask_candles WHERE instrument = 'XAU_USD' AND granularity = '1m'`;
    const maxRes = await client.query(maxQuery);
    const maxTime = maxRes.rows[0].max_time;

    if (maxTime) {
        const fromDate: Date = maxTime;
        const toDate = new Date();
        console.log(`\n⬇️ Fetching latest 1m data: ${fromDate.toISOString()} to ${toDate.toISOString()}`);

        try {
            const inserted = await fetchAndStoreBidAskGap(client, oandaProvider, fromDate, toDate);
            console.log(`  -> Inserted ${inserted} bid/ask candles.`);
        } catch (e) {
            console.error("❌ Failed to fetch latest 1m data.", e);
        }
    }

    console.log("\n🔍 Checking for latest missing 15m data...");
    const max15Query = `
        SELECT MAX(open_time) as max_time 
        FROM candles c 
        JOIN instruments i ON c.instrument_id = i.id 
        WHERE i.symbol = 'XAU_USD' AND c.timeframe = '15m'
    `;
    const max15Res = await client.query(max15Query);
    const max15Time = max15Res.rows[0].max_time;
    
    if (max15Time) {
        const fromIso = max15Time.toISOString();
        const toIso = new Date().toISOString();
        console.log(`\n⬇️ Fetching latest 15m data: ${fromIso} to ${toIso}`);
        
        const cmd = `npx tsx apps/api/src/interfaces/cli/collect-historical-data.ts --instrument XAU_USD --exchange OANDA --provider oanda --timeframe 15m --from "${fromIso}" --to "${toIso}" --skip-existing`;
        try {
            execSync(cmd, { stdio: 'inherit' });
        } catch (e) {
            console.error("❌ Failed to fetch latest 15m data.");
        }
    }

    await client.end();
    console.log("\n✅ Done catching up all XAU_USD market data.");
}

main().catch(e => {
    console.error("Fatal error:", e);
    process.exit(1);
});
