import type { DatabaseQueryable } from "../database.js";

/**
 * Reads of what the collectors did, for the data-coverage view: the scheduler's run history and the Fyers request ledger.
 * Both are written by other processes; nothing here writes.
 */

export interface ScheduledJobRunRow {
  scheduledFor: Date;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  /** The failure text as stored (a job's last stdout, which can be long). Null unless the run failed. */
  errorDetails: string | null;
  /** The note kept against a COMPLETED run (a `PARTIAL ...` note when an underlying was not collected). Null for any other status. */
  completionNote: string | null;
}

/**
 * Every run of one job type scheduled on the IST dates `fromDate` to `toDate` inclusive, oldest first. A run the scheduler
 * skipped (for example by the Fyers budget guard) is not in the table by design, so its absence is not a row here.
 */
export async function findScheduledJobRuns(
  database: DatabaseQueryable,
  input: { jobType: string; fromDate: string; toDate: string },
): Promise<ScheduledJobRunRow[]> {
  const result = await database.query<{ scheduled_for: Date; status: string; error_details: string | null }>(
    `SELECT scheduled_for, status, error_details
       FROM scheduled_job_runs
      WHERE job_type = $1
        AND scheduled_for >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND scheduled_for <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
      ORDER BY scheduled_for ASC`,
    [input.jobType, input.fromDate, input.toDate],
  );
  return result.rows.map((row) => ({
    scheduledFor: row.scheduled_for,
    status: row.status as ScheduledJobRunRow["status"],
    errorDetails: row.status === "FAILED" ? row.error_details : null,
    completionNote: row.status === "COMPLETED" ? row.error_details : null,
  }));
}

export interface FyersRequestLedgerRow {
  /** IST calendar date, `YYYY-MM-DD`. */
  dateKey: string;
  endpoint: string;
  requestCount: number;
}

/** The Fyers REST requests counted per IST day and endpoint, for the dates `fromDate` to `toDate` inclusive. */
export async function findFyersRequestLedger(
  database: DatabaseQueryable,
  input: { fromDate: string; toDate: string },
): Promise<FyersRequestLedgerRow[]> {
  const result = await database.query<{ date_key: string; endpoint: string; request_count: number | string }>(
    `SELECT date_key, endpoint, request_count
       FROM fyers_daily_request_ledger
      WHERE date_key >= $1 AND date_key <= $2
      ORDER BY date_key DESC, request_count DESC`,
    [input.fromDate, input.toDate],
  );
  return result.rows.map((row) => ({ dateKey: row.date_key, endpoint: row.endpoint, requestCount: Number(row.request_count) }));
}
