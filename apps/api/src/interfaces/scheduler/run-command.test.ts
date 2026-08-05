import { describe, expect, it } from "vitest";
import { appendTail, describeExitFailure, runCommand } from "./run-command.js";

describe("appendTail", () => {
  it("keeps the newest characters, because the error is at the end", () => {
    expect(appendTail("abc", "de", 10)).toBe("abcde");
    expect(appendTail("abcdefgh", "ij", 5)).toBe("fghij");
  });

  it("bounds the buffer so a runaway log cannot grow without limit", () => {
    let buffer = "";
    for (let index = 0; index < 500; index += 1) {
      buffer = appendTail(buffer, "0123456789", 100);
    }
    expect(buffer.length).toBe(100);
  });
});

describe("describeExitFailure", () => {
  const base = { command: "npm", args: ["run", "data:collect:option-chain"], code: 1 };

  it("prefers stderr", () => {
    const message = describeExitFailure({
      ...base, stdoutTail: "progress", stderrTail: "FyersError 429 rate limited",
    });

    expect(message).toContain("exited with code 1");
    expect(message).toContain("Last stderr output:");
    expect(message).toContain("FyersError 429 rate limited");
  });

  it("falls back to stdout, because this project's CLIs report failures there", () => {
    // The collectors log JSON through console.info. A stderr-only capture would have stored
    // nothing for exactly the jobs most likely to fail.
    const message = describeExitFailure({
      ...base, stdoutTail: '{"level":"error","message":"Option-chain collection failed"}', stderrTail: "",
    });

    expect(message).toContain("Last stdout output:");
    expect(message).toContain("Option-chain collection failed");
  });

  it("says so plainly when there was no output at all", () => {
    // Better than an empty tail, which reads as though nothing was looked for.
    const message = describeExitFailure({ ...base, stdoutTail: "", stderrTail: "" });

    expect(message).toContain("produced no output to explain it");
  });

  it("reports a signal rather than a null exit code", () => {
    const message = describeExitFailure({
      ...base, code: null, signal: "SIGKILL", stdoutTail: "", stderrTail: "",
    });

    expect(message).toContain("was killed by SIGKILL");
    expect(message).not.toContain("exited with code null");
  });
});

describe("runCommand", () => {
  const cwd = process.cwd();

  it("resolves on a successful command and forwards its output", async () => {
    const stdout: string[] = [];
    await runCommand(process.execPath, ['-e', '"console.log(\'collected\')"'], {
      cwd, onStdout: (chunk) => stdout.push(chunk), onStderr: () => undefined,
    });

    expect(stdout.join("")).toContain("collected");
  });

  it("rejects with the child's stderr, which is the whole point of piping", async () => {
    // The behaviour this replaces recorded only "exited with code 1", leaving three real
    // OPTION_CHAIN failures permanently undiagnosable.
    await expect(runCommand(
      process.execPath,
      ['-e', '"console.error(\'FyersError: token expired\'); process.exit(1)"'],
      { cwd, onStdout: () => undefined, onStderr: () => undefined },
    )).rejects.toThrow(/FyersError: token expired/);
  });

  it("rejects with stdout when the child failed while logging there", async () => {
    await expect(runCommand(
      process.execPath,
      ['-e', '"console.log(\'level=error collection failed\'); process.exit(2)"'],
      { cwd, onStdout: () => undefined, onStderr: () => undefined },
    )).rejects.toThrow(/collection failed/);
  });

  it("reports the exit code alongside the output", async () => {
    await expect(runCommand(
      process.execPath, ['-e', '"process.exit(3)"'],
      { cwd, onStdout: () => undefined, onStderr: () => undefined },
    )).rejects.toThrow(/exited with code 3/);
  });
});
