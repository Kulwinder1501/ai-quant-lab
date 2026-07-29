function parts(value: string): { whole: string; fraction: string } {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid non-negative decimal "${value}".`);
  }
  const [whole, fraction = ""] = value.split(".");
  return { whole: whole.replace(/^0+(?=\d)/, "") || "0", fraction };
}

function scaled(value: string, scale: number): bigint {
  const valueParts = parts(value);
  return BigInt(valueParts.whole + valueParts.fraction.padEnd(scale, "0"));
}

function scaleOf(...values: string[]): number {
  return Math.max(...values.map((value) => parts(value).fraction.length));
}

function asDecimal(value: bigint, scale: number): string {
  const padded = value.toString().padStart(scale + 1, "0");
  if (scale === 0) {
    return padded;
  }
  const whole = padded.slice(0, -scale).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function compareDecimals(left: string, right: string): number {
  const scale = scaleOf(left, right);
  const leftValue = scaled(left, scale);
  const rightValue = scaled(right, scale);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

export function addDecimals(left: string, right: string): string {
  const scale = scaleOf(left, right);
  return asDecimal(scaled(left, scale) + scaled(right, scale), scale);
}

export function nonNegativeDifference(current: string, previous: string): string {
  const scale = scaleOf(current, previous);
  const difference = scaled(current, scale) - scaled(previous, scale);
  return difference < 0n ? "0" : asDecimal(difference, scale);
}
