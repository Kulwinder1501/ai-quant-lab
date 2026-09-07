import type { DivergenceEvidence } from "../../modules/autonomous-v2/domain/differential-testing.js";
import { getOption } from "./arguments.js";

/**
 * Builds a `DivergenceEvidence` from command-line options, refusing anything incomplete.
 *
 * Separate from `classify-divergence.ts` because that file runs `main()` on import, so a test that
 * imported it would start a real run -- the same reason `shadow-decision-options.ts` exists. This is
 * the part worth testing: the mapping from flags to a discriminated union is where a wrong field
 * silently becomes a mislabelled classification.
 *
 * The database enforces the same requirements independently. Both are wanted: the CHECK is the one
 * that cannot be bypassed, and this one produces a message naming the flag a human forgot rather than
 * a constraint violation.
 */

interface EvidenceSpec {
  readonly kind: DivergenceEvidence["kind"];
  /** flag name -> field name in the evidence object. */
  readonly fields: Readonly<Record<string, string>>;
  /** Fields that may be explicitly empty, meaning "not yet", rather than being absent. */
  readonly nullableFields?: readonly string[];
}

const SPECS: readonly EvidenceSpec[] = [
  { kind: "EXPECTED_ARCHITECTURAL_CHANGE", fields: { "design-decision": "designDecision" } },
  {
    kind: "DATA_DIFFERENCE",
    fields: { "legacy-boundary": "legacyBoundary", "v2-boundary": "v2Boundary" },
  },
  {
    kind: "POLICY_DIFFERENCE",
    fields: { "legacy-policy-version": "legacyPolicyVersion", "v2-policy-version": "v2PolicyVersion" },
  },
  { kind: "RISK_DIFFERENCE", fields: { "risk-rule": "riskRule" } },
  { kind: "EXECUTION_DIFFERENCE", fields: { "execution-condition": "executionCondition" } },
  /*
   * `resolutionRef` is nullable but never absent. Null means "identified, not yet fixed", which §6
   * makes a promotion blocker; absent would mean the question was never asked. Passing
   * `--resolution-ref=` explicitly records the first.
   */
  { kind: "BUG", fields: { "resolution-ref": "resolutionRef" }, nullableFields: ["resolutionRef"] },
  { kind: "UNKNOWN", fields: {} },
];

export function formatEvidenceUsage(): string {
  return SPECS
    .map((spec) => {
      const flags = Object.keys(spec.fields).map((flag) => `--${flag}=`).join(" ");
      return `--kind=${spec.kind}${flags === "" ? "" : ` ${flags}`}`;
    })
    .join(" | ");
}

export function divergenceEvidenceFromOptions(args: readonly string[]): DivergenceEvidence {
  const kind = getOption([...args], "kind")?.trim();
  if (kind === undefined || kind === "") {
    throw new Error(`--kind is required. One of: ${SPECS.map((spec) => spec.kind).join(", ")}.`);
  }
  const spec = SPECS.find((candidate) => candidate.kind === kind);
  if (!spec) {
    throw new Error(
      `Unknown --kind "${kind}". P13 recognises exactly seven classifications and does not infer `
      + `between them: ${SPECS.map((candidate) => candidate.kind).join(", ")}.`,
    );
  }

  const evidence: Record<string, unknown> = { kind: spec.kind };
  for (const [flag, field] of Object.entries(spec.fields)) {
    const raw = getOption([...args], flag);
    const nullable = spec.nullableFields?.includes(field) ?? false;
    if (raw === undefined) {
      throw new Error(
        `--kind=${spec.kind} requires --${flag}`
        + (nullable
          ? ". Pass it empty to record the reference as not yet available, which is a different "
            + "claim from omitting it."
          : `. The classification carries ${field} because "${spec.kind}" without it is a label `
            + "rather than a claim."),
      );
    }
    const value = raw.trim();
    if (value === "" && !nullable) {
      throw new Error(`--${flag} cannot be blank for --kind=${spec.kind}.`);
    }
    evidence[field] = value === "" ? null : value;
  }

  return evidence as DivergenceEvidence;
}
