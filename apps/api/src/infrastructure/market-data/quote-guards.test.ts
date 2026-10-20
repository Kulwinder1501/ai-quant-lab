import { describe, expect, it } from "vitest";
import { isQuoteSessionOpen } from "../../modules/market-data/domain/quote-session.js";
import { QuoteSessionClock, UiQuoteBudget } from "./quote-guards.js";

const NO_HOLIDAYS = new Set<string>();
const at = (iso: string) => new Date(iso);

describe("isQuoteSessionOpen", () => {
  it("is open from 09:00 to 15:35 IST on a trading weekday", () => {
    expect(isQuoteSessionOpen(at("2026-10-21T03:30:00Z"), NO_HOLIDAYS)).toBe(true); // 09:00 IST Wednesday
    expect(isQuoteSessionOpen(at("2026-10-21T09:00:00Z"), NO_HOLIDAYS)).toBe(true); // 14:30 IST
    expect(isQuoteSessionOpen(at("2026-10-21T10:04:00Z"), NO_HOLIDAYS)).toBe(true); // 15:34 IST
  });

  it("is closed before 09:00 and from 15:35", () => {
    expect(isQuoteSessionOpen(at("2026-10-21T03:29:00Z"), NO_HOLIDAYS)).toBe(false); // 08:59 IST
    expect(isQuoteSessionOpen(at("2026-10-21T10:05:00Z"), NO_HOLIDAYS)).toBe(false); // 15:35 IST
    expect(isQuoteSessionOpen(at("2026-10-20T20:00:00Z"), NO_HOLIDAYS)).toBe(false); // 01:30 IST, the overnight case
  });

  it("is closed at the weekend", () => {
    expect(isQuoteSessionOpen(at("2026-10-24T06:00:00Z"), NO_HOLIDAYS)).toBe(false); // Saturday 11:30 IST
    expect(isQuoteSessionOpen(at("2026-10-25T06:00:00Z"), NO_HOLIDAYS)).toBe(false); // Sunday
  });

  it("is closed on an NSE holiday, by the IST date, not the UTC one", () => {
    const dussehra = new Set(["2026-10-20"]);
    expect(isQuoteSessionOpen(at("2026-10-20T06:00:00Z"), dussehra)).toBe(false); // 11:30 IST on the holiday
    expect(isQuoteSessionOpen(at("2026-10-21T03:30:00Z"), dussehra)).toBe(true); // the next day is open
  });
});

describe("QuoteSessionClock", () => {
  it("uses the holiday list once it has loaded, and refreshes it on a schedule", async () => {
    let now = Date.parse("2026-10-20T06:00:00Z"); // 11:30 IST on a Tuesday
    let loads = 0;
    const clock = new QuoteSessionClock(async () => { loads += 1; return ["2026-10-20"]; }, () => now, 30 * 60_000);

    expect(clock.isOpen()).toBe(true); // before the list arrives it assumes no holidays
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clock.isOpen()).toBe(false);
    expect(loads).toBe(1);

    now += 31 * 60_000;
    clock.isOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toBe(2);
  });

  it("keeps the last list and retries soon when a load fails", async () => {
    let now = Date.parse("2026-10-21T06:00:00Z");
    let attempts = 0;
    const clock = new QuoteSessionClock(async () => { attempts += 1; throw new Error("db down"); }, () => now);

    clock.isOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    now += 61_000;
    clock.isOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(2);
    expect(clock.isOpen()).toBe(true);
  });
});

describe("UiQuoteBudget", () => {
  it("allows requests until the ledger count reaches the cap, and reads the ledger at most once per cache window", async () => {
    let now = 0;
    let reads = 0;
    let count = 2_499;
    const budget = new UiQuoteBudget(async () => { reads += 1; return count; }, 2_500, () => now, 30_000);

    expect(budget.allow()).toBe(true); // nothing read yet
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(budget.allow()).toBe(true);
    expect(reads).toBe(1);

    count = 2_500;
    now += 31_000;
    budget.allow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(budget.allow()).toBe(false);
    expect(reads).toBe(2);
  });

  it("allows requests when the ledger cannot be read, so a database blip does not blank the screens", async () => {
    const budget = new UiQuoteBudget(async () => { throw new Error("db down"); }, 2_500, () => 0, 30_000);
    budget.allow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(budget.allow()).toBe(true);
  });
});
