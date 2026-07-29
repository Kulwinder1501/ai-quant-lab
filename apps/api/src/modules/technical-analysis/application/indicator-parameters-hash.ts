import { createHash } from "node:crypto";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable across object key order, so a definition identity is reproducible. */
export function indicatorParametersHash(parameters: Record<string, number | string | boolean>): string {
  return createHash("sha256").update(stableJson(parameters)).digest("hex");
}
