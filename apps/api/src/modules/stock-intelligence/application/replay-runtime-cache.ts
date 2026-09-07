import type {
  AsReportedFundamental,
  CanonicalFact,
  CanonicalFeature,
  CanonicalSignal,
  CorporateActionRecord,
} from "../domain/canonical.js";
import { REGIME_SIGNAL_NAME, type AnalogueFeatureSnapshot } from "../domain/analogue-search.js";
import type { CalibrationObservation } from "../domain/calibration.js";
import { OUTCOME_SIGNAL_12M, OUTCOME_SIGNAL_6M } from "../domain/outcome-model.js";
import type { InstrumentExistence } from "../domain/universe.js";

/**
 * In-memory PIT lookups for historical replay. The DB path re-scanned growing
 * feature/signal tables and re-hit existence per candidate on every pair; that
 * made COMPLETE pairs slower as the job progressed.
 */
export class ReplayRuntimeCache {
  readonly features: CanonicalFeature[] = [];
  readonly regimeSignals: CanonicalSignal[] = [];
  readonly outcomeSignals6m: CanonicalSignal[] = [];
  readonly outcomeSignals12m: CanonicalSignal[] = [];
  /** Pre-grouped analogue feature snapshots; avoids rebuilding from feature rows each pair. */
  readonly analogueSnapshots: AnalogueFeatureSnapshot[] = [];
  readonly existenceByInstrument = new Map<string, InstrumentExistence[]>();
  readonly actionsByInstrument = new Map<string, CorporateActionRecord[]>();
  readonly fundamentalsByInstrument = new Map<string, AsReportedFundamental[]>();
  readonly factsByInstrument = new Map<string, CanonicalFact[]>();
  /**
   * Prior forecast outcomes, keyed by instrument|predictionAsOf|horizon.
   * `realizableFrom` is the horizon-end date key — include only when query asOf >= that.
   */
  readonly realizedCalibration = new Map<string, {
    readonly realizableFrom: string;
    readonly observation: CalibrationObservation;
  }>();

  seedExistence(rows: readonly InstrumentExistence[]): void {
    this.existenceByInstrument.clear();
    for (const row of rows) {
      const current = this.existenceByInstrument.get(row.instrumentId) ?? [];
      current.push(row);
      this.existenceByInstrument.set(row.instrumentId, current);
    }
    for (const [instrumentId, list] of this.existenceByInstrument) {
      list.sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime());
      this.existenceByInstrument.set(instrumentId, list);
    }
  }

  findExistenceAsOf(instrumentId: string, asOf: Date): InstrumentExistence | null {
    const rows = this.existenceByInstrument.get(instrumentId) ?? [];
    for (const row of rows) {
      if (row.availableAt.getTime() <= asOf.getTime()) return row;
    }
    return null;
  }

  featuresBefore(before: Date): CanonicalFeature[] {
    const cutoff = before.getTime();
    return this.features.filter((row) => row.availableAt.getTime() < cutoff);
  }

  analogueSnapshotsBefore(beforeAsOf: string): AnalogueFeatureSnapshot[] {
    return this.analogueSnapshots.filter((row) => row.asOf < beforeAsOf);
  }

  signalsBefore(before: Date, signalName: string): CanonicalSignal[] {
    const cutoff = before.getTime();
    const source = signalName === REGIME_SIGNAL_NAME
      ? this.regimeSignals
      : signalName === OUTCOME_SIGNAL_6M
        ? this.outcomeSignals6m
        : signalName === OUTCOME_SIGNAL_12M
          ? this.outcomeSignals12m
          : [];
    return source.filter((row) => row.availableAt.getTime() < cutoff);
  }

  appendFeatures(rows: readonly CanonicalFeature[]): void {
    this.features.push(...rows);
  }

  appendAnalogueSnapshot(snapshot: AnalogueFeatureSnapshot): void {
    this.analogueSnapshots.push(snapshot);
  }

  appendSignal(signal: Omit<CanonicalSignal, "signalId"> & { signalId?: string }): void {
    const row = { signalId: signal.signalId ?? "cache", ...signal };
    if (signal.signalName === REGIME_SIGNAL_NAME) this.regimeSignals.push(row);
    else if (signal.signalName === OUTCOME_SIGNAL_6M) this.outcomeSignals6m.push(row);
    else if (signal.signalName === OUTCOME_SIGNAL_12M) this.outcomeSignals12m.push(row);
  }

  corporateActionsAsOf(instrumentId: string, dataCutoff: Date): CorporateActionRecord[] {
    const cutoff = dataCutoff.getTime();
    return (this.actionsByInstrument.get(instrumentId) ?? [])
      .filter((row) => row.availableAt.getTime() <= cutoff);
  }

  fundamentalsAsOf(instrumentId: string, dataCutoff: Date): AsReportedFundamental[] {
    const cutoff = dataCutoff.getTime();
    return (this.fundamentalsByInstrument.get(instrumentId) ?? [])
      .filter((row) => row.availableAt.getTime() <= cutoff);
  }

  factsAsOf(instrumentId: string, dataCutoff: Date): CanonicalFact[] {
    const cutoff = dataCutoff.getTime();
    return (this.factsByInstrument.get(instrumentId) ?? [])
      .filter((row) => row.availableAt.getTime() <= cutoff);
  }
}
