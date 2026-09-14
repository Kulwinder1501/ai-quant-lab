import type { PaperAccount, PaperAccountRepository } from "../../modules/paper-trading/domain/paper-trading.js";
import { getOption, requireOption } from "./arguments.js";

export function parsePositiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${option} must be a positive number.`);
  }
  return parsed;
}

/**
 * A non-negative number that stays `undefined` when the flag is absent.
 *
 * `parseNonNegativeNumber` coerces a missing flag to 0, which is right for a value whose default
 * genuinely is zero -- slippage -- and wrong for one the callee would otherwise compute. Exit fees
 * are computed: `EvaluateOpenPaperTrades` does `explicitExitFees ?? calculateExitFees(...)`, and
 * `??` only falls through on null/undefined, so an explicit 0 is a *supplied* value that suppresses
 * the calculation entirely.
 *
 * That is not hypothetical. The scheduler runs `paper:trades:evaluate` every minute per account
 * with no `--exit-fees`, so 56 of 383 closes -- every one this job won the race to close -- booked
 * zero exit fees and reported a P&L better than the trade earned. Whether a position paid brokerage
 * depended on which process closed it first.
 */
export function parseOptionalNonNegativeNumber(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  return parseNonNegativeNumber(value, option);
}

export function parseNonNegativeNumber(value: string | undefined, option: string): number {
  const parsed = Number(value ?? "0");
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${option} must be a non-negative number.`);
  }
  return parsed;
}

export function parseOptionalTimestamp(argumentsList: string[], option: string, fallback: Date): Date {
  const value = getOption(argumentsList, option);
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--${option} must be an ISO-8601 timestamp.`);
  }
  return parsed;
}

export async function requirePaperAccount(
  repository: PaperAccountRepository,
  argumentsList: string[],
): Promise<PaperAccount> {
  const name = requireOption(argumentsList, "account");
  const account = await repository.findByName(name);
  if (!account) {
    throw new Error(`Paper account "${name}" was not found.`);
  }
  return account;
}
