import { createDatabasePool } from "./apps/api/src/infrastructure/database/database.js";

async function main() {
  const db = createDatabasePool("postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab");
  try {
    const res = await db.query("SELECT pg_cancel_backend(442855)");
    console.log(res.rows);
  } finally {
    await db.end();
  }
}

main().catch(console.error);
