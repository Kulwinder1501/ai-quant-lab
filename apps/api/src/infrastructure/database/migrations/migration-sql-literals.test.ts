import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No migration may contain a backtick inside its SQL template literal.
 *
 * A backtick terminates the template, so the SQL after it is parsed as TypeScript. The failure is
 * loud — `tsc` reports `TS1005: ',' expected` several lines later — but it is easy to reintroduce and
 * gives no hint of the cause: the natural instinct when documenting SQL is to quote an identifier the
 * way every docblock in this codebase does.
 *
 * Written after doing it twice in one day, in migrations 093 and 095, both times while writing a
 * comment *about* the SQL rather than the SQL itself.
 */

const MIGRATIONS = resolve(process.cwd(), "src", "infrastructure", "database", "migrations");

/**
 * The intended SQL region: everything between `sql: \`` and the closing `` \`, `` delimiter.
 *
 * Bounded on the **closing** delimiter rather than the next backtick, which is the whole point. A
 * detector that sliced at the first backtick would treat an offending one as the terminator and
 * therefore never see it -- the first version of this file did exactly that, and its own self-check
 * caught it.
 */
function sqlLiteral(source: string): string | null {
  const start = source.indexOf("sql: `");
  if (start === -1) return null;
  const body = source.slice(start + "sql: `".length);
  const end = body.lastIndexOf("`,");
  return end === -1 ? null : body.slice(0, end);
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => /^\d{3}-.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => join(MIGRATIONS, name));
}

describe("migration SQL literals", () => {
  it("walks real migration files, so a pass cannot come from an empty list", () => {
    // Guards the guard: every assertion below is a negative, and a negative over nothing passes.
    const files = migrationFiles();

    expect(files.length).toBeGreaterThan(90);
    expect(files.some((file) => file.endsWith("095-differential-classifications.ts"))).toBe(true);
  });

  it("has no backtick inside any SQL body", () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const sql = sqlLiteral(readFileSync(file, "utf8"));
      if (sql === null) continue;
      if (sql.includes("`")) offenders.push(file.slice(MIGRATIONS.length + 1));
    }

    expect(
      offenders,
      "a backtick inside the sql template ends the literal, and the SQL after it is parsed as "
      + `TypeScript: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("detects a backtick when one is present, rather than passing by construction", () => {
    /*
     * The regexes and the slicing are only worth anything if they match. Checked against a synthetic
     * source rather than a real file, so the self-check cannot be broken by fixing a migration.
     */
    const withBacktick = "export const m = {\n  id: \"x\",\n  sql: `\n    -- names the `col` column\n  `,\n};";
    const withoutBacktick = "export const m = {\n  id: \"x\",\n  sql: `\n    SELECT 1;\n  `,\n};";

    expect(sqlLiteral(withBacktick)?.includes("`")).toBe(true);
    expect(sqlLiteral(withoutBacktick)?.includes("`")).toBe(false);
  });
});
