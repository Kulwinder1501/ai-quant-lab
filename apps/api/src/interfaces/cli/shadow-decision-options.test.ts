import { describe, expect, it } from "vitest";
import { producerChoice, timeframeMs } from "./shadow-decision-options.js";

/**
 * The producer flag decides which rule V2.2 applies, so a silent parse failure is not cosmetic.
 *
 * Written because the first version was broken in two ways at once and the suite could not see it:
 * `getOption` prepends the dashes itself, so passing `"--producer"` looked for `----producer` and
 * never matched; and the absent case was compared against `null` when the helper returns `undefined`.
 * Together they made *every* run fail with `Unknown --producer "undefined"`, including the default
 * path that passes no flag. It took a live run against production to surface that.
 */
describe("the producer flag", () => {
  it("defaults to running both, because P13 needs both populations", () => {
    /*
     * Native measures what V2.2 decides on its own evidence; ported measures whether the platform
     * reproduces V1's. Defaulting to one leaves the other's population empty -- which is exactly how
     * the ported producer sat unused for a day while the scheduler ran native only.
     */
    expect(producerChoice([])).toBe("both");
    expect(producerChoice(["--max-bar-age-seconds=90000"])).toBe("both");
  });

  it("still allows isolating one producer", () => {
    expect(producerChoice(["--producer=native"])).toBe("native");
    expect(producerChoice(["--producer=ported-v1"])).toBe("ported-v1");
  });

  it("accepts both flag spellings", () => {
    // `--flag=value` and `--flag value` are both in use across these CLIs.
    expect(producerChoice(["--producer=ported-v1"])).toBe("ported-v1");
    expect(producerChoice(["--producer", "ported-v1"])).toBe("ported-v1");
  });

  it("accepts an explicit both", () => {
    expect(producerChoice(["--producer=both"])).toBe("both");
  });

  it("refuses an unrecognised producer instead of falling back", () => {
    /*
     * A typo must not quietly run the other rule. Which producer decided is recorded on every stored
     * decision, and a run mislabelled at the source would put two rules' decisions in one population
     * -- the same defect migration 093 removed two probe rows for.
     */
    expect(() => producerChoice(["--producer=ported"])).toThrow(/Unknown --producer "ported"/);
    expect(() => producerChoice(["--producer=PORTED-V1"])).toThrow();
  });

  it("treats an empty value as absent rather than as an error", () => {
    // `--producer=` from a shell variable that did not expand. Defaulting is the safe reading, and the
    // default records everything rather than silently dropping a producer's population.
    expect(producerChoice(["--producer="])).toBe("both");
  });
});

describe("bar length drives the staleness ceiling", () => {
  it("reads minutes and hours, and refuses anything else", () => {
    // A wrong interval mis-reads the tape, so guessing is worse than failing.
    expect(timeframeMs("1m")).toBe(60_000);
    expect(timeframeMs("5m")).toBe(300_000);
    expect(timeframeMs("1h")).toBe(3_600_000);
    expect(() => timeframeMs("1d")).toThrow(/Unsupported shadow timeframe/);
    expect(() => timeframeMs("")).toThrow();
  });

  it("keeps the old 1m behaviour exactly", () => {
    /*
     * The ceiling used to be a flat three minutes, which was right while the pass only read 1m. One
     * bar plus two minutes' grace reproduces that number, so widening coverage changes nothing about
     * how 1m bars are judged.
     */
    expect(timeframeMs("1m") + 2 * 60_000).toBe(3 * 60_000);
  });

  it("gives a 5m bar room a flat three minutes would not have", () => {
    /*
     * The defect this replaces. A 5m bar is up to five minutes old before its successor exists, so a
     * three-minute ceiling would have refused most 5m bars as stale -- and the wider coverage would
     * have produced nothing while appearing to work.
     */
    const ceiling = timeframeMs("5m") + 2 * 60_000;

    expect(ceiling).toBe(7 * 60_000);
    expect(ceiling).toBeGreaterThan(timeframeMs("5m"));
  });
});
