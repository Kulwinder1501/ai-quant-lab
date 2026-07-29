import type { IndicatorCandle, IndicatorDefinitionSpec, IndicatorPoint, IndicatorValues } from "./technical-indicator.js";

type OptionalNumber = number | null;

function numberParameter(parameters: Record<string, number | string | boolean>, name: string, minimum: number): number {
  const value = parameters[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Indicator parameter ${name} must be a number greater than or equal to ${minimum}.`);
  }
  return value;
}

function positiveIntegerParameter(parameters: Record<string, number | string | boolean>, name: string): number {
  const value = numberParameter(parameters, name, 1);
  if (!Number.isInteger(value)) {
    throw new Error(`Indicator parameter ${name} must be a positive integer.`);
  }
  return value;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

function valuesToPoints(candles: readonly IndicatorCandle[], values: Array<IndicatorValues | null>): IndicatorPoint[] {
  return candles.flatMap((candle, index) => values[index] ? [{ candleId: candle.id, values: values[index] as IndicatorValues }] : []);
}

function simpleMovingAverage(values: readonly number[], period: number): OptionalNumber[] {
  const result: OptionalNumber[] = Array(values.length).fill(null);
  let rollingSum = 0;
  for (let index = 0; index < values.length; index += 1) {
    rollingSum += values[index];
    if (index >= period) {
      rollingSum -= values[index - period];
    }
    if (index >= period - 1) {
      result[index] = rollingSum / period;
    }
  }
  return result;
}

function exponentialMovingAverage(values: readonly number[], period: number): OptionalNumber[] {
  const result: OptionalNumber[] = Array(values.length).fill(null);
  if (values.length < period) {
    return result;
  }
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  result[period - 1] = seed;
  for (let index = period; index < values.length; index += 1) {
    result[index] = (values[index] - (result[index - 1] as number)) * multiplier + (result[index - 1] as number);
  }
  return result;
}

function trueRanges(candles: readonly IndicatorCandle[]): number[] {
  return candles.map((candle, index) => {
    if (index === 0) {
      return candle.high - candle.low;
    }
    const previousClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
}

function wilderAverage(values: readonly number[], period: number): OptionalNumber[] {
  const result: OptionalNumber[] = Array(values.length).fill(null);
  if (values.length < period) {
    return result;
  }
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let index = period; index < values.length; index += 1) {
    average = ((average * (period - 1)) + values[index]) / period;
    result[index] = average;
  }
  return result;
}

function sma(candles: readonly IndicatorCandle[], period: number): IndicatorPoint[] {
  return valuesToPoints(candles, simpleMovingAverage(candles.map((candle) => candle.close), period).map((value) => value === null ? null : { value: rounded(value) }));
}

function ema(candles: readonly IndicatorCandle[], period: number): IndicatorPoint[] {
  return valuesToPoints(candles, exponentialMovingAverage(candles.map((candle) => candle.close), period).map((value) => value === null ? null : { value: rounded(value) }));
}

function rsi(candles: readonly IndicatorCandle[], period: number): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  if (candles.length <= period) {
    return valuesToPoints(candles, result);
  }
  const gains: number[] = [];
  const losses: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const difference = candles[index].close - candles[index - 1].close;
    gains.push(Math.max(difference, 0));
    losses.push(Math.max(-difference, 0));
  }
  let averageGain = gains.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let averageLoss = losses.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const calculateRsi = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    if (averageGain === 0) return 0;
    const relativeStrength = averageGain / averageLoss;
    return 100 - (100 / (1 + relativeStrength));
  };
  result[period] = { value: rounded(calculateRsi()) };
  for (let index = period + 1; index < candles.length; index += 1) {
    averageGain = ((averageGain * (period - 1)) + gains[index - 1]) / period;
    averageLoss = ((averageLoss * (period - 1)) + losses[index - 1]) / period;
    result[index] = { value: rounded(calculateRsi()) };
  }
  return valuesToPoints(candles, result);
}

function macd(candles: readonly IndicatorCandle[], fastPeriod: number, slowPeriod: number, signalPeriod: number): IndicatorPoint[] {
  if (fastPeriod >= slowPeriod) {
    throw new Error("MACD fastPeriod must be smaller than slowPeriod.");
  }
  const closes = candles.map((candle) => candle.close);
  const fast = exponentialMovingAverage(closes, fastPeriod);
  const slow = exponentialMovingAverage(closes, slowPeriod);
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  const macdValues: number[] = [];
  let previousSignal: number | null = null;
  const multiplier = 2 / (signalPeriod + 1);

  for (let index = 0; index < candles.length; index += 1) {
    if (fast[index] === null || slow[index] === null) continue;
    const line = (fast[index] as number) - (slow[index] as number);
    macdValues.push(line);
    if (macdValues.length === signalPeriod) {
      previousSignal = macdValues.reduce((sum, value) => sum + value, 0) / signalPeriod;
    } else if (macdValues.length > signalPeriod) {
      previousSignal = (line - (previousSignal as number)) * multiplier + (previousSignal as number);
    }
    result[index] = {
      macd: rounded(line),
      signal: previousSignal === null ? null : rounded(previousSignal),
      histogram: previousSignal === null ? null : rounded(line - previousSignal),
    };
  }
  return valuesToPoints(candles, result);
}

function atr(candles: readonly IndicatorCandle[], period: number): IndicatorPoint[] {
  return valuesToPoints(candles, wilderAverage(trueRanges(candles), period).map((value) => value === null ? null : { value: rounded(value) }));
}

function vwap(candles: readonly IndicatorCandle[]): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  let sessionKey = "";
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const localSessionKey = new Date(candle.openTime.getTime() + 5.5 * 60 * 60_000).toISOString().slice(0, 10);
    if (localSessionKey !== sessionKey) {
      sessionKey = localSessionKey;
      cumulativePriceVolume = 0;
      cumulativeVolume = 0;
    }
    if (candle.volume > 0) {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePriceVolume += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
    }
    if (cumulativeVolume > 0) {
      result[index] = { value: rounded(cumulativePriceVolume / cumulativeVolume) };
    }
  }
  return valuesToPoints(candles, result);
}

function bollingerBands(candles: readonly IndicatorCandle[], period: number, standardDeviations: number): IndicatorPoint[] {
  const closes = candles.map((candle) => candle.close);
  const middle = simpleMovingAverage(closes, period);
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  for (let index = period - 1; index < candles.length; index += 1) {
    const mean = middle[index] as number;
    const variance = closes.slice(index - period + 1, index + 1).reduce((sum, close) => sum + ((close - mean) ** 2), 0) / period;
    const deviation = Math.sqrt(variance);
    result[index] = {
      middle: rounded(mean),
      upper: rounded(mean + standardDeviations * deviation),
      lower: rounded(mean - standardDeviations * deviation),
      standardDeviation: rounded(deviation),
    };
  }
  return valuesToPoints(candles, result);
}

function supertrend(candles: readonly IndicatorCandle[], atrPeriod: number, multiplier: number): IndicatorPoint[] {
  const atrValues = wilderAverage(trueRanges(candles), atrPeriod);
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  let previousFinalUpper: number | null = null;
  let previousFinalLower: number | null = null;
  let previousSupertrend: number | null = null;

  for (let index = 0; index < candles.length; index += 1) {
    const currentAtr = atrValues[index];
    if (currentAtr === null) continue;
    const candle = candles[index];
    const midpoint = (candle.high + candle.low) / 2;
    const basicUpper = midpoint + multiplier * currentAtr;
    const basicLower = midpoint - multiplier * currentAtr;
    const previousClose = index > 0 ? candles[index - 1].close : candle.close;
    const finalUpper: number = previousFinalUpper === null || basicUpper < previousFinalUpper || previousClose > previousFinalUpper
      ? basicUpper
      : previousFinalUpper;
    const finalLower: number = previousFinalLower === null || basicLower > previousFinalLower || previousClose < previousFinalLower
      ? basicLower
      : previousFinalLower;
    const value: number = previousSupertrend === null || previousSupertrend === previousFinalUpper
      ? (candle.close <= finalUpper ? finalUpper : finalLower)
      : (candle.close >= finalLower ? finalLower : finalUpper);
    result[index] = {
      value: rounded(value),
      upperBand: rounded(finalUpper),
      lowerBand: rounded(finalLower),
      trend: value === finalLower ? "UP" : "DOWN",
    };
    previousFinalUpper = finalUpper;
    previousFinalLower = finalLower;
    previousSupertrend = value;
  }
  return valuesToPoints(candles, result);
}

export class TechnicalIndicatorEngine {
  calculate(candles: readonly IndicatorCandle[], definition: IndicatorDefinitionSpec): IndicatorPoint[] {
    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index].openTime <= candles[index - 1].openTime) {
        throw new Error("Indicator candles must be in strictly increasing chronological order.");
      }
    }
    switch (definition.code) {
      case "SMA": return sma(candles, positiveIntegerParameter(definition.parameters, "period"));
      case "EMA": return ema(candles, positiveIntegerParameter(definition.parameters, "period"));
      case "RSI": return rsi(candles, positiveIntegerParameter(definition.parameters, "period"));
      case "MACD": return macd(
        candles,
        positiveIntegerParameter(definition.parameters, "fastPeriod"),
        positiveIntegerParameter(definition.parameters, "slowPeriod"),
        positiveIntegerParameter(definition.parameters, "signalPeriod"),
      );
      case "ATR": return atr(candles, positiveIntegerParameter(definition.parameters, "period"));
      case "VWAP": return vwap(candles);
      case "BOLLINGER_BANDS": return bollingerBands(
        candles,
        positiveIntegerParameter(definition.parameters, "period"),
        numberParameter(definition.parameters, "standardDeviations", 0),
      );
      case "SUPERTREND": return supertrend(
        candles,
        positiveIntegerParameter(definition.parameters, "atrPeriod"),
        numberParameter(definition.parameters, "multiplier", 0),
      );
      default: {
        const unsupported: never = definition.code;
        throw new Error(`Unsupported indicator ${unsupported}.`);
      }
    }
  }
}
