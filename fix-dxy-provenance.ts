import { createDatabasePool } from './apps/api/src/infrastructure/database/database.js';

const db = createDatabasePool("postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab");

async function run() {
  await db.query(`
    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT id, '1m', 'synthetic' FROM instruments WHERE symbol = 'DXY'
    ON CONFLICT (instrument_id, timeframe) DO UPDATE SET source = 'synthetic'
  `);
  
  await db.query(`
    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT id, tf.tf, 'synthetic' FROM instruments CROSS JOIN (VALUES ('5m'), ('15m'), ('30m'), ('60m'), ('1440m')) as tf(tf) WHERE symbol = 'DXY'
    ON CONFLICT (instrument_id, timeframe) DO UPDATE SET source = 'synthetic'
  `);
  
  console.log('DXY provenance fixed');
  await db.end();
}

run().catch(console.error);
