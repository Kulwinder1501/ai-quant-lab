import { createHash } from "node:crypto";
import type { AnyDetectedPattern } from "./contracts.js";

/**
 * The V1.0.1 canonical byte encoding and the observation hash built on it.
 *
 * ## Why a fourth canonicalization, and why it does not reuse `identity.ts`
 *
 * The repository already has three JSON-based canonicalizers —
 * `market-data/domain/data-readiness.ts`, `research/scalp-harness/domain/live-backfill-parity.ts`,
 * and `research/scalp-harness/domain/identity.ts`, the last exporting `sha256CanonicalBytes` and
 * `logicalKey` under `researchIdentityEncodingVersion = "canonical-json-sha256-v1"`. This is a
 * fourth, in a different format. That is deliberate, and stated here so a later reader does not
 * "consolidate" it as accidental duplication.
 *
 * The JSON canonicalizers build a string and hash it. String-joining is not injective: the key/value
 * pairs `{"a": "b:c"}` and `{"a:b": "c"}` can serialise to the same bytes under a naive joiner, so two
 * different observations can collide. For a research fingerprint that is a tolerable risk. For
 * `observationHash` it is not — the hash *is* the observation's identity, the field a duplicate check
 * and an immutability check both rest on, and a collision there silently merges two market events.
 *
 * The encoding below is injective by construction: every value carries a one-byte type tag, every
 * variable-length payload is ULEB128 length-prefixed before its content, and object keys are sorted
 * by UTF-8 byte order rather than by JavaScript's default UTF-16 code-unit order. A string can
 * therefore never be confused with a Date carrying the same text, `null` never with the string
 * `"null"`, and no concatenation of keys can imitate a different key set.
 *
 * Reusing `identity.ts` would mean either weakening that guarantee or changing a hash that scalp
 * research rows already depend on. Two encodings with two different jobs is the cheaper answer.
 *
 * ## The observation hash payload, stated exactly
 *
 * Spec Section 3.1 lists the covered fields as a flat set that happens to include five `provenance.*`
 * members, and never says whether those are nested under a `provenance` key or hoisted to the top
 * level. Both readings are conforming, and they produce different hashes for the identical
 * observation — so the hash was not, in fact, specified. This implementation nests, and that choice is
 * frozen here:
 *
 * The hashed value is an OBJECT with exactly these 8 keys:
 *   `context`, `definitionRef`, `details`, `geometry`, `identity`, `provenance`, `source`, `timing`
 *
 * where `provenance` is itself an OBJECT with exactly these 5 keys:
 *   `configHash`, `configVersion`, `dataSchemaVersion`, `dataSource`, `engineVersion`
 *
 * `provenance.observationHash` is excluded, because it is the field being computed. Key order is
 * irrelevant to the output — the encoder sorts — but the key *sets* above are load-bearing: adding or
 * removing a key at either level changes every hash and is a new encoding version, never an edit.
 *
 * `pattern-intelligence.test.ts` pins both key sets. The golden digests live in
 * `canonical-hash-golden-digests.test.ts` -- separately, because this comment previously claimed a
 * digest pin that did not exist: every observation-hash assertion in that file compares a
 * recomputation against a value the same run produced, so an encoder change moved both sides together
 * and passed. The pins now cover the scalar tag bytes, the probe's length and digest, the observation
 * hash and the observation logical key, so a change to either the key sets or the encoding is a test
 * failure rather than a silent re-identification of history.
 */

const textEncoder = new TextEncoder();

function uleb128(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`ULEB128 value must be a non-negative safe integer; got ${value}.`);
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function utf8(value: string): Buffer {
  return Buffer.from(textEncoder.encode(value));
}

function lengthPrefixed(value: Buffer): Buffer {
  return Buffer.concat([uleb128(value.length), value]);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(utf8(left), utf8(right));
}

/** Implements the frozen V1.0.1 type-tagged canonical byte encoding. */
export function encodeCanonical(value: unknown): Buffer {
  if (value === null) return Buffer.from([0x04]);

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Invalid Date cannot be canonically encoded.");
    const bytes = utf8(value.toISOString());
    return Buffer.concat([Buffer.from([0x05]), lengthPrefixed(bytes)]);
  }

  if (typeof value === "string") {
    const bytes = utf8(value);
    return Buffer.concat([Buffer.from([0x01]), lengthPrefixed(bytes)]);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number cannot be canonically encoded: ${value}.`);
    const normalized = Object.is(value, -0) ? 0 : value;
    const bytes = Buffer.from(normalized.toString(), "ascii");
    return Buffer.concat([Buffer.from([0x02]), lengthPrefixed(bytes)]);
  }

  if (typeof value === "boolean") return Buffer.from([0x03, value ? 0x01 : 0x00]);

  if (Array.isArray(value)) {
    const encoded = value.map(encodeCanonical);
    return Buffer.concat([
      Buffer.from([0x06]),
      uleb128(encoded.length),
      ...encoded.map(lengthPrefixed),
    ]);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    const entries = keys.map((key) => {
      const child = record[key];
      if (child === undefined) throw new Error(`Undefined value at canonical key "${key}" is not permitted.`);
      const encodedValue = encodeCanonical(child);
      return Buffer.concat([lengthPrefixed(utf8(key)), lengthPrefixed(encodedValue)]);
    });
    return Buffer.concat([Buffer.from([0x07]), uleb128(keys.length), ...entries]);
  }

  throw new Error(`Unsupported canonical value type: ${typeof value}.`);
}

export function sha256CanonicalBytes(value: unknown): string {
  return createHash("sha256").update(encodeCanonical(value)).digest("hex");
}

function observationHashPayload(observation: AnyDetectedPattern): Record<string, unknown> {
  const { observationHash: _observationHash, ...provenance } = observation.provenance;
  return {
    identity: observation.identity,
    source: observation.source,
    definitionRef: observation.definitionRef,
    timing: observation.timing,
    geometry: observation.geometry,
    context: observation.context,
    details: observation.details,
    provenance,
  };
}

export function calculateObservationHash(observation: AnyDetectedPattern): string {
  return sha256CanonicalBytes(observationHashPayload(observation));
}

/**
 * The key that says "this is the same observation as that one", for storage idempotency.
 *
 * `observationHash` cannot do this job. It covers `identity.observationId`, which is a fresh
 * `randomUUID()` on every detection pass, so re-running the detector over a window it has already
 * covered yields a *different* hash for an identical pattern — and a store keyed on it would
 * accumulate a duplicate set per run. That is not a hypothetical: a scheduled detection job re-scans
 * overlapping windows by design.
 *
 * So identity-for-storage is the observable facts that would make two detections the same event:
 * where, at what resolution, what was detected, which way, when, under which frozen rules. The
 * candidate key that omits `details` is wrong — `LEVEL_INTERACTION/BREAK_AND_HOLD` fires once per
 * reference level, so a bar breaking both PDH and prior-close produces two rows identical in every
 * other field, and collapsing them would silently discard one real observation.
 *
 * `definitionHash` is in the key because a threshold change makes a genuinely different observation
 * of the same bar, and both readings should coexist rather than one overwriting the other.
 *
 * Deliberately excluded: `timing.knownAt`, `earliestExecutionAt`, `provenance.*` and the whole of
 * `context`. Those vary with *when the detector ran* rather than with what happened in the market — a
 * backfill pass and a live pass over the same bar must collide, which is the entire point.
 */
export function calculateObservationLogicalKey(observation: AnyDetectedPattern): string {
  return sha256CanonicalBytes({
    exchange: observation.source.exchange,
    underlying: observation.source.underlying,
    instrumentType: observation.source.instrumentType,
    contractSymbol: observation.source.contractSymbol,
    timeframe: observation.source.timeframe,
    patternFamily: observation.identity.patternFamily,
    patternSubtype: observation.identity.patternSubtype,
    orientation: observation.identity.orientation,
    startAt: observation.timing.startAt,
    detectedAt: observation.timing.detectedAt,
    definitionId: observation.definitionRef.definitionId,
    definitionVersion: observation.definitionRef.definitionVersion,
    definitionHash: observation.definitionRef.definitionHash,
    details: observation.details,
  });
}

export function calculateConfigHash(profileCalculationConfig: object, tpoConfig: object): string {
  return createHash("sha256")
    .update(encodeCanonical(profileCalculationConfig))
    .update(Buffer.from([0x00]))
    .update(encodeCanonical(tpoConfig))
    .digest("hex");
}

export function calculateDefinitionHash(definition: object): string {
  const { definitionHash: _definitionHash, ...payload } = definition as Record<string, unknown>;
  return sha256CanonicalBytes(payload);
}
