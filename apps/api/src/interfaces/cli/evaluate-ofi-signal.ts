import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresDepthFrameRepository } from "../../infrastructure/database/repositories/postgres-depth-frame-repository.js";
import { summariseSequenceHealth } from "../../modules/market-data/domain/depth-frame-sequencing.js";
import { buildOfiObservations } from "../../modules/research/domain/ofi-signal-observations.js";
import { runFalsificationHarness } from "../../modules/research/domain/falsification-harness.js";

/**
 * Runs the OFI signal through the R0 falsification harness (Phase 28 step 4).
 *
 * ## The gate is enforced here, in code, not merely written down in the protocol
 *
 * Phase 1's pre-registered gate is a full session whose sequence health is `RECONSTRUCTIBLE`. A gate
 * that lives only in a document gets skipped by whoever is in a hurry — most likely the author, on
 * the day the first interesting-looking number appears. So this command **refuses to compute an IC
 * at all** unless the capture it was pointed at passes:
 *
 * - sequence health must be `RECONSTRUCTIBLE`. `DEGRADED` and `FEED_NOT_RECONSTRUCTIBLE` are
 *   refusals, and so is `INSUFFICIENT_SAMPLE`.
 * - the window must span at least `--min-session-minutes` (default 300, roughly a full NSE session).
 * - no foreign rows may sit in the window when a capture session is named.
 *
 * When it refuses it prints exactly what failed and stops. That is a feature: the most likely way
 * this programme produces a false positive is not a subtle statistical error, it is looking at a
 * three-minute midday capture, seeing an IC of 0.08, and deciding the gate was pedantic.
 *
 * Usage:
 *   evaluate-ofi-signal --symbol=NSE:BANKNIFTY26AUGFUT [--session=UUID | --from=ISO --to=ISO]
 *                       [--ofi-window-ms=5000] [--horizons=1000,5000,30000] [--levels=1]
 *                       [--min-session-minutes=300] [--seed=1]
 *                       [--i-am-only-smoke-testing-the-plumbing]
 */

interface Options {
  symbol: string;
  captureSessionId: string | null;
  from: Date | null;
  to: Date | null;
  ofiWindowMs: number;
  horizonsMs: number[];
  levels: number;
  minSessionMinutes: number;
  seed: number;
  /** Prints observation counts and refuses to report any IC. For wiring checks only. */
  plumbingOnly: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
    else if (argument.startsWith("--")) flags.add(argument.slice(2));
  }

  const symbol = (values.get("symbol") ?? "").trim();
  if (symbol === "") throw new Error("--symbol is required.");

  const positive = (key: string, fallback: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be positive.`);
    return parsed;
  };

  const date = (key: string): Date | null => {
    const raw = values.get(key);
    if (raw === undefined) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error(`--${key} must be an ISO timestamp.`);
    return parsed;
  };

  const horizons = (values.get("horizons") ?? "1000,5000,30000")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  if (horizons.length === 0) throw new Error("--horizons must list positive millisecond values.");

  return {
    symbol,
    captureSessionId: values.get("session")?.trim() || null,
    from: date("from"),
    to: date("to"),
    ofiWindowMs: positive("ofi-window-ms", 5_000),
    horizonsMs: horizons,
    levels: Math.floor(positive("levels", 1)),
    minSessionMinutes: positive("min-session-minutes", 300),
    seed: Math.floor(positive("seed", 1)),
    plumbingOnly: flags.has("i-am-only-smoke-testing-the-plumbing"),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);

  try {
    const repository = new PostgresDepthFrameRepository(database);

    const frames = await repository.listFrames({
      providerSymbol: options.symbol,
      captureSessionId: options.captureSessionId ?? undefined,
      from: options.from ?? undefined,
      to: options.to ?? undefined,
    });

    if (frames.length === 0) {
      console.info(JSON.stringify({
        level: "error", message: "No depth frames matched.", symbol: options.symbol,
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    const health = summariseSequenceHealth(frames);
    const firstAt = frames[0]!.receivedAt;
    const lastAt = frames[frames.length - 1]!.receivedAt;
    const spanMinutes = (lastAt.getTime() - firstAt.getTime()) / 60_000;

    const foreignRows = options.captureSessionId
      ? await repository.countForeignRowsInWindow({
        providerSymbol: options.symbol,
        captureSessionId: options.captureSessionId,
        from: firstAt,
        to: lastAt,
      })
      : null;

    // --- The gate. Refusals happen before any IC is computed. -------------------------------
    const refusals: string[] = [];
    if (health.verdict !== "RECONSTRUCTIBLE") {
      refusals.push(
        `Sequence health is ${health.verdict}, not RECONSTRUCTIBLE `
        + `(missedSequenceRate=${health.missedSequenceRate}, comparablePairs=${health.comparablePairs}). `
        + "An OFI series is a cumulative sum; it cannot be trusted over a feed that lost frames.",
      );
    }
    if (spanMinutes < options.minSessionMinutes) {
      refusals.push(
        `The capture spans ${spanMinutes.toFixed(1)} minutes, below the pre-registered `
        + `${options.minSessionMinutes}. A partial-session window says nothing about the open or the `
        + "close, which is exactly when a feed sheds frames and when flow behaves differently.",
      );
    }
    if (foreignRows !== null && foreignRows > 0) {
      refusals.push(
        `${foreignRows} rows in this window belong to another capture session, so the series mixes `
        + "two writers.",
      );
    }

    if (refusals.length > 0 || options.plumbingOnly) {
      // Observation counts are still reported: they are plumbing facts, not results. No IC.
      const plumbing = options.horizonsMs.map((horizonMs) => {
        const built = buildOfiObservations({
          frames, ofiWindowMs: options.ofiWindowMs, horizonMs, levels: options.levels,
        });
        return {
          horizonMs,
          observations: built.observations.length,
          segmentsUsed: built.segmentsUsed,
          skipped: built.skipped,
          lookaheadViolations: built.lookaheadViolations.length,
        };
      });

      console.info(JSON.stringify({
        level: "info",
        message: options.plumbingOnly
          ? "Plumbing check only — no IC computed by request."
          : "REFUSED: the capture does not meet the Phase 1 gate, so no IC was computed.",
        symbol: options.symbol,
        captureSessionId: options.captureSessionId,
        window: { from: firstAt.toISOString(), to: lastAt.toISOString(), spanMinutes: Number(spanMinutes.toFixed(1)) },
        framesRead: frames.length,
        foreignRowsInWindow: foreignRows,
        sequenceHealth: health,
        refusals,
        plumbing,
      }, null, 2));
      if (refusals.length > 0) process.exitCode = 1;
      return;
    }

    // --- Past the gate: the IC ladder, each horizon through the full R0 harness -------------
    const ladder = options.horizonsMs.map((horizonMs) => {
      const built = buildOfiObservations({
        frames, ofiWindowMs: options.ofiWindowMs, horizonMs, levels: options.levels,
      });
      const report = runFalsificationHarness(built.observations, { seed: options.seed });
      return {
        horizonMs,
        observations: built.observations.length,
        skipped: built.skipped,
        verdict: report.verdict,
        ic: report.real.ic,
        confidenceInterval: report.real.confidenceInterval,
        placeboBand: report.placeboBand,
        negativeLagThreshold: report.negativeLagThreshold,
        negativeLagIcs: report.negativeLagIcs,
        placeboIcs: report.placeboIcs,
        failures: report.failures,
      };
    });

    console.info(JSON.stringify({
      level: "info",
      message: "OFI signal evaluation complete",
      symbol: options.symbol,
      captureSessionId: options.captureSessionId,
      window: { from: firstAt.toISOString(), to: lastAt.toISOString(), spanMinutes: Number(spanMinutes.toFixed(1)) },
      framesRead: frames.length,
      sequenceHealth: health,
      ofiWindowMs: options.ofiWindowMs,
      levels: options.levels,
      ladder,
    }, null, 2));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "OFI signal evaluation failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
