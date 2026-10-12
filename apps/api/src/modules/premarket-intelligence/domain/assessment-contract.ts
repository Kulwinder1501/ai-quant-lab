import { z } from "zod";
import type { CandidateLevel, LevelRole } from "./snapshot.js";
import { PREMARKET_INSTRUMENTS, type PremarketInstrument } from "./targets.js";

export const MAX_LEVELS_PER_INSTRUMENT = 4;
const REASONING_MAX = 600;

const reasoning = z.string().trim().min(1).max(REASONING_MAX);
const alignment = z.enum(["ALIGNED", "MIXED", "CONFLICTING"]);
const direction = z.enum(["BULLISH", "BEARISH", "NEUTRAL", "UNCERTAIN"]);

const horizonContext = <H extends string>(horizon: H) =>
  z.object({
    target_horizon: z.literal(horizon),
    expected_direction: direction,
    evidence_alignment: alignment,
    subjective_confidence: z.number().min(0).max(1),
    reasoning,
  }).strict();

const rawAssessment = z.object({
  instrument: z.enum(PREMARKET_INSTRUMENTS),
  opening_context: z.object({
    expectation: z.enum(["GAP_UP", "GAP_DOWN", "FLAT", "UNCERTAIN"]),
    reasoning,
  }).strict(),
  intraday_context: horizonContext("FIRST_60_MINUTES"),
  full_session_context: horizonContext("FULL_SESSION"),
  // The model picks from the system's candidate list by reference; it never supplies a price.
  key_levels: z.array(z.object({
    level_ref: z.string().min(1),
    role: z.enum(["SUPPORT", "RESISTANCE"]),
  }).strict()).max(MAX_LEVELS_PER_INSTRUMENT),
  evidence_ids: z.array(z.string().min(1)).min(1),
}).strict();

const rawContract = z.object({ assessments: z.array(z.unknown()) }).strict();

export interface ResolvedLevel {
  levelRef: string;
  role: LevelRole;
  price: number;
  label: string;
}

export interface ValidatedAssessment {
  instrument: PremarketInstrument;
  assessmentDate: string;
  opening_context: z.infer<typeof rawAssessment>["opening_context"];
  intraday_context: z.infer<typeof rawAssessment>["intraday_context"];
  full_session_context: z.infer<typeof rawAssessment>["full_session_context"];
  key_levels: ResolvedLevel[];
  evidence_ids: string[];
}

export type ContractResult =
  | { ok: true; assessments: ValidatedAssessment[] }
  | { ok: false; errors: string[] };

/**
 * Validates a model response against the pre-market contract. Pure: no I/O, no clock.
 *
 * Rejects (never repairs) a response with a missing, duplicated or unexpected instrument, an
 * unknown key, an out-of-range confidence, an evidence id that is not in the manifest, or a level
 * reference that is not one of the system's candidates for that instrument. Repairing would put
 * words in the model's mouth and then score them as its prediction.
 *
 * `assessment_date` is owned by the application. A model-supplied one is dropped rather than
 * trusted -- it is the only key tolerated outside the schema, because models often echo it.
 */
export function validateAssessmentContract(input: {
  raw: unknown;
  assessmentDate: string;
  knownEvidenceIds: ReadonlySet<string>;
  candidateLevels: readonly CandidateLevel[];
}): ContractResult {
  const top = rawContract.safeParse(input.raw);
  if (!top.success) return { ok: false, errors: top.error.issues.map((issue) => `contract: ${issue.path.join(".") || "(root)"} ${issue.message}`) };

  const errors: string[] = [];
  const parsed: z.infer<typeof rawAssessment>[] = [];
  top.data.assessments.forEach((item, index) => {
    const candidate = typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => key !== "assessment_date"))
      : item;
    const result = rawAssessment.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) errors.push(`assessments[${index}].${issue.path.join(".")}: ${issue.message}`);
    } else {
      parsed.push(result.data);
    }
  });
  if (errors.length > 0) return { ok: false, errors };

  const seen = new Set<string>();
  for (const assessment of parsed) {
    if (seen.has(assessment.instrument)) errors.push(`duplicate assessment for ${assessment.instrument}`);
    seen.add(assessment.instrument);
  }
  for (const instrument of PREMARKET_INSTRUMENTS) {
    if (!seen.has(instrument)) errors.push(`missing assessment for ${instrument}`);
  }
  if (parsed.length !== PREMARKET_INSTRUMENTS.length) errors.push(`expected exactly ${PREMARKET_INSTRUMENTS.length} assessments, got ${parsed.length}`);

  const validated: ValidatedAssessment[] = [];
  for (const assessment of parsed) {
    for (const id of assessment.evidence_ids) {
      if (!input.knownEvidenceIds.has(id)) errors.push(`${assessment.instrument}: unknown evidence id "${id}"`);
    }
    const levels: ResolvedLevel[] = [];
    const usedRefs = new Set<string>();
    for (const level of assessment.key_levels) {
      const match = input.candidateLevels.find((candidate) => candidate.id === level.level_ref && candidate.instrument === assessment.instrument);
      if (!match) {
        errors.push(`${assessment.instrument}: level_ref "${level.level_ref}" is not a candidate level`);
        continue;
      }
      if (usedRefs.has(level.level_ref)) {
        errors.push(`${assessment.instrument}: level_ref "${level.level_ref}" repeated`);
        continue;
      }
      usedRefs.add(level.level_ref);
      levels.push({ levelRef: match.id, role: level.role, price: match.price, label: match.label });
    }
    validated.push({
      instrument: assessment.instrument,
      assessmentDate: input.assessmentDate,
      opening_context: assessment.opening_context,
      intraday_context: assessment.intraday_context,
      full_session_context: assessment.full_session_context,
      key_levels: levels,
      evidence_ids: assessment.evidence_ids,
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, assessments: validated };
}
