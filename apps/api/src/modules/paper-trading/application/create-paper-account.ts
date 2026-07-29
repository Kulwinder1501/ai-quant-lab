import type { PaperAccount, PaperAccountRepository } from "../domain/paper-trading.js";

export interface CreatePaperAccountInput {
  name: string;
  openingBalance: number;
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
}

/** Creates an INR-only local simulation account; no funds are moved anywhere. */
export class CreatePaperAccount {
  constructor(private readonly accountRepository: PaperAccountRepository) {}

  async execute(input: CreatePaperAccountInput): Promise<PaperAccount> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Paper account name is required.");
    }
    assertPositiveFinite(input.openingBalance, "Opening balance");
    return this.accountRepository.create({ name, openingBalance: input.openingBalance });
  }
}
