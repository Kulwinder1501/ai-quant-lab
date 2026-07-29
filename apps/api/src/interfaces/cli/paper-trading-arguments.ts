import type { PaperAccount, PaperAccountRepository } from "../../modules/paper-trading/domain/paper-trading.js";
import { getOption, requireOption } from "./arguments.js";

export function parsePositiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${option} must be a positive number.`);
  }
  return parsed;
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
