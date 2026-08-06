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

/**
 * Fair value gaps, published on the bar that completes the pattern.
 *
 * A gap is a three-bar shape: bar 1's high below bar 3's low, or the mirror. It used to be
 * stamped on the **middle** bar, which meant the value at bar i was computed from bar i+1 --
 * a reader at time i could not have known it. That is look-ahead, and it was measurable:
 * editing a later bar changed an earlier bar's FVG.
 *
 * The gap's price levels still describe the middle bar's zone. What moves is *when the
 * observation exists*, which is the third bar, because that is when the shape is complete.
 * `gapBarOffset` records the distance back to the zone so a chart can still draw it in place.
 */
function fvg(candles: readonly IndicatorCandle[]): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  for (let index = 2; index < candles.length; index += 1) {
    const candle1 = candles[index - 2];
    const candle3 = candles[index];

    // Bullish FVG: low of candle 3 is higher than high of candle 1
    if (candle3.low > candle1.high) {
      result[index] = {
        type: "BULLISH",
        top: rounded(candle3.low),
        bottom: rounded(candle1.high),
        gapBarOffset: 1,
        active: true,
      };
    }
    // Bearish FVG: high of candle 3 is lower than low of candle 1
    else if (candle3.high < candle1.low) {
      result[index] = {
        type: "BEARISH",
        top: rounded(candle1.low),
        bottom: rounded(candle3.high),
        gapBarOffset: 1,
        active: true,
      };
    }
  }
  return valuesToPoints(candles, result);
}

function bos(candles: readonly IndicatorCandle[], pivotLength: number): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  let lastSwingHigh: number | null = null;
  let lastSwingLow: number | null = null;

  for (let index = pivotLength; index < candles.length - pivotLength; index += 1) {
    const currentHigh = candles[index].high;
    const currentLow = candles[index].low;
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= pivotLength; j++) {
      if (candles[index - j].high >= currentHigh || candles[index + j].high >= currentHigh) {
        isSwingHigh = false;
      }
      if (candles[index - j].low <= currentLow || candles[index + j].low <= currentLow) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) {
      lastSwingHigh = currentHigh;
    }
    if (isSwingLow) {
      lastSwingLow = currentLow;
    }

    // Now check for Break of Structure
    // Note: We check if the current close breaks the LAST known swing high/low that was formed BEFORE this candle.
    const close = candles[index].close;
    if (lastSwingHigh !== null && close > lastSwingHigh) {
      result[index] = { type: "BULLISH_BOS", level: rounded(lastSwingHigh) };
      lastSwingHigh = null; // Consume it so we don't trigger again on the same level
    } else if (lastSwingLow !== null && close < lastSwingLow) {
      result[index] = { type: "BEARISH_BOS", level: rounded(lastSwingLow) };
      lastSwingLow = null;
    }
  }
  return valuesToPoints(candles, result);
}

function choch(candles: readonly IndicatorCandle[], pivotLength: number): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  let lastSwingHigh: number | null = null;
  let lastSwingLow: number | null = null;
  let currentTrend: "BULLISH" | "BEARISH" | null = null;

  for (let index = pivotLength; index < candles.length - pivotLength; index += 1) {
    const currentHigh = candles[index].high;
    const currentLow = candles[index].low;
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= pivotLength; j++) {
      if (candles[index - j].high >= currentHigh || candles[index + j].high >= currentHigh) isSwingHigh = false;
      if (candles[index - j].low <= currentLow || candles[index + j].low <= currentLow) isSwingLow = false;
    }

    if (isSwingHigh) lastSwingHigh = currentHigh;
    if (isSwingLow) lastSwingLow = currentLow;

    const close = candles[index].close;
    
    // Check for structure breaks to determine trend
    if (lastSwingHigh !== null && close > lastSwingHigh) {
      if (currentTrend === "BEARISH") {
        result[index] = { type: "BULLISH_CHOCH", level: rounded(lastSwingHigh) };
      }
      currentTrend = "BULLISH";
      lastSwingHigh = null; 
    } else if (lastSwingLow !== null && close < lastSwingLow) {
      if (currentTrend === "BULLISH") {
        result[index] = { type: "BEARISH_CHOCH", level: rounded(lastSwingLow) };
      }
      currentTrend = "BEARISH";
      lastSwingLow = null;
    }
  }
  return valuesToPoints(candles, result);
}

function liquiditySweep(candles: readonly IndicatorCandle[], pivotLength: number): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  let lastSwingHigh: number | null = null;
  let lastSwingLow: number | null = null;

  for (let index = pivotLength; index < candles.length - pivotLength; index += 1) {
    const currentHigh = candles[index].high;
    const currentLow = candles[index].low;
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= pivotLength; j++) {
      if (candles[index - j].high >= currentHigh || candles[index + j].high >= currentHigh) isSwingHigh = false;
      if (candles[index - j].low <= currentLow || candles[index + j].low <= currentLow) isSwingLow = false;
    }

    if (isSwingHigh) lastSwingHigh = currentHigh;
    if (isSwingLow) lastSwingLow = currentLow;

    const high = candles[index].high;
    const low = candles[index].low;
    const close = candles[index].close;

    // Sweep: Pierces level but closes back inside
    if (lastSwingHigh !== null && high > lastSwingHigh && close <= lastSwingHigh) {
      result[index] = { type: "BEARISH_SWEEP", level: rounded(lastSwingHigh) };
      lastSwingHigh = null; // consume
    }
    if (lastSwingLow !== null && low < lastSwingLow && close >= lastSwingLow) {
      result[index] = { type: "BULLISH_SWEEP", level: rounded(lastSwingLow) };
      lastSwingLow = null; // consume
    }
  }
  return valuesToPoints(candles, result);
}

function orderBlock(candles: readonly IndicatorCandle[], displacementThreshold: number): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  
  /*
   * The displacement reference is built only from bars at or before the one being scored.
   *
   * It used to be seeded with the mean body of the series' first 50 candles and then rolled
   * forward. For any bar inside that seed window -- the first fifty, which on a short series
   * is all of them -- the reference therefore included bars that had not happened yet, and
   * the seed's influence decays but never leaves. It did not always change the output, since
   * the value is a threshold comparison and a small shift in the mean often flips nothing,
   * which is exactly why it survived: a leak that only sometimes shows is still a leak.
   */
  const bodies: number[] = [];

  for (let index = 1; index < candles.length; index += 1) {
    bodies.push(Math.abs(candles[index - 1].close - candles[index - 1].open));
    if (bodies.length > 20) bodies.shift();
    // `|| 1` keeps a flat opening stretch from making every later bar a displacement.
    const avgBody = (bodies.reduce((total, body) => total + body, 0) / bodies.length) || 1;

    const candle = candles[index];
    const prevCandle = candles[index - 1];
    const bodySize = Math.abs(candle.close - candle.open);

    if (bodySize > avgBody * displacementThreshold) {
      const isBullishDisplacement = candle.close > candle.open;
      const wasBearish = prevCandle.close < prevCandle.open;
      const wasBullish = prevCandle.close > prevCandle.open;

      if (isBullishDisplacement && wasBearish) {
        result[index - 1] = {
          type: "BULLISH_OB",
          top: rounded(prevCandle.high),
          bottom: rounded(prevCandle.low),
        };
      } else if (!isBullishDisplacement && wasBullish) {
        result[index - 1] = {
          type: "BEARISH_OB",
          top: rounded(prevCandle.high),
          bottom: rounded(prevCandle.low),
        };
      }
    }
  }
  return valuesToPoints(candles, result);
}

/**
 * The zone between the most recent confirmed swing high and low, and its midpoint.
 *
 * A swing at bar i is only *known* at bar i + pivotLength, because confirming it reads the
 * pivotLength bars after it. The other swing-based indicators here get away with using one
 * immediately: their trigger is a break of the level, and a swing high requires the following
 * bars to be lower, so the break cannot fire inside the confirmation window.
 *
 * This one has no such trigger -- it publishes the zone on every bar -- so it was emitting a
 * value at bar i built from bars up to i + pivotLength. Measured: editing a later bar changed
 * two earlier values. Swings are therefore held pending and promoted only once their window
 * has elapsed, so a published zone never depends on a bar after the one carrying it.
 */
function equilibriumZone(candles: readonly IndicatorCandle[], pivotLength: number): IndicatorPoint[] {
  const result: Array<IndicatorValues | null> = Array(candles.length).fill(null);
  let lastSwingHigh: number | null = null;
  let lastSwingLow: number | null = null;
  let pendingHigh: { value: number; knownAt: number } | null = null;
  let pendingLow: { value: number; knownAt: number } | null = null;

  for (let index = pivotLength; index < candles.length - pivotLength; index += 1) {
    // Promote first: a swing detected earlier becomes usable once this bar is at or past
    // the end of its confirmation window.
    if (pendingHigh !== null && index >= pendingHigh.knownAt) {
      lastSwingHigh = pendingHigh.value;
      pendingHigh = null;
    }
    if (pendingLow !== null && index >= pendingLow.knownAt) {
      lastSwingLow = pendingLow.value;
      pendingLow = null;
    }

    const currentHigh = candles[index].high;
    const currentLow = candles[index].low;
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= pivotLength; j++) {
      if (candles[index - j].high >= currentHigh || candles[index + j].high >= currentHigh) isSwingHigh = false;
      if (candles[index - j].low <= currentLow || candles[index + j].low <= currentLow) isSwingLow = false;
    }

    if (isSwingHigh) pendingHigh = { value: currentHigh, knownAt: index + pivotLength };
    if (isSwingLow) pendingLow = { value: currentLow, knownAt: index + pivotLength };

    if (lastSwingHigh !== null && lastSwingLow !== null) {
      result[index] = {
        top: rounded(lastSwingHigh),
        bottom: rounded(lastSwingLow),
        equilibrium: rounded((lastSwingHigh + lastSwingLow) / 2),
      };
    }
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
      case "FVG": return fvg(candles);
      case "BOS": return bos(
        candles,
        positiveIntegerParameter(definition.parameters, "pivotLength"),
      );
      case "CHOCH": return choch(
        candles,
        positiveIntegerParameter(definition.parameters, "pivotLength"),
      );
      case "LIQUIDITY_SWEEP": return liquiditySweep(
        candles,
        positiveIntegerParameter(definition.parameters, "pivotLength"),
      );
      case "ORDER_BLOCK": return orderBlock(
        candles,
        numberParameter(definition.parameters, "displacementThreshold", 1.5),
      );
      case "EQUILIBRIUM_ZONE": return equilibriumZone(
        candles,
        positiveIntegerParameter(definition.parameters, "pivotLength"),
      );
      default: {
        const unsupported: never = definition.code as never;
        throw new Error(`Unsupported indicator ${unsupported}.`);
      }
    }
  }
}
