import { execFileSync } from "node:child_process";

/**
 * What produced a research artifact, beyond the policy it declared.
 *
 * A frozen manifest hashes the *declared* policy — thresholds, horizons, scenarios. It deliberately
 * does not hash the implementation, so two runs can carry an identical manifest hash and still have
 * executed different code. That is the gap this closes: for a frozen experiment the reproducibility
 * claim is "same policy **and** same code", and only half of it was recorded.
 *
 * `codeDirty` matters as much as the commit. A run from a dirty tree is not reproducible from its
 * SHA, and every result in this repository so far was produced that way — recording it makes that
 * visible instead of implying a clean checkout.
 */
export interface RunProvenance {
  readonly codeVersion: string | null;
  readonly codeDirty: boolean | null;
  readonly runnerNodeVersion: string;
  readonly capturedAt: string;
  /** Populated when git could not be consulted, so a null SHA is never mistaken for a clean run. */
  readonly unavailableReason: string | null;
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Reads code provenance, never throwing.
 *
 * A research run must not fail because the artifact could not be labelled — the measurement is the
 * valuable part. But an unreadable SHA is recorded as an explicit `unavailableReason` rather than
 * silently omitted, because "no git" and "clean at abc123" must not look the same to a reader.
 */
export function captureRunProvenance(now: Date = new Date()): RunProvenance {
  const base = {
    runnerNodeVersion: process.version,
    capturedAt: now.toISOString(),
  };
  try {
    const codeVersion = git(["rev-parse", "HEAD"]);
    // `--porcelain` lists tracked modifications; any output at all means the tree is dirty.
    const codeDirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
    return { ...base, codeVersion, codeDirty, unavailableReason: null };
  } catch (error) {
    return {
      ...base,
      codeVersion: null,
      codeDirty: null,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * One line summarising provenance for a console header.
 *
 * States dirtiness in words rather than a flag, because "dirty" is the condition that invalidates
 * the reproducibility claim and it should not need decoding.
 */
export function describeRunProvenance(provenance: RunProvenance): string {
  if (provenance.codeVersion === null) {
    return `code provenance unavailable (${provenance.unavailableReason ?? "unknown"})`;
  }
  return `${provenance.codeVersion.slice(0, 12)}${provenance.codeDirty ? " (DIRTY — not reproducible from this SHA)" : " (clean)"}`;
}
