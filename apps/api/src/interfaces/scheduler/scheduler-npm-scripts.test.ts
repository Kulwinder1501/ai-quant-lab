import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards every `npm run <script>` the schedulers spawn against the **root** package.json.
 *
 * This exists because of a job that failed all 38 of its runs without anyone noticing.
 * `COLLECTOR_HEALTH` invoked `ops:collector-health`, which was defined only in
 * `apps/api/package.json`. The schedulers spawn from `REPO_ROOT` (see the `cwd` passed in
 * `scheduler.ts`), so npm resolved the name against the root manifest, found nothing, and
 * every run died with `Missing script: "ops:collector-health"`. The job whose entire purpose
 * is to notice a silent collector was itself silently dead from its first run.
 *
 * The failure mode is that the two halves live in different files: adding a workspace script
 * is not enough, and nothing at build or type-check time connects the two. Only the child
 * process's exit code says so, at 09:03 on a weekday, in a container log.
 *
 * The source is read as text rather than imported, for the same reason
 * `scalp-research-schedule.test.ts` does it: importing a scheduler module starts its real cron
 * jobs. Paths resolve from `import.meta.url` rather than the process cwd, because this suite
 * runs from more than one directory.
 */
const SCHEDULER_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** Mirrors `REPO_ROOT` in scheduler.ts: five levels up from `src/interfaces/scheduler`. */
const REPO_ROOT = join(SCHEDULER_DIRECTORY, "..", "..", "..", "..", "..");

/**
 * Every source file that spawns `npm run` with the repo root as its cwd.
 *
 * `run-eod-pipeline.ts` is included even though it is a CLI rather than a scheduler: it is
 * spawned *by* the EOD_PIPELINE job, resolves its own `REPO_ROOT` the same way, and fails in
 * exactly the same silent manner. The bug is a class, not one job.
 */
const SPAWNING_SOURCES = [
  join(SCHEDULER_DIRECTORY, "scheduler.ts"),
  join(SCHEDULER_DIRECTORY, "scalp-research-scheduler.ts"),
  join(SCHEDULER_DIRECTORY, "..", "cli", "run-eod-pipeline.ts"),
];

const rootScripts: Record<string, string> = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
).scripts;

/**
 * The script names a file asks npm to run.
 *
 * Matched on the `"run", "<name>"` argument pair rather than on the `runCommand(...)` call,
 * because several call sites build the argument array into a variable first and pass that
 * — `runCommand("npm", args)` — so anchoring on the call would miss them.
 */
function referencedScripts(source: string): string[] {
  return [...source.matchAll(/"run"\s*,\s*"([^"]+)"/g)].map((match) => match[1]!);
}

describe("scheduler npm scripts", () => {
  const references = SPAWNING_SOURCES.map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));

  it("resolves every scheduled script name in the root package.json", () => {
    const missing: string[] = [];
    for (const { path, source } of references) {
      for (const name of referencedScripts(source)) {
        if (!rootScripts[name]) {
          missing.push(`${name} (spawned by ${path.split(/[\\/]/).pop()})`);
        }
      }
    }
    expect(missing, `scripts missing from the root package.json: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("finds the script names at all, so an empty match cannot pass vacuously", () => {
    // A regex that silently stopped matching would turn the assertion above into a no-op,
    // which is the same class of silence this test exists to end.
    const all = references.flatMap(({ source }) => referencedScripts(source));
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(all).toContain("ops:collector-health");
    expect(all).toContain("pipeline:eod");
  });

  it("passes no script name that the text scan cannot see", () => {
    /*
     * The scan only reads string literals. A name built at runtime — `"run", scriptName` or a
     * template literal — would be invisible to it and could reach production unresolved, so
     * require that every `"run",` argument is followed by a literal.
     */
    for (const { path, source } of references) {
      const runArguments = [...source.matchAll(/"run"\s*,\s*([^\s,\]]+)/g)];
      for (const match of runArguments) {
        expect(
          match[1]!.startsWith('"'),
          `${path}: non-literal script name ${match[1]} — add it to the root package.json ` +
          "and give this test a literal it can check",
        ).toBe(true);
      }
    }
  });

  it("forwards arguments for the scripts that take them", () => {
    // The workspace passthrough needs a trailing `--` or npm swallows the job's own flags.
    // Verified against production rather than assumed: INSTITUTIONAL_FLOWS is spawned with no
    // arguments against a root script that ends in `--`, and it has completed runs.
    for (const name of ["data:collect:historical", "ops:collector-health"]) {
      expect(rootScripts[name], `root script ${name}`).toMatch(/--$/);
    }
  });
});
