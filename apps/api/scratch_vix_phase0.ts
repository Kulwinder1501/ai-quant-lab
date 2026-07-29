import pg from 'pg';
import yahooFinance from 'yahoo-finance2';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { PriceActionEngine } from './src/modules/pattern-recognition/domain/price-action-engine.js';
import type { PatternCandle } from './src/modules/pattern-recognition/domain/market-pattern.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function run() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    console.log("Fetching NIFTY50 candles from DB...");
    const res = await pool.query(`
      SELECT open_time, close_time, open, high, low, close, volume, c.id
      FROM public.candles c
      JOIN public.instruments i ON c.instrument_id = i.id
      WHERE i.symbol = 'NIFTY50' AND c.timeframe = '1d' AND c.is_complete = true
      ORDER BY close_time ASC
    `);
    
    if (res.rows.length === 0) {
      console.log("No NIFTY50 candles found.");
      return;
    }
    
    const candles: PatternCandle[] = res.rows.map(row => ({
      id: row.id,
      openTime: row.open_time,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume)
    }));

    console.log(`Fetched ${candles.length} NIFTY50 candles.`);

    // Run price action engine to get fresh breakouts (bypassing the db duplicate bug)
    const engine = new PriceActionEngine();
    const allEvents = engine.detect(candles);
    const breakouts = allEvents.filter(e => e.eventCode === 'BREAKOUT' || e.eventCode === 'BREAKDOWN');
    
    console.log(`Detected ${breakouts.length} clean breakouts/breakdowns.`);

    const startDate = candles[0].openTime;
    const endDate = candles[candles.length - 1].openTime;

    console.log(`Fetching ^INDIAVIX from Yahoo Finance from ${startDate.toISOString()} to ${endDate.toISOString()}...`);
    const yf = new (yahooFinance as any)({ suppressNotices: ['ripHistorical'] });
    const yfResults = await yf.chart('^INDIAVIX', {
      period1: startDate,
      period2: new Date(endDate.getTime() + 86400000), // add one day
      interval: '1d'
    });
    const vixData = yfResults.quotes || [];
    console.log(`Fetched ${vixData.length} VIX records.`);

    // Create a dictionary of VIX closes by date string (YYYY-MM-DD)
    const vixByDate = new Map<string, number>();
    vixData.forEach(v => {
      const dateStr = v.date.toISOString().slice(0, 10);
      vixByDate.set(dateStr, v.close);
    });

    // Calculate VIX SMA(20) to determine regime
    const vixDates = Array.from(vixByDate.keys()).sort();
    const vixSmaByDate = new Map<string, number>();
    for (let i = 19; i < vixDates.length; i++) {
      let sum = 0;
      for (let j = 0; j < 20; j++) {
        sum += vixByDate.get(vixDates[i - j])!;
      }
      vixSmaByDate.set(vixDates[i], sum / 20);
    }

    // Measure forward returns (e.g. 5 days)
    const HORIZON = 5;
    const results = {
      BREAKOUT: { HIGH_VOL: { returns: [] as number[] }, LOW_VOL: { returns: [] as number[] } },
      BREAKDOWN: { HIGH_VOL: { returns: [] as number[] }, LOW_VOL: { returns: [] as number[] } }
    };

    for (const event of breakouts) {
      // Find the index of the candle
      const cIdx = candles.findIndex(c => c.id === event.candleId);
      if (cIdx === -1 || cIdx + HORIZON >= candles.length) continue;
      
      const eventDateStr = candles[cIdx].openTime.toISOString().slice(0, 10);
      
      // Get VIX regime
      const vixClose = vixByDate.get(eventDateStr);
      const vixSma = vixSmaByDate.get(eventDateStr);
      
      if (vixClose === undefined || vixSma === undefined) continue;
      
      const regime = vixClose > vixSma ? 'HIGH_VOL' : 'LOW_VOL';
      
      // Calculate forward return
      const entryPrice = candles[cIdx].close;
      const exitPrice = candles[cIdx + HORIZON].close;
      const forwardReturn = (exitPrice - entryPrice) / entryPrice;
      
      // Store result
      results[event.eventCode as 'BREAKOUT'|'BREAKDOWN'][regime].returns.push(forwardReturn);
    }

    console.log("\n--- Phase 0 Results: Does it separate? ---");
    for (const eventType of ['BREAKOUT', 'BREAKDOWN']) {
      for (const regime of ['HIGH_VOL', 'LOW_VOL']) {
        const rets = results[eventType as 'BREAKOUT'|'BREAKDOWN'][regime as 'HIGH_VOL'|'LOW_VOL'].returns;
        const count = rets.length;
        const avgRet = count > 0 ? rets.reduce((a, b) => a + b, 0) / count : 0;
        const winRate = count > 0 ? rets.filter(r => eventType === 'BREAKOUT' ? r > 0 : r < 0).length / count : 0;
        
        console.log(`${eventType} | ${regime} | Count: ${count.toString().padStart(3)} | Avg ${HORIZON}d Return: ${(avgRet * 100).toFixed(2)}% | Win Rate: ${(winRate * 100).toFixed(2)}%`);
      }
      console.log("------------------------------------------");
    }

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
