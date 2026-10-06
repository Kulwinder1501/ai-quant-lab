import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchedulerLogSink } from "./scheduler-log-sink.js";

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "scheduler-log-")), name);
}

describe("createSchedulerLogSink", () => {
  it("does nothing when no path is configured, so the sink is opt-in", () => {
    const sink = createSchedulerLogSink(undefined);
    expect(() => sink.write("line")).not.toThrow();
    expect(createSchedulerLogSink("   ").write("line")).toBeUndefined();
  });

  it("appends one line per write and creates missing directories", () => {
    const path = join(tempPath("x"), "nested", "scheduler.log");
    const sink = createSchedulerLogSink(path);

    sink.write(JSON.stringify({ message: "Scheduled job skipped", jobType: "OPTION_CHAIN" }));
    sink.write(JSON.stringify({ message: "Scheduled job completed", jobType: "OPTION_CHAIN" }));

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ jobType: "OPTION_CHAIN", message: "Scheduled job skipped" });
  });

  it("rotates one generation before exceeding the cap", () => {
    const path = tempPath("scheduler.log");
    writeFileSync(path, "x".repeat(90));
    const sink = createSchedulerLogSink(path, { maximumBytes: 100 });

    sink.write("y".repeat(50));

    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(90));
    expect(readFileSync(path, "utf8")).toBe(`${"y".repeat(50)}\n`);
  });

  it("warns once and then stays quiet when the path is unwritable", () => {
    const onError = vi.fn();
    // A directory where a file is expected: every write fails for the same reason forever.
    const directory = mkdtempSync(join(tmpdir(), "scheduler-log-dir-"));
    const sink = createSchedulerLogSink(directory, { onError });

    sink.write("first");
    sink.write("second");
    sink.write("third");

    // Diagnostic plumbing must not become the outage, and must not flood the log it replaced.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps the process alive when the sink cannot be created at all", () => {
    const onError = vi.fn();
    const sink = createSchedulerLogSink("\0invalid", { onError });
    expect(() => sink.write("line")).not.toThrow();
    expect(existsSync("\0invalid")).toBe(false);
  });
});
