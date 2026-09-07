import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Appends scheduler log lines to a file outside the container.
 *
 * Docker's `json-file` logs are stored under the container's own directory and are deleted with
 * it, so `--force-recreate` destroys them -- including the `Scheduled job skipped` lines that are
 * the only record of a skip. On 2026-08-17 OPTION_CHAIN stopped claiming for 45 minutes and the
 * container was recreated before anyone read its log, which made the cause unrecoverable: a skip
 * is deliberately never written to `scheduled_job_runs` (`runExclusively` treats claiming a run
 * that did not happen as a lie), so the log was the whole of the evidence. Rotation would not
 * have helped; it caps size, not lifetime.
 *
 * Best-effort by construction. This is diagnostic plumbing, and a scheduler that refuses to run
 * because it cannot write a log file would be a worse outage than the one it is here to explain,
 * so every failure is swallowed after one warning.
 */
export interface SchedulerLogSink {
  write(line: string): void;
}

/** Small enough to keep a session's worth without unbounded growth on a bind mount. */
const DEFAULT_MAXIMUM_BYTES = 32 * 1024 * 1024;

export function createSchedulerLogSink(
  filePath: string | undefined,
  options: { maximumBytes?: number; onError?: (message: string) => void } = {},
): SchedulerLogSink {
  if (!filePath || filePath.trim() === "") {
    return { write: () => undefined };
  }

  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  let disabled = false;
  const fail = (error: unknown): void => {
    if (disabled) return;
    disabled = true;
    options.onError?.(error instanceof Error ? error.message : String(error));
  };

  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (error) {
    fail(error);
  }

  return {
    write(line: string): void {
      if (disabled) return;
      try {
        // One generation kept, rotated before the write that would exceed the cap. A single
        // `.1` file is enough: this is read after an incident, not archived.
        let size = 0;
        try {
          size = statSync(filePath).size;
        } catch {
          size = 0;
        }
        if (size + line.length + 1 > maximumBytes) {
          renameSync(filePath, `${filePath}.1`);
        }
        appendFileSync(filePath, `${line}\n`);
      } catch (error) {
        fail(error);
      }
    },
  };
}
