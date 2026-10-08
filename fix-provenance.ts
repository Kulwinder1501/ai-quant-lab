import { createDatabasePool } from './apps/api/src/infrastructure/database/database.js';

const db = createDatabasePool("postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab");

async function run() {
  await db.query(`
    INSERT INTO candle_series_provenance (instrument_id, timeframe, source) 
    SELECT i.id, tf.tf, 'oanda' 
    FROM instruments i CROSS JOIN (VALUES ('5m'), ('15m'), ('30m'), ('60m'), ('1440m')) as tf(tf) 
    WHERE i.exchange = 'OANDA' AND i.symbol != 'DXY' 
    ON CONFLICT DO NOTHING
  `);
  
  await db.query(`
    INSERT INTO candle_series_provenance (instrument_id, timeframe, source) 
    SELECT i.id, tf.tf, 'synthetic' 
    FROM instruments i CROSS JOIN (VALUES ('1m'), ('5m'), ('15m'), ('30m'), ('60m'), ('1440m')) as tf(tf) 
    WHERE i.symbol = 'DXY' 
    ON CONFLICT DO NOTHING
  `);
  
  console.log('Provenance fixed');
  await db.end();
}

run().catch(console.error);
