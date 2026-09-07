import type { DatabaseQueryable } from "../database.js";
import { describe, expect, it, vi } from "vitest";
import { PostgresOpenPositionContractRepository } from "./postgres-open-position-contract-repository.js";

function repositoryReturning(rows: unknown[]) {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows }));
  return {
    query,
    repository: new PostgresOpenPositionContractRepository({ query } as unknown as DatabaseQueryable),
  };
}

describe("PostgresOpenPositionContractRepository", () => {
  it("returns each open option position as a contract the streamer can subscribe to", async () => {
    const { repository } = repositoryReturning([
      {
        underlying_symbol: "BANKNIFTY",
        expiry_date: new Date("2026-08-25T10:00:00.000Z"),
        strike_price: "57300.0000",
        option_type: "PE",
        provider_symbol: "NSE:BANKNIFTY26AUG57300PE",
      },
      {
        underlying_symbol: "NIFTY50",
        expiry_date: "2026-08-27T10:00:00.000Z",
        strike_price: 24500,
        option_type: "CE",
        provider_symbol: "NSE:NIFTY2682724500CE",
      },
    ]);

    await expect(repository.listForUnderlying("banknifty")).resolves.toEqual([
      {
        underlyingSymbol: "BANKNIFTY",
        expiryDate: "2026-08-25",
        strikePrice: 57300,
        optionType: "PE",
        providerSymbol: "NSE:BANKNIFTY26AUG57300PE",
      },
      {
        underlyingSymbol: "NIFTY50",
        expiryDate: "2026-08-27",
        strikePrice: 24500,
        optionType: "CE",
        providerSymbol: "NSE:NIFTY2682724500CE",
      },
    ]);
  });

  it("asks only for open option positions on the requested underlying", async () => {
    const { query, repository } = repositoryReturning([]);

    await repository.listForUnderlying("NIFTY50");

    const [text, values] = query.mock.calls[0] ?? [];
    expect(text).toContain("trade.status = 'OPEN'");
    expect(text).toContain("trade.option_type IS NOT NULL");
    expect(values).toEqual(["NIFTY50"]);
  });

  it("takes the newest snapshot that carried the contract, not the newest snapshot", async () => {
    // A strike that has drifted out of the ATM band is missing from the current snapshot, and
    // that is exactly the position this exists to keep quoted. Ordering the lateral join by the
    // contract's own observations rather than filtering to one instant is what makes that work.
    const { query, repository } = repositoryReturning([]);

    await repository.listForUnderlying("BANKNIFTY");

    const [text] = query.mock.calls[0] ?? [];
    expect(text).toContain("ORDER BY snapshot.observed_at DESC");
    expect(text).toContain("LIMIT 1");
  });

  it("warns instead of silently dropping a position no snapshot ever carried", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { repository } = repositoryReturning([
      {
        underlying_symbol: "BANKNIFTY",
        expiry_date: "2026-08-25T10:00:00.000Z",
        strike_price: 58000,
        option_type: "CE",
        provider_symbol: null,
      },
      {
        underlying_symbol: "BANKNIFTY",
        expiry_date: "2026-08-25T10:00:00.000Z",
        strike_price: 57300,
        option_type: "PE",
        provider_symbol: "NSE:BANKNIFTY26AUG57300PE",
      },
    ]);

    const contracts = await repository.listForUnderlying("BANKNIFTY");

    // The resolvable one still subscribes; the unresolvable one is reported, not swallowed.
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.strikePrice).toBe(57300);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("58000");
    warn.mockRestore();
  });

  it("returns nothing when no position is open, so the band alone drives the subscription", async () => {
    const { repository } = repositoryReturning([]);
    await expect(repository.listForUnderlying("BANKNIFTY")).resolves.toEqual([]);
  });

  it("refuses an unreadable expiry rather than subscribing to a malformed contract", async () => {
    const { repository } = repositoryReturning([
      {
        underlying_symbol: "BANKNIFTY",
        expiry_date: "not-a-date",
        strike_price: 57300,
        option_type: "PE",
        provider_symbol: "NSE:BANKNIFTY26AUG57300PE",
      },
    ]);

    await expect(repository.listForUnderlying("BANKNIFTY")).rejects.toThrow(/invalid option expiry/i);
  });
});
