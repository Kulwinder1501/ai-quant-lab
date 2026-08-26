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
 * npm's own wrapper output, which is never the explanation for anything.
 *
 * Every failing `npm run` writes a fixed block to stderr — `npm error Lifecycle script ...
 * failed with error:`, the exit code, the workspace path, the expanded command — plus the
 * occasional `npm notice` upgrade nag. None of it says why the child failed; it only restates
 * the invocation, which the message already carries.
 *
 * The child's own stderr is forwarded through npm unprefixed, so dropping these lines leaves
 * exactly what the child said. A child that itself shells out to npm could in principle emit a
 * line matching this, which would be discarded; that is a better trade than masking every
 * refusal this project's CLIs report.
 */
const NPM_WRAPPER_LINE = /^\s*npm (?:error|notice|warn|WARN|ERR!)\b/;

function withoutNpmWrapper(stream: string): string {
  return stream
    .split("\n")
    .filter((line) => !NPM_WRAPPER_LINE.test(line))
    .join("\n")
    .trim();
}

/**
 * The message stored against a failed run.
 *
 * stderr is preferred, but stdout is a real fallback rather than a courtesy: this project's
 * CLIs report failures as JSON on stdout via `console.info`, so a stderr-only capture would
 * have recorded nothing for exactly the jobs most likely to fail.
 *
 * That fallback was unreachable for the whole of its existence. Jobs are spawned as `npm run
 * <script>`, and npm's wrapper block above lands on stderr on *every* failure, so
 * `stderrTail` was never empty and the stdout branch never ran. What got stored was npm
 * restating the command it had just run.
 *
 * Measured on 2026-08-26: OPTION_PREMIUM_TICKS failed all fifteen runs between 09:27 and
 * 09:41 refusing with `NO_FRESH_ATM_CONTRACTS` — the one word that identifies the cause — and
 * not one of those rows recorded it. Diagnosis took a separate pass over
 * `option_chain_snapshots` to recover what the process had already written down and thrown
 * away. So the wrapper is stripped first, and only what the child actually said is ranked.
 *
 * Wrapper text is still stored when it is genuinely all there is: it names the failing script
 * and beats "produced no output", which would read as though nothing had been looked for.
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

  const childStderr = withoutNpmWrapper(input.stderrTail);
  const stdout = input.stdoutTail.trim();
  const wrapperOnly = input.stderrTail.trim();

  const selected = childStderr
    ? { stream: "stderr", captured: childStderr }
    : stdout
      ? { stream: "stdout", captured: stdout }
      : wrapperOnly
        ? { stream: "stderr", captured: wrapperOnly }
        : null;

  if (!selected) {
    return `${invocation} ${ending}, and produced no output to explain it.`;
  }
  return `${invocation} ${ending}. Last ${selected.stream} output:\n${selected.captured}`;
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
