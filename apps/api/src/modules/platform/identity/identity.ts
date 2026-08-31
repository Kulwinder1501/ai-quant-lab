import { createHash } from "node:crypto";

export const researchIdentityEncodingVersion = "canonical-json-sha256-v1";

/** Canonical JSON: sorted object keys, UTC dates, finite normalized numbers, no undefined values. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Research identities cannot contain invalid dates.");
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) throw new Error("Research identities cannot contain non-finite numbers.");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    case "bigint": return JSON.stringify(value.toString());
    case "undefined": throw new Error("Research identities cannot contain undefined.");
    case "object": break;
    default: throw new Error(`Unsupported research identity value: ${typeof value}.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Research identities support only dates, arrays, and plain objects.");
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Object encoding is intentional: it cannot collide because one field contained a separator. */
export function logicalKey(namespace: string, fields: readonly unknown[]): string {
  if (namespace.trim().length === 0) throw new Error("A logical-key namespace is required.");
  return sha256Canonical({ encoding: researchIdentityEncodingVersion, namespace, fields });
}

export function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
}
