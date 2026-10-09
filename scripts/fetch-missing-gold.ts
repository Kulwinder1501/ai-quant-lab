import { Client } from 'pg';
import { execSync } from 'child_process';
import "dotenv/config";

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

    console.log("\n🔍 Checking for inner gaps in XAU_USD 1m data (machine downtime)...");
    
    // Find gaps larger than 5 minutes. 
    // This will flag periods where the machine was off.
    const gapQuery = `
        WITH lagged AS (
            SELECT time, lag(time) over (order by time) as prev_time
            FROM oanda_bid_ask_candles
            WHERE instrument = 'XAU_USD' AND granularity = '1m'
        )
        SELECT prev_time as gap_start, time as gap_end, 
               EXTRACT(EPOCH FROM (time - prev_time))/60 as gap_minutes
        FROM lagged
        WHERE time - prev_time > interval '5 minutes'
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
        const fromIso = new Date(gap.gap_start.getTime() + 60000).toISOString(); 
        const toIso = gap.gap_end.toISOString();
        
        console.log(`\n⬇️ Fetching missing data gap: ${fromIso} to ${toIso} (${Math.round(gap.gap_minutes)} min)`);
        
        const cmd = `npx tsx apps/api/src/interfaces/cli/collect-historical-data.ts --instrument XAU_USD --exchange OANDA --provider oanda --timeframe 1m --from "${fromIso}" --to "${toIso}" --skip-existing`;
        
        try {
            execSync(cmd, { stdio: 'inherit' });
        } catch (e) {
            console.error("❌ Failed to fetch data for this gap. It may be a weekend or OANDA returned an error.");
        }
    }
    
    console.log("\n🔍 Checking for latest missing data (from last recorded candle to NOW)...");
    const maxQuery = `SELECT MAX(time) as max_time FROM oanda_bid_ask_candles WHERE instrument = 'XAU_USD' AND granularity = '1m'`;
    const maxRes = await client.query(maxQuery);
    const maxTime = maxRes.rows[0].max_time;
    
    if (maxTime) {
        const fromIso = maxTime.toISOString();
        const toIso = new Date().toISOString();
        console.log(`\n⬇️ Fetching latest 1m data: ${fromIso} to ${toIso}`);
        
        const cmd = `npx tsx apps/api/src/interfaces/cli/collect-historical-data.ts --instrument XAU_USD --exchange OANDA --provider oanda --timeframe 1m --from "${fromIso}" --to "${toIso}" --skip-existing`;
        try {
            execSync(cmd, { stdio: 'inherit' });
        } catch (e) {
            console.error("❌ Failed to fetch latest 1m data.");
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
