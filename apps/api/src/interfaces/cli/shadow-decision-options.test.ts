import { describe, expect, it } from "vitest";
import { producerChoice } from "./shadow-decision-options.js";

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
  it("defaults to native when absent, so a pass never silently changes rule", () => {
    expect(producerChoice([])).toBe("native");
    expect(producerChoice(["--max-bar-age-seconds=90000"])).toBe("native");
  });

  it("accepts both flag spellings", () => {
    // `--flag=value` and `--flag value` are both in use across these CLIs.
    expect(producerChoice(["--producer=ported-v1"])).toBe("ported-v1");
    expect(producerChoice(["--producer", "ported-v1"])).toBe("ported-v1");
  });

  it("accepts an explicit native", () => {
    expect(producerChoice(["--producer=native"])).toBe("native");
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
    // `--producer=` from a shell variable that did not expand. Defaulting is the safe reading: it runs
    // the producer that claims nothing.
    expect(producerChoice(["--producer="])).toBe("native");
  });
});
