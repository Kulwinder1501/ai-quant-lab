import { spawn } from "node:child_process";

/**
 * Runs a scheduled job's child process and keeps enough of its output to explain a failure.
 *
 * The previous version used `stdio: "inherit"`, so the child wrote straight to the
 * scheduler's own streams and nothing was captured. A failed run therefore recorded only
 * `npm run data:collect:option-chain -- ... exited with code 1` in
 * `scheduled_job_runs.error_details`. Three OPTION_CHAIN runs failed on 2026-08-05 and the
 * reason is now unrecoverable — and because that series is forward-accumulating with no
 * backfill, each lost interval is permanently lost, so "why" is the only useful thing left.
 *
 * Output is still forwarded to the scheduler's streams, so live container logs are unchanged.
 */
const MAX_CAPTURED_CHARS = 4_000;

/** Keeps the newest `limit` characters. The tail is where the error is; the head is setup. */
export function appendTail(existing: string, chunk: string, limit = MAX_CAPTURED_CHARS): string {
  const combined = existing + chunk;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

/**
 * The message stored against a failed run.
 *
 * stderr is preferred, but stdout is a real fallback rather than a courtesy: this project's
 * CLIs report failures as JSON on stdout via `console.info`, so a stderr-only capture would
 * have recorded nothing for exactly the jobs most likely to fail.
 */
export function describeExitFailure(input: {
  command: string;
  args: readonly string[];
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
}): string {
  const invocation = `${input.command} ${input.args.join(" ")}`;
  const ending = input.signal
    ? `was killed by ${input.signal}`
    : `exited with code ${input.code}`;
  const captured = input.stderrTail.trim() || input.stdoutTail.trim();
  if (!captured) {
    return `${invocation} ${ending}, and produced no output to explain it.`;
  }
  const stream = input.stderrTail.trim() ? "stderr" : "stdout";
  return `${invocation} ${ending}. Last ${stream} output:\n${captured}`;
}

export interface RunCommandOptions {
  cwd: string;
  /** Injectable so tests do not have to assert on the scheduler's real streams. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      // Piped rather than inherited so the output can be both forwarded and kept.
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      cwd: options.cwd,
    });

    let stdoutTail = "";
    let stderrTail = "";
    const forwardStdout = options.onStdout ?? ((chunk: string) => process.stdout.write(chunk));
    const forwardStderr = options.onStderr ?? ((chunk: string) => process.stderr.write(chunk));

    child.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      forwardStdout(chunk);
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      forwardStderr(chunk);
      stderrTail = appendTail(stderrTail, chunk);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A non-zero exit is a failed run, not a completed one. An earlier version listened
      // only for "error", so a job that started and then exited 1 looked like a success.
      // `close` rather than `exit`, so the stdio streams have flushed and the captured tail
      // is complete when the message is built.
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(describeExitFailure({
        command, args, code, signal, stdoutTail, stderrTail,
      })));
    });
  });
}
