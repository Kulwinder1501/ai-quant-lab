import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";

/**
 * Guards the research scheduler's cron expressions and the CLI names it spawns.
 *
 * Both fail in the same silent way: `node-cron` accepts a schedule it will never fire, and a misspelled
 * CLI name only surfaces when the child process exits non-zero at 07:00 on a Saturday. The source is read
 * as text rather than imported because importing would start the real cron jobs.
 */
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "scalp-research-scheduler.ts"),
  "utf8",
);

const expressions = [...source.matchAll(/"((?:[0-9*,\-/]+\s){4,5}[0-9*,\-/]+)"/g)].map((match) => match[1]!);

describe("scalp research schedule", () => {
  it("uses only cron expressions node-cron will actually fire", () => {
    expect(expressions.length).toBeGreaterThanOrEqual(5);
    for (const expression of expressions) {
      expect(cron.validate(expression), `invalid cron: ${expression}`).toBe(true);
    }
  });

  it("runs the weekly path study on Saturday morning IST", () => {
    // Saturday, after Friday's 15:31 drain and the overnight candle heal, so the week's data is final.
    // A weekday slot would only re-examine an unchanged dataset.
    expect(expressions).toContain("0 0 7 * * 6");
    expect(source).toContain('timezone: IST');
  });

  it("spawns the study CLIs by their real names", () => {
    // `run()` resolves these against ../cli/<name>.js at spawn time, so a typo is invisible until the
    // job fires and the child exits non-zero.
    for (const name of ["register-research-studies", "run-path-study"]) {
      expect(source).toContain(`run("${name}"`);
    }
  });

  it("runs the authoritative study version, not the superseded one", () => {
    /*
     * V1's pointwise verdict is superseded, and scheduling it would emit a weekly stream of readings
     * already shown to overfire. It also doubles the number of looks at a growing dataset, which is
     * itself a form of multiple testing.
     */
    expect(source).toContain('"--study", "PATH_STUDY_V2"');
    expect(source).not.toContain('"--study", "PATH_STUDY_V1"');
  });

  it("guards the weekly job against overlapping itself", () => {
    // A path study over many sessions is not instant, and two concurrent runs would race on the same
    // trial declarations.
    expect(source).toContain("studyRunning");
  });
});
