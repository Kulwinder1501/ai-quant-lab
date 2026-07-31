import type { DatabaseQueryable } from "../database.js";
import type { ScheduledJobClaim, ScheduledJobClaimRepository } from "../../../modules/scheduling/domain/scheduled-job.js";

export class PostgresScheduledJobClaimRepository implements ScheduledJobClaimRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Wins the claim by inserting the (job_type, scheduled_for) row, or loses on conflict.
   *
   * `ON CONFLICT DO NOTHING` with `RETURNING id` is the whole lock: the unique index
   * decides, the database serialises the race, and exactly one caller gets a row back.
   * No transaction or advisory lock is needed, and unlike an advisory lock the claim
   * survives the claimant crashing -- which is correct, because a due minute that was
   * attempted has been consumed.
   */
  async claim(claim: ScheduledJobClaim): Promise<boolean> {
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO scheduled_job_runs (job_type, scheduled_for, claimed_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (job_type, scheduled_for) DO NOTHING
      RETURNING id
    `, [claim.jobType, claim.scheduledFor, claim.claimedBy]);

    return result.rows.length === 1;
  }

  async complete(claim: Omit<ScheduledJobClaim, "claimedBy">): Promise<void> {
    await this.database.query(`
      UPDATE scheduled_job_runs
      SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP
      WHERE job_type = $1 AND scheduled_for = $2 AND status = 'RUNNING'
    `, [claim.jobType, claim.scheduledFor]);
  }

  async fail(claim: Omit<ScheduledJobClaim, "claimedBy">, errorDetails: string): Promise<void> {
    await this.database.query(`
      UPDATE scheduled_job_runs
      SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP, error_details = $3
      WHERE job_type = $1 AND scheduled_for = $2 AND status = 'RUNNING'
    `, [claim.jobType, claim.scheduledFor, errorDetails]);
  }
}
