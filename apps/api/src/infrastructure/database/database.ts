import { Pool, type PoolClient, type QueryResultRow } from "pg";

export type DatabaseClient = Pick<PoolClient, "query">;
export type DatabaseQueryable = Pick<Pool, "query">;
export type DatabasePool = Pool;

export function createDatabasePool(databaseUrl: string): DatabasePool {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  pool.on("error", (error) => {
    console.error(JSON.stringify({ level: "error", message: "Unexpected database pool error", error: error.message }));
  });
  return pool;
}

export interface DatabaseReadiness {
  ready: boolean;
  serverTime?: string;
}

export async function checkDatabaseReadiness(database: Pick<Pool, "query">): Promise<DatabaseReadiness> {
  const result = await database.query<{ server_time: Date }>("SELECT CURRENT_TIMESTAMP AS server_time");
  return { ready: true, serverTime: result.rows[0].server_time.toISOString() };
}

/** Keeps repository result rows constrained to pg's supported shape. */
export type DatabaseRow = QueryResultRow;
