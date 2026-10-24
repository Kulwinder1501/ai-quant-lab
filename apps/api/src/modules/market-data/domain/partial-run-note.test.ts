import { describe, expect, it } from "vitest";
import { baseUnderlying, parsePartialNote, partialFailureNote, partialRunLine } from "./partial-run-note.js";

const nifty = { underlyingSymbol: "NIFTY50", reason: "Fyers option chain request failed (HTTP 429)" };

describe("partialRunLine", () => {
  it("is printed when something was stored and something failed", () => {
    const line = partialRunLine({ chains: [{}], failures: [nifty] });
    expect(JSON.parse(line!)).toEqual({ level: "warn", message: "Option-chain collection partial", failures: [nifty] });
  });

  it("is not printed when nothing failed, or when nothing at all was stored (that run fails on its own exit code)", () => {
    expect(partialRunLine({ chains: [{}], failures: [] })).toBeNull();
    expect(partialRunLine({ chains: [], failures: [nifty] })).toBeNull();
  });

  it("bounds the note: at most 10 failures and 200 characters of each reason", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ underlyingSymbol: `U${i}`, reason: "x".repeat(500) }));
    const failures = JSON.parse(partialRunLine({ chains: [{}], failures: many })!).failures as Array<{ reason: string }>;
    expect(failures).toHaveLength(10);
    expect(failures[0]!.reason).toBe(`${"x".repeat(200)}…`);
  });
});

describe("partialFailureNote", () => {
  const complete = JSON.stringify({ level: "info", message: "Option-chain collection complete", chains: [{ underlyingSymbol: "BANKNIFTY" }], failures: [nifty] });

  it("finds the partial line at the end of the collector's output and keeps it as a PARTIAL note", () => {
    const stdout = `${complete}\n${partialRunLine({ chains: [{}], failures: [nifty] })}\n`;
    const note = partialFailureNote(stdout)!;
    expect(note.startsWith("PARTIAL ")).toBe(true);
    expect(parsePartialNote(note)).toEqual([nifty]);
  });

  it("is null for a clean run, and for output with no partial line", () => {
    expect(partialFailureNote(`${JSON.stringify({ level: "info", message: "Option-chain collection complete", failures: [] })}\n`)).toBeNull();
    expect(partialFailureNote("")).toBeNull();
  });

  it("ignores a partial line cut off by the capture's tail and still reads an earlier intact one", () => {
    const intact = partialRunLine({ chains: [{}], failures: [nifty] })!;
    const cut = intact.slice(0, 40);
    expect(parsePartialNote(partialFailureNote(`${intact}\nnpm warn something\n${cut}`))).toEqual([nifty]);
    expect(partialFailureNote(cut)).toBeNull();
  });

  it("is not fooled by an ordinary line that merely mentions the phrase", () => {
    expect(partialFailureNote("note: Option-chain collection partial is a message\n")).toBeNull();
  });
});

describe("parsePartialNote and baseUnderlying", () => {
  it("returns null for a failure text, a missing note, or a damaged note", () => {
    expect(parsePartialNote(null)).toBeNull();
    expect(parsePartialNote("npm run data:collect:option-chain exited with code 1")).toBeNull();
    expect(parsePartialNote("PARTIAL {not json")).toBeNull();
    expect(parsePartialNote('PARTIAL {"failures":"nope"}')).toBeNull();
  });

  it("takes a tradable-expiry failure as the same underlying's", () => {
    expect(baseUnderlying("NIFTY50 (tradable expiry 2026-10-27)")).toBe("NIFTY50");
    expect(baseUnderlying("BANKNIFTY")).toBe("BANKNIFTY");
  });
});
