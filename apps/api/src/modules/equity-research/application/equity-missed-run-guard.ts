import { isNseHoliday } from "../../market-data/domain/nse-session-calendar.js";

export interface DatabaseQueryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AttemptState {
  attempts: number;
  lastAttemptMs: number;
  lastAttemptIstDay: string; // YYYY-MM-DD in IST
  exhausted?: boolean;
}

export interface EquityMissedRunGuardOptions {
  commandRunner?: (command: string, args: string[]) => Promise<void>;
  lookbackDays?: number;
  guardStartDate?: string;
  maxAttemptsPerDate?: number;
  backoffMs?: number;
  logger?: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

export interface EquityCatchupResult {
  missingDates: string[];
  collected: boolean;
  evaluatedDates: string[];
}

export const DEFAULT_EQUITY_GUARD_START_DATE = "2026-10-21";

/**
 * Adds an integer number of days to a YYYY-MM-DD date string using pure UTC math.
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

/**
 * Checks if a YYYY-MM-DD date string falls on a Saturday or Sunday.
 */
export function isWeekend(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dayOfWeek = dt.getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6; // Sunday = 0, Saturday = 6
}

/**
 * Computes the IST calendar date (YYYY-MM-DD) for a given epoch millisecond timestamp.
 */
export function getIstDayString(ms: number): string {
  const istDate = new Date(ms + 5.5 * 60 * 60_000);
  return istDate.toISOString().slice(0, 10);
}

/**
 * Computes the latest calendar date eligible for EOD evaluation as of wall-clock time.
 * In IST:
 * - If current IST time is 17:05 or later, today's trading session has closed and is eligible.
 * - If before 17:05 IST, today's trading session is not yet closed / EOD not yet due, so yesterday is the latest eligible date.
 */
export function getEligibleEndDate(now = new Date()): string {
  const istMs = now.getTime() + 5.5 * 60 * 60_000;
  const istDate = new Date(istMs);
  const todayIst = istDate.toISOString().slice(0, 10);
  const minuteOfDay = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
  if (minuteOfDay >= 17 * 60 + 5) {
    return todayIst;
  }
  return addDays(todayIst, -1);
}

/**
 * Default child-process command runner using child_process.spawn.
 */
async function defaultCommandRunner(command: string, args: string[]): Promise<void> {
  const { spawn } = await import("child_process");
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: "inherit", shell: true });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command ${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

/**
 * EquityMissedRunGuard:
 * Decides on wall-clock time (not a cron) to identify non-holiday weekdays
 * across a lookback window that lack price bars or alert evaluation.
 *
 * Safety & Resilience:
 * - Clamps lookback window to guardStartDate (default 2026-10-21) to prevent evaluating pre-launch backfill days.
 * - Audits all dates across lookback window, so historical gaps behind later evaluated dates are recovered.
 * - Enforces an attempt cap (default 3) and backoff (default 15 minutes) per date, resetting daily at IST midnight.
 * - Only records a date as evaluated if bars exist AND evaluation actually ran.
 * - If bars have not appeared yet, leaves the date missing and retries later up to the cap.
 */
export class EquityMissedRunGuard {
  private readonly commandRunner: (command: string, args: string[]) => Promise<void>;
  private readonly lookbackDays: number;
  private readonly guardStartDate: string;
  private readonly maxAttemptsPerDate: number;
  private readonly backoffMs: number;
  private readonly logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };

  /**
   * Per-date retry tracking state.
   */
  private readonly dateAttempts = new Map<string, AttemptState>();

  constructor(
    private readonly db: DatabaseQueryable,
    options?: EquityMissedRunGuardOptions,
  ) {
    this.commandRunner = options?.commandRunner ?? defaultCommandRunner;
    this.lookbackDays = options?.lookbackDays ?? 10;
    this.guardStartDate =
      options?.guardStartDate ??
      process.env.EQUITY_GUARD_START_DATE ??
      DEFAULT_EQUITY_GUARD_START_DATE;
    this.maxAttemptsPerDate = options?.maxAttemptsPerDate ?? 3;
    this.backoffMs = options?.backoffMs ?? 15 * 60_000;
    this.logger = options?.logger ?? {
      info: (msg, ctx) => console.info(JSON.stringify({ level: "info", message: msg, ...ctx })),
      warn: (msg, ctx) => console.warn(JSON.stringify({ level: "warn", message: msg, ...ctx })),
      error: (msg, ctx) => console.error(JSON.stringify({ level: "error", message: msg, ...ctx })),
    };
  }

  /**
   * Retrieves retry state for a specific date (useful for inspection/tests).
   */
  getAttemptState(dateStr: string): AttemptState | undefined {
    return this.dateAttempts.get(dateStr);
  }

  /**
   * Cleans/resets attempt state if a new IST day has started.
   */
  private getOrResetAttemptState(dateStr: string, nowMs: number): AttemptState | undefined {
    const state = this.dateAttempts.get(dateStr);
    if (!state) return undefined;

    const currentIstDay = getIstDayString(nowMs);
    if (state.lastAttemptIstDay !== currentIstDay) {
      // New IST day has begun: reset attempt state so date gets another try
      this.dateAttempts.delete(dateStr);
      return undefined;
    }
    return state;
  }

  /**
   * Clears attempt state (useful for tests).
   */
  clearAttemptState(): void {
    this.dateAttempts.clear();
  }

  /**
   * Checks whether the date is an exchange holiday listed in nse_holidays.
   */
  async isHoliday(dateStr: string): Promise<boolean> {
    const holidayCheck = await isNseHoliday(this.db, new Date(`${dateStr}T12:00:00+05:30`));
    return holidayCheck.holiday;
  }

  /**
   * Checks if price bars exist for the given date in equity_research.price_bar.
   */
  async hasBarsForDate(dateStr: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM equity_research.price_bar
        WHERE bar_date = $1::date
      ) AS exists`,
      [dateStr],
    );
    return Boolean(result.rows[0]?.exists);
  }

  /**
   * Checks if an evaluation was completed for the date, indicated by:
   * 1. A COMPLETED row in scheduled_job_runs for EQUITY_EOD_COLLECT or EQUITY_ALERTS_EVAL, OR
   * 2. Existing alert records in equity_research.alert for evaluated_date.
   */
  async hasEvaluationForDate(dateStr: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM scheduled_job_runs
        WHERE job_type IN ('EQUITY_EOD_COLLECT', 'EQUITY_ALERTS_EVAL')
          AND status = 'COMPLETED'
          AND (scheduled_for AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      ) OR EXISTS (
        SELECT 1 FROM equity_research.alert
        WHERE evaluated_date = $1
      ) AS exists`,
      [dateStr],
    );
    return Boolean(result.rows[0]?.exists);
  }

  /**
   * Records completed evaluation in scheduled_job_runs for a given date.
   */
  async recordEvaluationCompleted(dateStr: string): Promise<void> {
    await this.db.query(
      `INSERT INTO scheduled_job_runs (
        id, job_type, scheduled_for, status, claimed_by, claimed_at, completed_at
      ) VALUES (
        gen_random_uuid(),
        'EQUITY_ALERTS_EVAL',
        ($1 || ' 17:00:00+05:30')::timestamptz,
        'COMPLETED',
        'equity-missed-run-guard',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (job_type, scheduled_for)
      DO UPDATE SET
        status = 'COMPLETED',
        completed_at = CURRENT_TIMESTAMP`,
      [dateStr],
    );
  }

  /**
   * Finds every non-holiday weekday across the lookback window that lacks bars or evaluation.
   * Dates are returned strictly in ascending chronological order (oldest first).
   *
   * Clamped by guardStartDate so days before system launch are never evaluated.
   * Respects daily attempt limits (reset at IST midnight) and 15-minute backoff.
   */
  async findMissingDates(options?: {
    lookbackDays?: number;
    asOfDate?: Date;
    startDate?: string;
    guardStartDate?: string;
    nowMs?: number;
  }): Promise<string[]> {
    const now = options?.asOfDate ?? new Date();
    const nowMs = options?.nowMs ?? now.getTime();
    const endDate = getEligibleEndDate(now);

    const effectiveGuardStart = options?.guardStartDate ?? this.guardStartDate;
    const lookback = options?.lookbackDays ?? this.lookbackDays;
    let startDate = options?.startDate ?? addDays(endDate, -lookback);
    if (startDate < effectiveGuardStart) {
      startDate = effectiveGuardStart;
    }

    const missingDates: string[] = [];
    let current = startDate;

    while (current <= endDate) {
      if (!isWeekend(current)) {
        const holiday = await this.isHoliday(current);
        if (!holiday) {
          const hasBars = await this.hasBarsForDate(current);
          const hasEval = await this.hasEvaluationForDate(current);

          if (!hasBars || !hasEval) {
            // Check retry cap and backoff for this date (resets on new IST day)
            const attemptState = this.getOrResetAttemptState(current, nowMs);
            if (attemptState) {
              if (attemptState.attempts >= this.maxAttemptsPerDate) {
                if (!attemptState.exhausted) {
                  attemptState.exhausted = true;
                  this.logger.error("Attempt cap reached for missed date; stopping retries", {
                    date: current,
                    attempts: attemptState.attempts,
                    maxAttempts: this.maxAttemptsPerDate,
                  });
                }
                current = addDays(current, 1);
                continue;
              }

              if (nowMs - attemptState.lastAttemptMs < this.backoffMs) {
                // In backoff cooldown; do not retry on this check
                current = addDays(current, 1);
                continue;
              }
            }

            missingDates.push(current);
          }
        }
      }
      current = addDays(current, 1);
    }

    return missingDates;
  }

  /**
   * Runs catch-up:
   * 1. Runs equity:collect:eod ONCE to fetch all recent bars up to the latest closed session.
   * 2. For each missing date:
   *    - Checks if price bars exist for the date.
   *    - If price bars are MISSING: increments attempt count, applies backoff, and does NOT mark as evaluated.
   *    - If price bars ARE present: runs equity:alerts:eval --date <date> and records completion.
   */
  async runCatchup(missingDates: string[], nowMs = Date.now()): Promise<EquityCatchupResult> {
    if (missingDates.length === 0) {
      return {
        missingDates: [],
        collected: false,
        evaluatedDates: [],
      };
    }

    // 1. Run collection ONCE
    try {
      await this.commandRunner("npm", ["run", "equity:collect:eod"]);
    } catch (err: unknown) {
      this.logger.error("Failed to run equity:collect:eod during catchup", {
        error: err instanceof Error ? err.message : String(err),
      });
      const currentIstDay = getIstDayString(nowMs);
      for (const date of missingDates) {
        const curr = this.getOrResetAttemptState(date, nowMs) ?? {
          attempts: 0,
          lastAttemptMs: 0,
          lastAttemptIstDay: currentIstDay,
        };
        curr.attempts += 1;
        curr.lastAttemptMs = nowMs;
        curr.lastAttemptIstDay = currentIstDay;
        this.dateAttempts.set(date, curr);
      }
      return {
        missingDates,
        collected: false,
        evaluatedDates: [],
      };
    }

    // 2. Evaluate each missing day, oldest first
    const evaluatedDates: string[] = [];
    const currentIstDay = getIstDayString(nowMs);

    for (const date of missingDates) {
      const state = this.getOrResetAttemptState(date, nowMs) ?? {
        attempts: 0,
        lastAttemptMs: 0,
        lastAttemptIstDay: currentIstDay,
      };

      // Gate: Verify price bars exist before evaluating or recording complete
      const barsExist = await this.hasBarsForDate(date);
      if (!barsExist) {
        state.attempts += 1;
        state.lastAttemptMs = nowMs;
        state.lastAttemptIstDay = currentIstDay;
        this.dateAttempts.set(date, state);
        this.logger.warn("Price bars not found for date after collection; retrying later", {
          date,
          attempt: state.attempts,
          maxAttempts: this.maxAttemptsPerDate,
        });
        continue;
      }

      // Price bars exist: evaluate alerts for this specific date
      try {
        await this.commandRunner("npm", ["run", "equity:alerts:eval", "--", "--date", date]);
        await this.recordEvaluationCompleted(date);
        this.dateAttempts.delete(date); // Succeeded: clear attempt tracker
        evaluatedDates.push(date);
      } catch (err: unknown) {
        state.attempts += 1;
        state.lastAttemptMs = nowMs;
        state.lastAttemptIstDay = currentIstDay;
        this.dateAttempts.set(date, state);
        this.logger.error("Failed to evaluate equity alerts for date", {
          date,
          attempt: state.attempts,
          maxAttempts: this.maxAttemptsPerDate,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      missingDates,
      collected: true,
      evaluatedDates,
    };
  }

  /**
   * Combined check and catchup.
   */
  async checkAndCatchup(asOfDate?: Date, nowMs?: number): Promise<EquityCatchupResult> {
    const missingDates = await this.findMissingDates({ asOfDate, nowMs });
    return this.runCatchup(missingDates, nowMs);
  }
}
