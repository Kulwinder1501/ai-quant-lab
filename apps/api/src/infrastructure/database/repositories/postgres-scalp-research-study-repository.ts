import type { DatabaseQueryable } from "../database.js";
import {
  assertStudyRegistrable,
  studyDefinitionHash,
  studyRegistryEncodingVersion,
  type StudyDefinition,
} from "../../../modules/research/scalp-harness/domain/study-registry.js";

export type StudyRegistrationOutcome = "REGISTERED" | "ALREADY_REGISTERED";

export interface StudyRegistrationResult {
  readonly studyKey: string;
  readonly studyDefinitionHash: string;
  readonly outcome: StudyRegistrationOutcome;
  readonly registeredAt: Date;
}

export interface RegisteredStudyRow {
  readonly studyKey: string;
  readonly studyDefinitionHash: string;
  readonly provenance: string;
  readonly registeredAt: Date;
}

/**
 * Writes and reads pre-registered study definitions.
 *
 * The interesting behaviour is the conflict path. Registration is idempotent for an *unchanged*
 * definition — re-running the registrar on deploy has to be safe — but a key that already exists under
 * a different content hash is refused rather than skipped or overwritten. That single distinction is
 * what makes pre-registration mean anything: a silently accepted widening of a grid would leave the
 * stored search space smaller than the one actually searched, and every multiplicity correction
 * computed from it would be wrong in the flattering direction.
 *
 * The append-only trigger backs this up at the storage layer, so even a repository bug cannot rewrite a
 * registration — the write would raise rather than succeed.
 */
export class PostgresScalpResearchStudyRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async register(definition: StudyDefinition): Promise<StudyRegistrationResult> {
    assertStudyRegistrable(definition);
    const hash = studyDefinitionHash(definition);

    const inserted = await this.database.query<{ registered_at: Date }>(`
      INSERT INTO research_scalp.study_registrations (
        study_key, study_definition_hash, question, provenance, provenance_note,
        specification, registry_encoding_version
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (study_key) DO NOTHING
      RETURNING registered_at
    `, [
      definition.studyKey,
      hash,
      definition.question,
      definition.provenance,
      definition.provenanceNote,
      JSON.stringify(definition.specification),
      studyRegistryEncodingVersion,
    ]);

    const registeredAt = inserted.rows[0]?.registered_at;
    if (registeredAt) {
      return { studyKey: definition.studyKey, studyDefinitionHash: hash, outcome: "REGISTERED", registeredAt };
    }

    const existing = await this.database.query<{ study_definition_hash: string; registered_at: Date }>(`
      SELECT study_definition_hash, registered_at
      FROM research_scalp.study_registrations
      WHERE study_key = $1
    `, [definition.studyKey]);
    const stored = existing.rows[0];
    if (!stored) {
      // No row inserted and no row present: the only way here is a concurrent delete, which the
      // append-only trigger forbids. Reported rather than retried, because a silent retry would hide a
      // broken invariant.
      throw new Error(
        `${definition.studyKey} was neither inserted nor found. The append-only guarantee on `
        + "research_scalp.study_registrations is not holding; investigate before registering anything.",
      );
    }
    if (stored.study_definition_hash !== hash) {
      throw new Error(
        `${definition.studyKey} is already registered with a different definition (stored `
        + `${stored.study_definition_hash.slice(0, 12)}…, incoming ${hash.slice(0, 12)}…, registered `
        + `${stored.registered_at.toISOString()}). A registered study is immutable: the specification `
        + "that ran is the specification the multiplicity correction counts. Register the change as a "
        + "new versioned key instead of editing this one.",
      );
    }
    return {
      studyKey: definition.studyKey,
      studyDefinitionHash: hash,
      outcome: "ALREADY_REGISTERED",
      registeredAt: stored.registered_at,
    };
  }

  async listRegistered(): Promise<RegisteredStudyRow[]> {
    const result = await this.database.query<{
      study_key: string; study_definition_hash: string; provenance: string; registered_at: Date;
    }>(`
      SELECT study_key, study_definition_hash, provenance, registered_at
      FROM research_scalp.study_registrations
      ORDER BY registered_at ASC, study_key ASC
    `);
    return result.rows.map((row) => ({
      studyKey: row.study_key,
      studyDefinitionHash: row.study_definition_hash,
      provenance: row.provenance,
      registeredAt: row.registered_at,
    }));
  }
}
