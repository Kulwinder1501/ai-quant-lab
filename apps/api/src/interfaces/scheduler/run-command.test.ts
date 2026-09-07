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

  /*
   * Verbatim from `scheduled_job_runs.error_details`, OPTION_PREMIUM_TICKS at 09:27 IST on
   * 2026-08-26. This is the whole of what a failing `npm run` puts on stderr: it restates the
   * command and says nothing about why. All fifteen failures that morning stored exactly this.
   */
  const npmWrapperStderr = [
    "npm error Lifecycle script `data:collect:option-premium-ticks` failed with error:",
    "npm error code 1",
    "npm error path /app/apps/api",
    "npm error workspace @ai-quant-lab/api@0.1.0",
    "npm error command failed",
    "npm error command sh -c tsx src/interfaces/cli/collect-option-premium-ticks.ts",
    "npm notice",
    "npm notice New major version of npm available! 10.9.8 -> 12.0.2",
    "npm notice",
  ].join("\n");

  it("does not let npm's wrapper mask the refusal the CLI printed to stdout", () => {
    // The bug this replaces: stderr was never empty under npm, so the stdout branch below was
    // unreachable and the one word identifying the cause was dropped on every run.
    const message = describeExitFailure({
      ...base,
      stdoutTail: '{"level":"error","refusal":"NO_FRESH_ATM_CONTRACTS"}',
      stderrTail: npmWrapperStderr,
    });

    expect(message).toContain("Last stdout output:");
    expect(message).toContain("NO_FRESH_ATM_CONTRACTS");
    expect(message).not.toContain("Lifecycle script");
    expect(message).not.toContain("New major version of npm");
  });

  it("keeps the child's own stderr and drops the wrapper around it", () => {
    // npm forwards the child's stderr unprefixed, so the real line survives the filter while
    // npm's restatement of the command does not.
    const message = describeExitFailure({
      ...base,
      stdoutTail: "",
      stderrTail: `FyersError: token expired\n${npmWrapperStderr}`,
    });

    expect(message).toContain("Last stderr output:");
    expect(message).toContain("FyersError: token expired");
    expect(message).not.toContain("npm error code 1");
  });

  it("still stores the wrapper when it is genuinely all there is", () => {
    // It at least names the failing script, which beats claiming nothing was looked for.
    const message = describeExitFailure({ ...base, stdoutTail: "", stderrTail: npmWrapperStderr });

    expect(message).toContain("data:collect:option-premium-ticks");
    expect(message).not.toContain("produced no output");
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

  /*
   * The token is concatenated by the child rather than written as one literal, so it cannot
   * appear in argv. The failure message embeds the whole invocation — `-e` source included —
   * so asserting on a literal that is also in the command proves nothing about what was
   * captured: the earlier version of these two tests passed against an implementation that
   * discarded stdout entirely.
   */
  const printsOnStdout = (token: string, exitCode: number) =>
    ['-e', `"console.log('${token.slice(0, 4)}' + '${token.slice(4)}'); process.exit(${exitCode})"`];

  it("rejects with stdout when the child failed while logging there", async () => {
    await expect(runCommand(
      process.execPath, printsOnStdout("COLLECTION_FAILED", 2),
      { cwd, onStdout: () => undefined, onStderr: () => undefined },
    )).rejects.toThrow(/COLLECTION_FAILED/);
  });

  it("surfaces stdout end-to-end when the child also wrote npm-shaped noise to stderr", async () => {
    // The whole path, not just the message builder: this is the shape of every scheduled job,
    // which runs under `npm run` and so always has wrapper text competing with the real reason.
    await expect(runCommand(
      process.execPath,
      ['-e', '"console.error(\'npm error code 1\'); console.log(\'NO_FRESH\' + \'_ATM_CONTRACTS\'); process.exit(1)"'],
      { cwd, onStdout: () => undefined, onStderr: () => undefined },
    )).rejects.toThrow(/Last stdout output:[\s\S]*NO_FRESH_ATM_CONTRACTS/);
  });

  it("reports the exit code alongside the output", async () => {
    await expect(runCommand(
      process.execPath, ['-e', '"process.exit(3)"'],
      { cwd, onStdout: () => undefined, onStderr: () => undefined },
    )).rejects.toThrow(/exited with code 3/);
  });
});
