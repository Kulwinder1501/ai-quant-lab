import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { indicatorParametersHash } from "./indicator-parameters-hash.js";
import {
  defaultIndicatorDefinitions,
  type IndicatorCandle,
  type IndicatorDefinitionRepository,
  type IndicatorDefinitionSpec,
  type IndicatorSnapshotRepository,
} from "../domain/technical-indicator.js";
import { TechnicalIndicatorEngine } from "../domain/technical-indicator-engine.js";

export interface CalculateTechnicalIndicatorsInput {
  instrumentId: string;
  timeframe: string;
  definitions?: readonly IndicatorDefinitionSpec[];
}

export interface CalculateTechnicalIndicatorsResult {
  candlesRead: number;
  definitionsProcessed: number;
  snapshotsWritten: number;
}

function decimalToNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Persisted candle has invalid ${field} value.`);
  }
  return parsed;
}

function toIndicatorCandle(candle: PersistedCandle): IndicatorCandle {
  return {
    id: candle.id,
    openTime: candle.openTime,
    open: decimalToNumber(candle.open, "open"),
    high: decimalToNumber(candle.high, "high"),
    low: decimalToNumber(candle.low, "low"),
    close: decimalToNumber(candle.close, "close"),
    volume: decimalToNumber(candle.volume, "volume"),
  };
}

export class CalculateTechnicalIndicators {
  constructor(
    private readonly candleRepository: CandleRepository,
    private readonly definitionRepository: IndicatorDefinitionRepository,
    private readonly snapshotRepository: IndicatorSnapshotRepository,
    private readonly engine = new TechnicalIndicatorEngine(),
  ) {}

  async execute(input: CalculateTechnicalIndicatorsInput): Promise<CalculateTechnicalIndicatorsResult> {
    const candles = (await this.candleRepository.listCompleted(input.instrumentId, input.timeframe)).map(toIndicatorCandle);
    const definitions = input.definitions ?? defaultIndicatorDefinitions;
    let snapshotsWritten = 0;

    for (const specification of definitions) {
      const definition = await this.definitionRepository.ensure({
        ...specification,
        parametersHash: indicatorParametersHash(specification.parameters),
      });
      const points = this.engine.calculate(candles, specification);
      for (const point of points) {
        await this.snapshotRepository.upsert({
          candleId: point.candleId,
          indicatorDefinitionId: definition.id,
          values: point.values,
        });
        snapshotsWritten += 1;
      }
    }
    return { candlesRead: candles.length, definitionsProcessed: definitions.length, snapshotsWritten };
  }
}
